/**
 * HTTPS to gdmf.apple.com. It chains to "Apple Root CA", which isn't in Node's bundled CA list, so
 * Apple's root is fetched from apple.com, pinned by its SHA-256 fingerprint, and added to the
 * process's default CA list before any gdmf request.
 */
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { CONFIG } from "./config.js";
import { fetchOk } from "./http.js";

let trusted: Promise<void> | undefined;

/** Adds Apple's pinned root to the default CAs (once; a failed fetch is retried next call). */
export function trustAppleRoot(): Promise<void> {
  trusted ??= (async () => {
    const cert = new X509Certificate(Buffer.from(await (await fetchOk(CONFIG.apple_root_ca.url)).arrayBuffer()));
    if (cert.fingerprint256.toUpperCase() !== CONFIG.apple_root_ca.sha256.toUpperCase()) {
      throw new Error("Apple Root CA fingerprint mismatch");
    }
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), cert.toString()]);
  })().catch((e) => {
    trusted = undefined;
    throw e;
  });
  return trusted;
}

/** GET, or POST a JSON body; resolves with the body of a 2xx response. */
async function request(url: string, body?: unknown): Promise<string> {
  await trustAppleRoot();
  const init: RequestInit = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return (await fetchOk(url, init)).text();
}

export const gdmfJson = async (url: string): Promise<any> => JSON.parse(await request(url));

/**
 * Software updates Apple's OTA asset server offers `device` when it reports running `version`
 * (`build`). `board` (HWModelStr) is required for some devices. The response is a JWS; its payload
 * (middle part) holds the assets.
 */
export async function softwareUpdates(q: { audience: string; device: string; version: string; build: string; board?: string }): Promise<any[]> {
  const jws = await request(CONFIG.ota.url, {
    AssetAudience: q.audience, ClientVersion: 2, AssetType: "com.apple.MobileAsset.SoftwareUpdate",
    ProductType: q.device, ProductVersion: q.version, BuildVersion: q.build, ...(q.board ? { HWModelStr: q.board } : {}),
  });
  return JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")).Assets ?? [];
}
