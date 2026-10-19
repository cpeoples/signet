/** Inspect one IPSW (range requests only): metadata, device names, and TSS signing state. */
import { devicetreeName, devicetreeProduct, parseDeviceTree } from "./devicetree.js";
import { parsePlist, type IpswInfo } from "./feeds.js";
import { RemoteZip } from "./remotezip.js";
import { firmwareSpecs } from "./specs.js";
import { buildTssRequest, pickIdentity, stateFor, tssStatus } from "./tss.js";
import { errorMessage, productClass } from "./util.js";

export interface Result { state: string; url: string; info: IpswInfo; msg: string }

/** Restore IPSWs keep BuildManifest and Restore.plist at the root; full OTA .zips under AssetData/boot/. */
export const firmwareRoot = (zip: RemoteZip) =>
  !zip.has("BuildManifest.plist") && zip.has("AssetData/boot/BuildManifest.plist") ? "AssetData/boot/" : "";

/** Feeds whose version, build and devices come from the firmware itself (no trusted feed metadata). */
const SELF_DESCRIBING = new Set(["url", "appledb", "ota"]);

export async function inspect(url: string, info: IpswInfo, wantNames: boolean, wantTss: boolean): Promise<Result> {
  try {
    if (!/^https?:\/\//.test(url)) throw new Error(`unsupported URL scheme (not downloadable): ${url.split(":")[0]}://`);
    const zip = await RemoteZip.open(url);
    if (zip.size) info.size = zip.size;
    const root = firmwareRoot(zip);
    const plistAt = async (name: string) => (zip.has(root + name) ? parsePlist(await zip.read(root + name)) : undefined);
    const manifest = await plistAt("BuildManifest.plist");
    const restore = await plistAt("Restore.plist");

    if (SELF_DESCRIBING.has(info.feed)) {
      info.version = manifest?.ProductVersion ?? restore?.ProductVersion ?? "?";
      info.build = manifest?.ProductBuildVersion ?? restore?.ProductBuildVersion ?? "?";
      info.products = new Set(manifest?.SupportedProductTypes ?? restore?.SupportedProductTypes ?? []);
    }

    // Device class = ProductType family ("iPhone16,2" -> "iPhone"). Restore.plist's DeviceClass isn't
    // reliable (missing in newer IPSWs; some iPad, iPod and Apple TV IPSWs say "iPhone"), so it's not used.
    const boards: string[] = (restore?.DeviceMap ?? []).map((d: any) => d.BoardConfig).filter(Boolean);
    for (const p of info.products) {
      const family = productClass(p);
      if (family) info.deviceClass[p] = family;
      if (info.products.size === 1 && boards.length === 1) info.board[p] = boards[0];
    }
    // Platform (iphoneos, macosx, appletvos, ...) from the manifest's build identities.
    for (const bi of manifest?.BuildIdentities ?? []) {
      const plat = bi["Ap,SDKPlatform"];
      if (!plat) continue;
      const pt = bi["Ap,ProductType"];
      for (const p of pt ? [pt] : info.products) if (info.products.has(p)) info.platform[p] ??= plat;
    }

    if (wantNames && manifest) {
      const identities: any[] = manifest.BuildIdentities ?? [];
      const treeOf = (bi: any): string | undefined => bi.Manifest?.DeviceTree?.Info?.Path;
      const paths = new Set(identities.map(treeOf).filter((p): p is string => !!p));
      for (const p of [...paths].sort()) {
        try {
          const nodes = parseDeviceTree(await zip.read(root + p));
          // The identity that uses this DeviceTree (prefer the erase install) has the chip and components.
          const identity = pickIdentity({ BuildIdentities: identities.filter((bi) => treeOf(bi) === p) });
          const pt = devicetreeProduct(nodes);
          if (pt && info.products.has(pt)) info.specs[pt] ??= firmwareSpecs(nodes, identity);
          const name = devicetreeName(nodes);
          if (pt && name) {
            info.names[pt] = name;
            info.nameSource[pt] = "devicetree";
            const board = /DeviceTree\.([a-z0-9]+)\./i.exec(p)?.[1];
            if (board) info.board[pt] = board;
          }
        } catch { /* IMG3 (encrypted, pre-2014) trees can't be read */ }
      }
    }

    if (!wantTss) return { state: "OK", url, info, msg: "" };
    if (!manifest) return { state: "UNKNOWN", url, info, msg: "no BuildManifest.plist (pre-iOS 3 firmware)" };
    const identity = pickIdentity(manifest);
    if (!identity) return { state: "ERROR", url, info, msg: "no BuildIdentities" };
    const { status, message } = await tssStatus(buildTssRequest(identity));
    return { state: stateFor(status), url, info, msg: message ?? "" };
  } catch (e) {
    return { state: "ERROR", url, info, msg: errorMessage(e) };
  }
}
