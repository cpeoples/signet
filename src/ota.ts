/**
 * First-party OTA discovery via Apple's asset server (gdmf.apple.com/v2/assets).
 *
 * Some devices (Apple TV 4K, ...) have no restore IPSW feed, but Apple's OTA server returns full
 * (non-delta) updates for them. Unencrypted .zip updates contain AssetData/boot/BuildManifest.plist,
 * which is all the TSS check needs. Encrypted .aea updates are read later, from the asset list that
 * carries their keys (see inspectOtaUpdates in cli.ts).
 */
import { Boards } from "./boards.js";
import { CONFIG } from "./config.js";
import type { DateIndex } from "./dates.js";
import { emptyInfo, type IpswInfo } from "./feeds.js";
import { softwareUpdates } from "./gdmf.js";
import { errorMessage } from "./util.js";

/**
 * Full, unencrypted OTA updates for every gdmf device of the configured prefixes not in `known`.
 * `firmwareFor(dev)`: Apple-hosted firmware URLs for a device (any version). Used only to read the
 * board from its BuildManifest when no other first-party source knows it (e.g. on Linux).
 */
export async function discoverOta(dates: DateIndex, known: Set<string>, deviceFilter: string | undefined,
  firmwareFor: (dev: string) => string[]) {
  const out = new Map<string, IpswInfo>();
  let skippedEncrypted = 0, noBoard = 0, fromFirmware = 0;
  const needsBoard = (dev: string) => CONFIG.ota.needs_board.some((p) => dev.startsWith(p));
  const boards = Object.keys(CONFIG.ota.audiences).some((p) => CONFIG.ota.needs_board.includes(p)) ? await Boards.load() : null;

  for (const [prefix, audience] of Object.entries(CONFIG.ota.audiences)) {
    const [version, build] = CONFIG.ota.from[prefix] ?? [CONFIG.ota.from_version, CONFIG.ota.from_build];
    for (const device of dates.devicesFor(prefix)) {
      if (known.has(device) || (deviceFilter && !device.includes(deviceFilter))) continue; // has an IPSW, or filtered out
      const query = (board?: string) => softwareUpdates({ audience, device, version, build, board });
      let assets: any[] = [];
      try {
        if (needsBoard(device)) {
          // Apple only answers for the exact board; try first-party candidates, remember the match.
          let cands = boards?.for(device) ?? [];
          if (!cands.length && boards && await boards.learnFromFirmware(device, firmwareFor(device))) {
            cands = boards.for(device);
            fromFirmware++;
          }
          if (!cands.length) { noBoard++; continue; }
          for (const hw of cands) {
            assets = await query(hw);
            if (assets.length) { boards!.confirm(device, hw); break; }
          }
        } else {
          assets = await query();
        }
      } catch (e) {
        console.error(`warning: OTA ${device}: ${errorMessage(e)}`);
        continue;
      }
      for (const a of assets) {
        if (a.PrerequisiteBuild || !a.__BaseURL || !a.__RelativePath) continue; // deltas need a base build
        if (!(a.SupportedDevices ?? []).includes(device)) continue;
        const url = a.__BaseURL + a.__RelativePath;
        if (!url.endsWith(".zip")) { skippedEncrypted++; continue; }
        if (!out.has(url)) out.set(url, emptyInfo("ota"));
      }
    }
  }
  boards?.save();
  return { found: out, skippedEncrypted, noBoard, fromFirmware };
}
