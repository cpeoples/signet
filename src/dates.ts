/**
 * Release and MDM dates from Apple's software-update feed (gdmf.apple.com/v2/pmv).
 *
 * ExpirationDate is the MDM deferral window, not the TSS signing end date (e.g. iOS 27.0 24A437
 * was already unsigned while gdmf still listed it until 2027-01-11).
 */
import { CONFIG } from "./config.js";
import { gdmfJson } from "./gdmf.js";
import { naturalCompare, PRODUCT_TYPE } from "./util.js";

export interface BuildDates {
  released: string | null;    // earliest PostingDate Apple lists for this build
  mdm_expires: string | null; // latest ExpirationDate (MDM availability, not signing)
  source: "gdmf.apple.com";
}

/** Lookup keyed by "build|device" where device is a ProductType or board (lower-cased). */
export class DateIndex {
  private map = new Map<string, { posted: string[]; expires: string[] }>();
  /** Newest gdmf entry per ProductType-looking device ("RealityDevice14,1"), with its platform. */
  private newest = new Map<string, { platform: string; version: string; build: string }>();

  static async load(): Promise<DateIndex> {
    const pmv = await gdmfJson(CONFIG.gdmf_url);
    const idx = new DateIndex();
    for (const set of ["PublicAssetSets", "AssetSets"]) {
      for (const [platform, entries] of Object.entries<any[]>(pmv[set] ?? {})) {
        for (const e of entries) {
          for (const dev of e.SupportedDevices ?? []) {
            const k = `${e.Build}|${String(dev).toLowerCase()}`;
            const v = idx.map.get(k) ?? { posted: [], expires: [] };
            if (e.PostingDate) v.posted.push(e.PostingDate);
            if (e.ExpirationDate) v.expires.push(e.ExpirationDate);
            idx.map.set(k, v);
            if (PRODUCT_TYPE.test(dev)) {
              const cur = idx.newest.get(dev);
              if (!cur || naturalCompare(e.ProductVersion, cur.version) > 0) {
                idx.newest.set(dev, { platform, version: e.ProductVersion, build: e.Build });
              }
            }
          }
        }
      }
    }
    return idx;
  }

  /** Devices Apple lists in gdmf that aren't in the IPSW feeds (e.g. Vision Pro): OTA-only. */
  otaOnly(known: Set<string>) {
    return [...this.newest.entries()].filter(([d]) => !known.has(d)).map(([identifier, v]) => ({ identifier, ...v }));
  }

  /** Every device identifier ("AppleTV11,1") Apple lists in gdmf that starts with `prefix`. */
  devicesFor(prefix: string): string[] {
    return [...this.newest.keys()].filter((d) => d.startsWith(prefix)).sort();
  }

  /** Every build Apple lists for devices whose identifier starts with `prefix` ("Watch"). */
  buildsFor(prefix: string): string[] {
    const out = new Set<string>();
    const p = prefix.toLowerCase();
    for (const k of this.map.keys()) {
      const [build, dev] = k.split("|");
      if (dev.startsWith(p) && /\d+,\d+$/.test(dev)) out.add(build);
    }
    return [...out].sort();
  }

  /** Dates for a build on any of the given device identifiers or boards. */
  lookup(build: string, devices: (string | null | undefined)[]): BuildDates | null {
    const posted: string[] = [], expires: string[] = [];
    for (const d of devices) {
      if (!d) continue;
      const v = this.map.get(`${build}|${d.toLowerCase()}`);
      if (v) { posted.push(...v.posted); expires.push(...v.expires); }
    }
    if (!posted.length && !expires.length) return null;
    return {
      released: posted.sort()[0] ?? null,
      mdm_expires: expires.sort().at(-1) ?? null,
      source: "gdmf.apple.com",
    };
  }
}
