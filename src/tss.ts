/** Apple TSS (gs.apple.com) signing check. */
import { randomBytes, randomUUID } from "node:crypto";
import * as plist from "plist";
import { CONFIG } from "./config.js";
import { fetchRetry } from "./retry.js";

type Dict = Record<string, any>;

export function pickIdentity(manifest: Dict): Dict | undefined {
  const ids: Dict[] = manifest.BuildIdentities ?? [];
  return ids.find((i) => i.Info?.RestoreBehavior === "Erase") ?? ids[0];
}

const toInt = (v: string | number) => (typeof v === "string" ? parseInt(v, 16) : v);

/** Firmware for a chip other than the AP: Baseband, Cellular1,* (C1 modem), Wireless1,*, Timer,*. */
const isCoprocessor = (name: string) =>
  name.includes("Baseband") || (name.includes(",") && !name.startsWith("Ap,"));

const ecidAndHeader = () => {
  // Random 52-bit ECID (fits in a JS safe integer: 20 high bits * 2^32 + 32 low bits).
  const rb = randomBytes(8);
  return {
    "@HostPlatformInfo": "mac",
    "@VersionInfo": "libauthinstall-1033.0.2",
    "@UUID": randomUUID().toUpperCase(),
    ApECID: (rb.readUInt32BE(0) & 0xfffff) * 2 ** 32 + rb.readUInt32BE(4),
  };
};

/** 32-bit S5L87xx/89xx chips (iPod touch 2nd gen to A6X, 0x8720-0x8955) sign IMG3 firmware with an APTicket. */
const isImg3 = (chip: number) => chip >= 0x8700 && chip < 0x8960;

function img3Request(identity: Dict, chip: number): Dict {
  const req: Dict = {
    ...ecidAndHeader(),
    "@APTicket": true,
    ApBoardID: toInt(identity.ApBoardID),
    ApChipID: chip,
    ApSecurityDomain: toInt(identity.ApSecurityDomain ?? "0x01"),
    ApNonce: randomBytes(20),
    ApProductionMode: true,
  };
  if (identity.UniqueBuildID) req.UniqueBuildID = identity.UniqueBuildID;
  for (const [name, comp] of Object.entries<Dict>(identity.Manifest ?? {})) {
    if (isCoprocessor(name) || !("Digest" in comp || "PartialDigest" in comp)) continue;
    const entry: Dict = {};
    for (const k of ["Digest", "PartialDigest", "Trusted", "BuildString"]) if (k in comp) entry[k] = comp[k];
    req[name] = entry;
  }
  return req;
}

export function buildTssRequest(identity: Dict): Dict {
  const chip = toInt(identity.ApChipID);
  if (isImg3(chip)) return img3Request(identity, chip);
  // A12 and later (0x8020+) use a 32-byte ApNonce, except the A7 (0x8960), which answers STATUS=128
  // to one and needs 20 bytes like the A8-A11.
  const nonceLen = chip >= 0x8020 && chip !== 0x8960 ? 32 : 20;

  const req: Dict = {
    ...ecidAndHeader(),
    "@ApImg4Ticket": true,
    ApBoardID: toInt(identity.ApBoardID),
    ApChipID: chip,
    ApSecurityDomain: toInt(identity.ApSecurityDomain ?? "0x01"),
    ApNonce: randomBytes(nonceLen),
    SepNonce: randomBytes(20),
    ApProductionMode: true,
    ApSecurityMode: true,
    // No "ApSupportsImg4": gs.apple.com answers STATUS=8 if it's present.
    UniqueBuildID: identity.UniqueBuildID,
  };

  for (const [name, comp] of Object.entries<Dict>(identity.Manifest ?? {})) {
    // Only AP-signed components ("Trusted" key). Other chips' entries need their own request
    // fields: without them Cryptex1, Savage, Yonkers, ... get STATUS=8, and Cellular1,*,
    // Wireless1,* and Timer,* get STATUS=94 even for signed builds.
    if (!("Digest" in comp) || !("Trusted" in comp) || isCoprocessor(name)) continue;
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
