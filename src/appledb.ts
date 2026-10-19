/**
 * THIRD-PARTY URL discovery (api.appledb.dev) for builds Apple lists in gdmf but publishes no
 * IPSW feed for (watchOS full restores, ...).
 *
 * AppleDB is used ONLY to learn the download URL. Which builds to look up comes from Apple's gdmf;
 * accepted links must be Restore.ipsw files on an Apple host; version, build and devices are then read
 * from the IPSW's BuildManifest, names from its DeviceTree, and signing from Apple's TSS server.
 * AppleDB's own "signed", device and version fields are ignored.
 */
import { CONFIG, ua } from "./config.js";
import type { DateIndex } from "./dates.js";
import { emptyInfo, type IpswInfo } from "./feeds.js";
import { fetchRetry } from "./http.js";
import { errorMessage } from "./util.js";

/** Apple-hosted HTTPS URL whose path ends with `suffix` ("Restore.ipsw", ".zip"), else null. */
function appleUrl(raw: unknown, suffix = "Restore.ipsw"): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !CONFIG.appledb.allowed_hosts.includes(u.hostname)) return null;
    return u.pathname.endsWith(suffix) ? u.toString() : null;
  } catch { return null; }
}

const pick = (src: any, suffix?: string) => {
  const links: any[] = src.links ?? [];
  const usable = (l: any) => appleUrl(l.url, suffix) !== null;
  const l = links.find((x) => x.preferred && usable(x)) ?? links.find(usable);
  return l ? appleUrl(l.url, suffix) : null;
};

/** AppleDB keys for a gdmf build: "watchOS;24R365" plus split entries ("watchOS;24R365-S11"). */
async function keysFor(os: string, builds: string[]): Promise<string[]> {
  let index: string[] | null = null;
  try {
    const r = await fetchRetry(CONFIG.appledb.index_url.replace("{os}", encodeURIComponent(os)), { headers: ua() });
    if (r.ok) index = await r.json();
  } catch { /* fall back to exact keys */ }
  if (!index) return builds;
  const out: string[] = [];
  for (const b of builds) {
    for (const k of index) {
      const id = k.slice(os.length + 1); // strip "watchOS;"
      if (!k.startsWith(`${os};`) || !(id === b || id.startsWith(`${b}-`))) continue;
      if (/-(sim|SDK)\b/i.test(id)) continue; // simulator and SDK entries: no device IPSWs
      out.push(id);
    }
  }
  return out;
}

/** AppleDB's device list as a hint only (used to pick firmware for board lookup); inspect() replaces
 *  it with the SupportedProductTypes from the IPSW's own BuildManifest. */
function hinted(devs: string[]): IpswInfo {
  const info = emptyInfo("appledb");
  info.products = new Set(devs);
  return info;
}

/** IPSW URLs (Apple hosts only) for every gdmf build of the configured device families. */
export async function discoverViaAppleDb(dates: DateIndex, deviceFilter?: string): Promise<Map<string, IpswInfo>> {
  const out = new Map<string, IpswInfo>();
  const wanted = (devs: string[]) => !deviceFilter || devs.some((d) => d.includes(deviceFilter));
  for (const [prefix, os] of Object.entries(CONFIG.appledb.os_for_prefix)) {
    for (const build of await keysFor(os, dates.buildsFor(prefix))) {
      const url = CONFIG.appledb.url.replace("{os}", encodeURIComponent(os)).replace("{build}", encodeURIComponent(build));
      let doc: any;
      try {
        const r = await fetchRetry(url, { headers: ua() });
        if (r.status === 404) continue; // AppleDB doesn't know this build
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        doc = await r.json();
      } catch (e) {
        console.error(`warning: appledb ${os} ${build}: ${errorMessage(e)}`);
        continue;
      }
      // Restore IPSWs first; then, for devices this entry has no IPSW for, a full OTA (no prerequisite
      // build) .zip, which carries AssetData/boot/BuildManifest.plist. Encrypted .aea is skipped.
      const covered = new Set<string>();
      const sources: any[] = doc.sources ?? [];
      for (const src of sources) {
        if (src.type !== "ipsw") continue;
        const ipsw = pick(src);
        if (!ipsw) continue;
        const devs: string[] = src.deviceMap ?? [];
        for (const d of devs) covered.add(d);
        // Cheap pre-filter only; the real device list comes from the IPSW's BuildManifest.
        if (!wanted(devs)) continue;
        if (!out.has(ipsw)) out.set(ipsw, hinted(devs));
      }
      for (const src of sources) {
        if (src.type !== "ota" || src.prerequisiteBuild) continue;
        const devs: string[] = src.deviceMap ?? [];
        if (!devs.length || devs.every((d) => covered.has(d))) continue;
        if (!wanted(devs)) continue;
        const zip = pick(src, ".zip");
        if (!zip || out.has(zip)) continue;
        for (const d of devs) covered.add(d);
        out.set(zip, hinted(devs));
      }
    }
  }
  return out;
}
