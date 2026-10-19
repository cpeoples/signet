/** IPSW feeds (URLs come from config: iTunes and Finder version plist, mesu macOS IPSW feed, ...). */
import * as plist from "plist";
import { CONFIG, ua } from "./config.js";
import { fetchOk } from "./http.js";
import type { FirmwareSpecs } from "./specs.js";

export type NameSource = "devicetree" | "user";

export interface IpswInfo {
  feed: string;
  build: string;
  version: string;
  products: Set<string>;
  names: Record<string, string>;
  nameSource: Record<string, NameSource>;
  deviceClass: Record<string, string>;
  board: Record<string, string>;
  /** Ap,SDKPlatform from BuildManifest (iphoneos, macosx, appletvos, ...), per ProductType. */
  platform: Record<string, string>;
  /** Hardware facts read from the DeviceTree + BuildManifest, per ProductType. */
  specs: Record<string, FirmwareSpecs>;
  /** Download size in bytes (from the server's Content-Range while reading the IPSW). */
  size?: number;
  /** SHA-1 of the whole file, when Apple's feed publishes it (FirmwareSHA1). */
  sha1?: string;
  /** Encrypted OTA (.aea): the decryption key Apple's asset server returned with it. */
  aeaKey?: string;
}

export const emptyInfo = (feed: string, build = "?", version = "?"): IpswInfo => ({
  feed, build, version, products: new Set(), names: {}, nameSource: {}, deviceClass: {}, board: {}, platform: {}, specs: {},
});

/** Binary plists ("bplist00") appear in OTA zips; XML elsewhere. */
export const parsePlist = (b: Buffer): any => plist.parse(b.subarray(0, 6).toString("latin1") === "bplist" ? b : b.toString("utf8"));

export async function fetchPlist(url: string): Promise<any> {
  return plist.parse(await (await fetchOk(url, { headers: ua() })).text());
}

/** Yield [path, dict] for every dict carrying a FirmwareURL. */
function* walk(node: any, path: string[] = []): Generator<[string[], any]> {
  if (Array.isArray(node)) {
    for (const v of node) yield* walk(v, path);
  } else if (node && typeof node === "object" && !Buffer.isBuffer(node) && !(node instanceof Date)) {
    if ("FirmwareURL" in node) yield [path, node];
    for (const [k, v] of Object.entries(node)) yield* walk(v, [...path, k]);
  }
}

/** Every IPSW in the named CONFIG.feeds, keyed by URL. */
export async function collectIpsws(feeds: string[], deviceFilter?: string): Promise<Map<string, IpswInfo>> {
  const out = new Map<string, IpswInfo>();
  for (const name of feeds) {
    for (const [path, node] of walk(await fetchPlist(CONFIG.feeds[name]))) {
      const url: string = node.FirmwareURL;
      if (!url.endsWith(".ipsw")) continue;
      const i = path.indexOf("MobileDeviceSoftwareVersions");
      const product: string | undefined = i >= 0 ? path[i + 1] : undefined;
      if (deviceFilter && (!product || !product.includes(deviceFilter))) continue;
      let entry = out.get(url);
      if (!entry) {
        entry = emptyInfo(name, node.BuildVersion ?? path.at(-2) ?? "?", node.ProductVersion ?? "?");
        out.set(url, entry);
      }
      if (typeof node.FirmwareSHA1 === "string") entry.sha1 ??= node.FirmwareSHA1;
      if (product) entry.products.add(product);
    }
  }
  return out;
}
