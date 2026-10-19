/**
 * Every OTA update Apple's asset server (gdmf.apple.com/v2/assets) offers per device, including
 * encrypted .aea archives, listed with what's needed to use them later (URL, size, decryption key).
 *
 * Apple only answers for the exact board (HWModelStr), so boards come from, in order:
 *   1. the device's firmware (Restore.plist or DeviceTree of an inspected IPSW),
 *   2. first-party board sources (macOS CoreTypes, mesu catalogs, confirmed-board cache),
 *   3. AppleDB's device page, only as a candidate when 1-2 have none (unreleased devices).
 * A board counts only if Apple's server answers for it. When the default base build returns nothing
 * (brand-new devices only get a delta from their factory build), AppleDB's preinstalled builds are
 * tried as bases, again only as hints for Apple's server.
 */
import { Boards, otaBoard } from "./boards.js";
import { CONFIG, ua } from "./config.js";
import { softwareUpdates, trustAppleRoot } from "./gdmf.js";
import { fetchRetry, HttpError } from "./http.js";
import { byPrefix, errorMessage, pool } from "./util.js";

/** Parallel asset queries, whatever --jobs says: gdmf is one server, not a CDN. */
const MAX_PARALLEL = 8;

export interface OtaAsset {
  url: string;
  version: string | null;
  build: string | null;
  /** null = full update (installs from any build); otherwise the build this delta applies to. */
  prerequisite_build: string | null;
  type: "full" | "delta";
  /** .aea (Apple Encrypted Archive); needs decryption_key to open. */
  encrypted: boolean;
  size_bytes: number | null;
  /** Base64 AEA key Apple returns with the asset. */
  decryption_key: string | null;
  board: string;
  /** Where the board or base-build hint came from; the asset itself is always Apple's answer.
   *  "apple-confirmed" = a board Apple's server accepted before (CoreTypes, mesu, or the board cache). */
  hint_source: "firmware" | "apple-confirmed" | "appledb (third-party)";
}

const asset = (a: any, board: string, hint: OtaAsset["hint_source"]): OtaAsset | null => {
  if (!a.__BaseURL || !a.__RelativePath) return null;
  const url = a.__BaseURL + a.__RelativePath;
  return {
    url,
    version: a.OSVersion ? String(a.OSVersion).replace(/^9\.9\./, "") : null, // "9.9.27.0" -> "27.0"
    build: a.Build ?? null,
    prerequisite_build: a.PrerequisiteBuild ?? null,
    type: a.PrerequisiteBuild ? "delta" : "full",
    encrypted: url.endsWith(".aea"),
    size_bytes: a._DownloadSize ?? null,
    decryption_key: a.ArchiveDecryptionKey ?? null,
    board,
    hint_source: hint,
  };
};

/** AppleDB identifiers not in `known`, for the families Apple's asset server covers. */
export async function appledbNewDevices(known: Set<string>): Promise<string[]> {
  if (!CONFIG.appledb.enabled || !CONFIG.ota_assets.appledb_hints) return [];
  try {
    const r = await fetchRetry(CONFIG.ota_assets.appledb_devices_url, { headers: ua() });
    if (!r.ok) return [];
    const list: any[] = await r.json();
    // Only devices with a recent or upcoming release date: older ones Apple would already list, and
    // undated entries are prototypes Apple's server never answers for.
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const out = new Set<string>();
    for (const d of list) {
      const released = ([] as unknown[]).concat(d.released ?? []).filter((x): x is string => typeof x === "string").sort().at(-1);
      if (!released || released < since) continue;
      for (const id of d.identifier ?? []) {
        if (typeof id === "string" && /^[A-Za-z]+\d+,\d+$/.test(id) && !known.has(id) && byPrefix(CONFIG.ota_assets.audiences, id)) out.add(id);
      }
    }
    return [...out].sort();
  } catch (e) {
    console.error(`warning: AppleDB device list: ${errorMessage(e)}`);
    return [];
  }
}

/** AppleDB device page: boards + factory (preinstalled) builds. Hints only. */
async function appledbHints(dev: string): Promise<{ boards: string[]; bases: [string, string][] }> {
  try {
    const r = await fetchRetry(CONFIG.ota_assets.appledb_device_url.replace("{id}", encodeURIComponent(dev)), { headers: ua() });
    if (!r.ok) return { boards: [], bases: [] };
    const fm = (await r.json()).frontmatter ?? {};
    const boards: string[] = (fm.device ?? []).flatMap((d: any) => d.board ?? []);
    const bases: [string, string][] = (fm.versionArr ?? [])
      .filter((v: any) => (v.preinstalled ?? []).includes(dev) && v.version && v.build)
      .map((v: any) => [v.version, v.build]);
    return { boards: [...new Set(boards.map((b) => otaBoard(b) ?? b))], bases };
  } catch {
    return { boards: [], bases: [] };
  }
}

/**
 * `devices`: identifier -> board read from its firmware (lowercase "d93ap"), if any.
 * Returns identifier -> assets (empty list = Apple offered nothing for any known board).
 */
export async function listOtaAssets(devices: Map<string, string | undefined>, jobs: number) {
  await trustAppleRoot(); // fail the whole step up front, not once per device
  const boards = await Boards.load();
  const out = new Map<string, OtaAsset[]>();
  const todo = [...devices].flatMap(([device, fwBoard]) => {
    const match = byPrefix(CONFIG.ota_assets.audiences, device);
    return match ? [{ device, fwBoard, prefix: match[0], audience: match[1] }] : [];
  });

  await pool(todo, Math.min(jobs, MAX_PARALLEL), "OTA assets ", async ({ device, fwBoard, prefix, audience }) => {
    const base: [string, string] = CONFIG.ota_assets.from[prefix] ?? [CONFIG.ota.from_version, CONFIG.ota.from_build];
    const query = (board: string, [version, build]: [string, string]) => softwareUpdates({ audience, device, version, build, board });
    const cands: [string, OtaAsset["hint_source"]][] = [];
    const fw = fwBoard ? otaBoard(fwBoard) : undefined;
    if (fw) cands.push([fw, "firmware"]);
    for (const b of boards.for(device)) if (!cands.some(([c]) => c === b)) cands.push([b, "apple-confirmed"]);

    const found: OtaAsset[] = [];
    const collect = (as: any[], hw: string, hint: OtaAsset["hint_source"]) => {
      for (const a of as) {
        if (!(a.SupportedDevices ?? [device]).includes(device)) continue;
        const x = asset(a, hw, hint);
        if (x && !found.some((f) => f.url === x.url)) found.push(x);
      }
    };
    try {
      for (const [hw, hint] of cands) {
        for (const from of [base, ...CONFIG.ota_assets.fallback_from]) {
          collect(await query(hw, from), hw, hint);
          if (found.length) break; // older bases only for devices the default base is too new for
        }
        if (found.length) { boards.confirm(device, hw); break; }
      }
      // Nothing yet (unreleased or new device, or no board known): AppleDB hints, checked against Apple.
      if (!found.length && CONFIG.appledb.enabled && CONFIG.ota_assets.appledb_hints) {
        const h = await appledbHints(device);
        const hws = [...cands.map(([c]) => c), ...h.boards.filter((b) => !cands.some(([c]) => c === b))];
        for (const hw of hws) {
          const hint = cands.find(([c]) => c === hw)?.[1] ?? "appledb (third-party)";
          for (const from of [base, ...h.bases]) collect(await query(hw, from), hw, hint);
          if (found.length) { boards.confirm(device, hw); break; }
        }
      }
    } catch (e) {
      // HTTP 400: Apple's server doesn't know the device at all (first-gen Apple TV, ...).
      if (!(e instanceof HttpError && e.status === 400)) console.error(`\nwarning: OTA assets ${device}: ${errorMessage(e)}`);
    }
    out.set(device, found.sort((a, b) => (a.type === b.type ? 0 : a.type === "full" ? -1 : 1)));
  });
  boards.save();
  return out;
}
