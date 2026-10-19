/** Apple TSS (gs.apple.com) signing check. */
import { randomBytes, randomUUID } from "node:crypto";
import * as plist from "plist";
import { CONFIG } from "./config.js";
import { fetchRetry } from "./http.js";

type Dict = Record<string, any>;

export function pickIdentity(manifest: Dict): Dict | undefined {
  const ids: Dict[] = manifest.BuildIdentities ?? [];
  return ids.find((i) => i.Info?.RestoreBehavior === "Erase") ?? ids[0];
}

const toInt = (v: string | number) => (typeof v === "string" ? parseInt(v, 16) : v);

export function buildTssRequest(identity: Dict): Dict {
  const chip = toInt(identity.ApChipID);
  const nonceLen = chip >= 0x8020 ? 32 : 20; // A12+ use 32-byte ApNonce
  // Random 52-bit ECID (fits in a JS safe integer: 20 high bits * 2^32 + 32 low bits).
  const rb = randomBytes(8);
  const ecid = (rb.readUInt32BE(0) & 0xfffff) * 2 ** 32 + rb.readUInt32BE(4);

  const req: Dict = {
    "@HostPlatformInfo": "mac",
    "@VersionInfo": "libauthinstall-1033.0.2",
    "@UUID": randomUUID().toUpperCase(),
    "@ApImg4Ticket": true,
    ApBoardID: toInt(identity.ApBoardID),
    ApChipID: chip,
    ApSecurityDomain: toInt(identity.ApSecurityDomain ?? "0x01"),
    ApECID: ecid,
    ApNonce: randomBytes(nonceLen),
    SepNonce: randomBytes(20),
    ApProductionMode: true,
    ApSecurityMode: true,
    // No "ApSupportsImg4": gs.apple.com answers STATUS=8 if it's present.
    UniqueBuildID: identity.UniqueBuildID,
  };

  for (const [name, comp] of Object.entries<Dict>(identity.Manifest ?? {})) {
    // Only AP-signed components ("Trusted" key). Co-processor entries (Cryptex1, Savage,
    // Yonkers, eUICC, SE, BMU, ...) need extra per-chip params and cause STATUS=8.
    if (!("Digest" in comp) || !("Trusted" in comp) || name.includes("Baseband")) continue;
    req[name] = { Digest: comp.Digest, Trusted: comp.Trusted, EPRO: true, ESEC: true };
  }
  return req;
}

export async function tssStatus(req: Dict): Promise<{ status?: string; message?: string }> {
  const r = await fetchRetry(CONFIG.tss_url, {
    method: "POST",
    headers: { "User-Agent": CONFIG.tss_user_agent, "Content-Type": 'text/xml; charset="utf-8"', "Cache-Control": "no-cache" },
    body: plist.build(req),
  });
  // Response: STATUS=0&MESSAGE=SUCCESS&REQUEST_STRING=<plist ...>
  const fields: Record<string, string> = {};
  for (const part of (await r.text()).split("&", 2)) {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { status: fields.STATUS, message: fields.MESSAGE };
}

/** 0 = signed; 69 = signed (no ticket for fake ECID); 94 = unsigned; anything else is not a verdict. */
const STATES = new Map([["0", "SIGNED"], ["69", "SIGNED*"], ["94", "UNSIGNED"]]);

export const stateFor = (status?: string) => STATES.get(status ?? "") ?? `STATUS=${status}`;
