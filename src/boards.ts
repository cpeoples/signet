/**
 * Board IDs (HWModelStr, e.g. "N157sAP") per device identifier, from Apple first-party sources only.
 * Apple's OTA server (gdmf /v2/assets) requires the exact, case-sensitive board for Apple Watch.
 *
 *  1. macOS CoreTypes (MobileDevices.bundle, what Finder uses for device names and icons): candidate
 *     boards per device family (up to 4). The OTA server only answers for the right one, so
 *     candidates are tried in turn and the match is cached.
 *  2. mesu Watch SoftwareUpdate catalog (any OS): SupportedDevices and SupportedDeviceModels pairs for
 *     older models.
 *  3. Firmware (any OS): the BuildManifest.plist of an Apple-hosted IPSW or OTA for the device names its
 *     board per build identity (Info.DeviceClass "n230ap" + Ap,ProductType). Read via range requests
 *     only for devices 1-2 can't resolve, so Linux needs no Mac and no prior run.
 *  4. Cache file (config ota.boards_cache, optional): boards Apple's OTA server confirmed on a previous
 *     run. Only skips repeat lookups; deleting it changes nothing but speed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as plist from "plist";
import { CONFIG } from "./config.js";
import { fetchPlist, parsePlist } from "./feeds.js";
import { firmwareRoot } from "./inspect.js";
import { RemoteZip } from "./remotezip.js";
import { errorMessage, naturalCompare, PRODUCT_TYPE, readCache, writeJson } from "./util.js";

/** Firmware spells boards in lowercase ("n207sap"); the OTA server wants "N207sAP". */
export function otaBoard(deviceClass: string): string | undefined {
  const m = /^([a-z])(\d+)([a-z]*?)ap$/i.exec(deviceClass);
  return m ? `${m[1].toUpperCase()}${m[2]}${m[3].toLowerCase()}AP` : undefined;
}

/** [ProductType, board] pairs from a BuildManifest's build identities. */
export function boardsFromManifest(manifest: any): [string, string][] {
  const supported: string[] = manifest?.SupportedProductTypes ?? [];
  const out = new Map<string, string>();
  for (const bi of manifest?.BuildIdentities ?? []) {
    const board = otaBoard(bi.Info?.DeviceClass ?? "");
    // Older manifests omit Ap,ProductType; only then is a single-device manifest unambiguous.
    const pt = bi["Ap,ProductType"] ?? (supported.length === 1 ? supported[0] : undefined);
    if (board && pt) out.set(`${pt}\0${board}`, pt);
  }
  return [...out.keys()].map((k) => k.split("\0") as [string, string]);
}

const CORETYPES = process.env.TSS_CORETYPES_PLIST
  ?? "/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle/Contents/Info.plist";
const BOARD = /^[A-Z]\d+[a-z]*AP$/;

export class Boards {
  private candidates = new Map<string, Set<string>>();
  private confirmed: Record<string, string> = {};

  private add(dev: string, board: string) {
    if (!PRODUCT_TYPE.test(dev) || !BOARD.test(board)) return;
    const s = this.candidates.get(dev) ?? new Set<string>();
    s.add(board);
    this.candidates.set(dev, s);
  }

  static async load(): Promise<Boards> {
    const b = new Boards();
    b.confirmed = readCache(CONFIG.ota.boards_cache) ?? {};
    // 1. macOS CoreTypes (binary plist; convert with plutil when available).
    if (existsSync(CORETYPES)) {
      try {
        const raw = readFileSync(CORETYPES);
        const doc: any = raw.subarray(0, 6).toString("latin1") === "bplist"
          ? JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", CORETYPES]).toString("utf8"))
          : plist.parse(raw.toString("utf8"));
        for (const t of doc.UTExportedTypeDeclarations ?? []) {
          const codes: string[] = [].concat(t.UTTypeTagSpecification?.["com.apple.device-model-code"] ?? []);
          const devs = codes.filter((c) => PRODUCT_TYPE.test(c)), boards = codes.filter((c) => BOARD.test(c));
          for (const d of devs) for (const bd of boards) b.add(d, bd);
        }
      } catch (e) {
        console.error(`warning: CoreTypes boards: ${errorMessage(e)}`);
      }
    }
    // 2. mesu catalogs that pair devices with boards.
    for (const url of CONFIG.ota.board_catalogs) {
      try {
        for (const a of (await fetchPlist(url)).Assets ?? []) {
          const devs: string[] = a.SupportedDevices ?? [], models: string[] = a.SupportedDeviceModels ?? [];
          if (devs.length === 1) for (const m of models) b.add(devs[0], m);
        }
      } catch (e) {
        console.error(`warning: board catalog ${url}: ${errorMessage(e)}`);
      }
    }
    return b;
  }

  /** Confirmed board first (if any), then the remaining candidates. */
  for(dev: string): string[] {
    const c = this.confirmed[dev];
    const rest = [...(this.candidates.get(dev) ?? [])].filter((x) => x !== c);
    return c ? [c, ...rest] : rest;
  }

  /** Read boards from the firmware files (BuildManifest only, via range requests) until `dev` has one. */
  async learnFromFirmware(dev: string, urls: string[]): Promise<boolean> {
    for (const url of urls.slice(0, 3)) {
      try {
        const zip = await RemoteZip.open(url);
        const path = firmwareRoot(zip) + "BuildManifest.plist";
        if (!zip.has(path)) continue;
        for (const [pt, board] of boardsFromManifest(parsePlist(await zip.read(path)))) this.add(pt, board);
        if (this.candidates.has(dev)) return true;
      } catch (e) {
        console.error(`warning: board from firmware ${url}: ${errorMessage(e)}`);
      }
    }
    return false;
  }

  confirm(dev: string, board: string) { this.confirmed[dev] = board; }

  save() {
    const cache = CONFIG.ota.boards_cache;
    if (!cache) return;
    writeJson(cache, Object.fromEntries(Object.entries(this.confirmed).sort(([a], [b]) => naturalCompare(a, b))));
  }
}
