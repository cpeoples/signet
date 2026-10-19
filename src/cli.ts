#!/usr/bin/env node
/**
 * Check Apple signing status for every firmware in Apple's own feeds, using Apple's TSS server.
 * Sources: Apple's IPSW feeds and OTA server (gdmf) -> BuildManifest.plist, Restore.plist and
 * DeviceTree read from the firmware via HTTP ranges (no full download) -> gs.apple.com TSS.
 * Third-party exceptions, each limited and labelled in the output: AppleDB (Apple-hosted URLs for
 * gdmf builds with no Apple IPSW feed, and board hints) and Wikimedia Commons (chip photos).
 *
 *   signet                                    every IPSW in Apple's feeds, grouped by signing state
 *   signet --list-devices                     one row per device: name, latest build, signing state
 *   signet --list-devices --json              same, as JSON
 *   signet --feed ios --device iPhone16,2
 *   signet --url <IPSW URL>
 */
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { parseArgs } from "node:util";
import { discoverViaAppleDb } from "./appledb.js";
import { chipImages, chipName, type ChipImage } from "./chipimages.js";
import { CONFIG, DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";
import { DateIndex } from "./dates.js";
import { decryptCli } from "./decrypt.js";
import { collectIpsws, emptyInfo, type IpswInfo, type NameSource } from "./feeds.js";
import { History } from "./history.js";
import { inspect, type Result } from "./inspect.js";
import { discoverOta } from "./ota.js";
import { appledbNewDevices, listOtaAssets, type OtaAsset } from "./otaassets.js";
import { serve } from "./serve.js";
import type { FirmwareSpecs } from "./specs.js";
import { TechSpecsLookup, productTitle, summarize, type TechSpecs } from "./techspecs.js";
import { byPrefix, errorMessage, pool, productClass } from "./util.js";

const USAGE = `Usage: signet [--feed NAME|all] [--device SUBSTR] [--url IPSW_URL ...]
                   [--list-devices] [--json] [--no-names] [--no-tss] [--names FILE.json] [--jobs N]
                   [--config FILE] [--print-config]
       signet serve [--port 8787] [--host 127.0.0.1] [--refresh MINUTES] [pipeline flags]
                   live HTTP data service (in memory, no files): /health, /api/site, /api/signing,
                   /api/report. Re-checks Apple every --refresh minutes (0 = once).

  --feed NAME      a feed from the config ("ios", "macos", "visionos", "bridgeos" by default),
                   "appledb" (only the AppleDB-discovered URLs), "ota" (Apple OTA full updates), or "all"
  --no-appledb     don't use AppleDB URL discovery even if enabled in the config
  --no-ota         don't query Apple's OTA server (gdmf.apple.com/v2/assets)
  --config FILE    endpoints and tunables (default: ./${DEFAULT_CONFIG_FILE} if present)
  --print-config   print the effective config as JSON and exit
  --list-devices   one row per device (identifier, name, latest build in Apple's feed, signing)
  --json           machine-readable output
  --no-names       skip reading device names from DeviceTrees (faster)
  --no-tss         --list-devices only: skip signing checks
  --names FILE     your own {"iPhone5,1": "iPhone 5", ...} for devices Apple's firmware can't name
                   (pre-2014 devices: encrypted DeviceTree). Marked name_source "user".
  --no-dates       skip release and MDM dates from gdmf.apple.com
  --tech-specs     add Apple Tech Specs (support.apple.com, scraped): retail specs + product image
                   URLs per device, matched by firmware name. Cached in apple-techspecs.json.
  --no-tech-specs  skip them even if enabled in the config
  --no-chip-images skip chip photos (Wikimedia Commons, credited; third-party, picture only)
  --no-ota-assets  skip listing every OTA update (full and delta, encrypted .aea with its decryption key)
                   that Apple's gdmf server offers per device (ota_assets in JSON)
  --history FILE   record signing observations; output gains signing_window (first and last seen
                   signed, when unsigned was detected). Run on a schedule to capture end dates.`;

// Optional enrichments, filled in main() when enabled.
let DATES: DateIndex | null = null;
let HISTORY: History | null = null;
/** identifier -> Apple Tech Specs (null = looked up, no page). */
const TECH_SPECS = new Map<string, TechSpecs | null>();
/** identifier -> every OTA update Apple offers (full and delta, .aea included). */
const OTA_ASSETS = new Map<string, OtaAsset[]>();
/** chip name ("A18 Pro", "T2") -> Commons photo. */
const CHIP_IMAGES = new Map<string, ChipImage>();
let DEVICE_FILTER: string | undefined;
let USED_APPLEDB = false;

async function runParallel(ipsws: Map<string, IpswInfo>, jobs: number, wantNames: boolean, wantTss: boolean) {
  const run = (entries: [string, IpswInfo][], n: number, label: string) =>
    pool(entries, n, label, ([url, info]) => inspect(url, info, wantNames, wantTss));

  const results = await run([...ipsws], jobs, "");
  // Second, gentler pass for transient failures (e.g. legacy CDN answering 501 under load).
  const failed = results.filter((r) => r.state === "ERROR" && !/unsupported URL scheme|no item named/.test(r.msg));
  if (!failed.length) return results;
  await new Promise((r) => setTimeout(r, 3000));
  const again = await run(failed.map((r) => [r.url, r.info]), 2, "retry ");
  const byUrl = new Map(again.map((r) => [r.url, r]));
  return results.map((r) => byUrl.get(r.url) ?? r);
}

const versionKey = (v: string) => v.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
const cmpVersion = (a: string, b: string) => {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const identKey = (id: string): [string, number, number] => {
  const m = /^([A-Za-z]+)(\d+),(\d+)/.exec(id);
  return m ? [m[1], Number(m[2]), Number(m[3])] : [id, 0, 0];
};
const cmpIdent = (a: string, b: string) => {
  const x = identKey(a), y = identKey(b);
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || x[2] - y[2];
};

/** Newest first; URL breaks ties so the order doesn't depend on which check finished first. */
const newestFirst = (x: Result, y: Result) => cmpVersion(y.info.version, x.info.version) || (x.url < y.url ? -1 : x.url > y.url ? 1 : 0);

/** Every [identifier, IpswInfo] pair across the results (an identifier repeats once per IPSW). */
function* devicesIn(results: Result[]): Generator<[string, IpswInfo]> {
  for (const { info } of results) for (const p of info.products) yield [p, info];
}

const signing = (state: string) =>
  state.startsWith("SIGNED") ? "signed" : state === "UNSIGNED" ? "unsigned" : "unknown";

/** Display name: real name, else "iPhone (board n41ap)" style generic label from Apple's files. */
function displayName(info: IpswInfo, p: string): string {
  if (info.names[p]) return info.names[p] + (info.nameSource[p] === "user" ? " †" : "");
  const cls = info.deviceClass[p], board = info.board[p];
  if (cls || board) return `[${[cls, board && `board ${board}`].filter(Boolean).join(", ")}]`;
  return "?";
}

const deviceJson = (info: IpswInfo, p: string) => {
  // Old firmware (iPod1-5, iPhone1-3, ...) carries no marketing name; Apple's own Tech Specs page does.
  const ts = TECH_SPECS.get(p);
  const name = info.names[p] && !(ts && /generation/i.test(ts.product) && productTitle(ts).startsWith(info.names[p]))
    ? info.names[p] : ts ? productTitle(ts) : null;
  return {
    identifier: p,
    name,
    name_source: name === (info.names[p] ?? null) ? info.nameSource[p] ?? null : name ? "techspecs" : null,
    device_class: info.deviceClass[p] ?? null,
    platform: info.platform[p] ?? null,
    board: info.board[p] ?? null,
  };
};

/** Per-device hardware details: firmware facts always, Apple Tech Specs when looked up. */
const specsJson = (info: IpswInfo, p: string) => {
  const out: Record<string, unknown> = {};
  if (info.specs[p]) out.firmware_specs = info.specs[p];
  if (TECH_SPECS.has(p)) {
    const t = TECH_SPECS.get(p);
    out.tech_specs = t
      ? { product: productTitle(t), year_introduced: t.year_introduced, ...summarize(t), url: t.url, source: "support.apple.com (scraped)" }
      : null;
    out.images = t?.images ?? [];
  }
  const chip = chipFor(p, info.names[p]);
  if (chip) out.chip = { name: chip, ...(CHIP_IMAGES.get(chip) ?? {}) };
  return out;
};

const tssJson = (r: Result) => ({
  signing: signing(r.state),
  tss_status: r.state,
  message: r.msg || null,
  explanation: EXPLAIN[r.state] ?? null,
});

const ipswJson = (r: Result) => ({
  url: r.url,
  version: r.info.version,
  build: r.info.build,
  size_bytes: r.info.size ?? null,
  sha1: r.info.sha1 ?? null,
  feed: r.info.feed,
  ...tssJson(r),
  ...extras(r, [...r.info.products, ...Object.values(r.info.board)]),
});

// Apple's MESSAGE is identical for 69 and 94 ("This device isn't eligible..."); the code decides.
const EXPLAIN: Record<string, string> = {
  "SIGNED": "TSS 0: signed, ticket issued",
  "SIGNED*": "TSS 69: build IS signed; Apple only refused a ticket for our synthetic ECID",
  "UNSIGNED": "TSS 94: Apple no longer signs this build",
};

/** Where an IPSW URL came from (everything else is read from the IPSW and Apple TSS). Feed names map to "apple". */
const URL_SOURCE: Record<string, string> = { appledb: "appledb (third-party)", url: "manual", ota: "apple (gdmf OTA)" };

const otaAssetsJson = (p: string) => (OTA_ASSETS.has(p) ? { ota_assets: OTA_ASSETS.get(p) } : {});

/**
 * A device's chip: Apple Tech Specs' chip line, else the device itself is a chip (iBridge = T2).
 * A page shared by two chips ("Mac mini (M6 or M5 Pro)") lists both, so the firmware name decides.
 */
function chipFor(p: string, name: string | undefined): string | null {
  const t = TECH_SPECS.get(p);
  const fromPage = t && ((/ or /.test(t.product) && chipName(name)) || chipName(summarize(t).chip?.[0]));
  return fromPage || (byPrefix(CONFIG.chip_images.for_prefix, p)?.[1] ?? null);
}

function extras(r: Result, devices: (string | undefined)[]) {
  const out: Record<string, unknown> = {};
  if (DATES) out.dates = DATES.lookup(r.info.build, devices);
  if (HISTORY) out.signing_window = HISTORY.window(r.url);
  return out;
}

/**
 * Share names and classes across IPSWs (a device's newest IPSW may be unreadable, an older one fine).
 * Each value comes from the newest IPSW that has it, so the result doesn't depend on fetch order.
 */
function mergeDeviceInfo(results: Result[], userNames: Record<string, string>) {
  const names: Record<string, string> = {}, src: Record<string, NameSource> = {};
  const cls: Record<string, string> = {}, board: Record<string, string> = {}, plat: Record<string, string> = {};
  const specs: Record<string, FirmwareSpecs> = {};
  for (const [p, info] of devicesIn([...results].sort(newestFirst))) {
    if (info.names[p] && !names[p]) { names[p] = info.names[p]; src[p] = info.nameSource[p]; }
    cls[p] ??= info.deviceClass[p];
    board[p] ??= info.board[p];
    plat[p] ??= info.platform[p];
    specs[p] ??= info.specs[p];
  }
  for (const [p, n] of Object.entries(userNames)) if (!names[p]) { names[p] = n; src[p] = "user"; }
  for (const [p, info] of devicesIn(results)) {
    if (names[p]) { info.names[p] = names[p]; info.nameSource[p] = src[p]; }
    if (cls[p]) info.deviceClass[p] = cls[p];
    if (board[p]) info.board[p] = board[p];
    if (plat[p]) info.platform[p] = plat[p];
    if (specs[p]) info.specs[p] = specs[p];
  }
}

const sources = () => [
  ...Object.values(CONFIG.feeds), "IPSW contents", CONFIG.tss_url, CONFIG.gdmf_url,
  ...(USED_APPLEDB ? [`${CONFIG.appledb.url} (third-party: URL discovery only)`] : []),
  ...(TECH_SPECS.size ? [`${CONFIG.techspecs.base}/docs (Apple Tech Specs, scraped HTML)`] : []),
  ...(CHIP_IMAGES.size ? [`${CONFIG.chip_images.api} (Wikimedia Commons chip photos, third-party: images only)`] : []),
];

const tally = (items: { signing?: string }[]) =>
  Object.fromEntries(["signed", "unsigned", "unknown"].map((s) => [s, items.filter((i) => i.signing === s).length]));

/** Newest result per device identifier. */
function newestPerDevice(results: Result[]) {
  const best = new Map<string, Result>();
  for (const r of results) {
    for (const p of r.info.products) {
      const cur = best.get(p);
      if (!cur || newestFirst(r, cur) < 0) best.set(p, r);
    }
  }
  return best;
}

/** One entry per device, pointing at the newest IPSW Apple's feed lists for it. */
function devicesJson(results: Result[], withTss: boolean) {
  const best = newestPerDevice(results);
  const fromIpsws = [...best.keys()].sort(cmpIdent).map((p) => {
    const r = best.get(p)!;
    const latest = {
      version: r.info.version, build: r.info.build, url: r.url, size_bytes: r.info.size ?? null, sha1: r.info.sha1 ?? null,
      ...(withTss && tssJson(r)),
      ...extras(r, [p, r.info.board[p]]),
    };
    return {
      ...deviceJson(r.info, p), source: "ipsw",
      url_source: URL_SOURCE[r.info.feed] ?? "apple",
      latest_in_feed: latest,
      ...specsJson(r.info, p),
      ...otaAssetsJson(p),
    };
  });
  return [...fromIpsws, ...otaOnlyDevices(new Set(best.keys()), withTss)];
}

// gdmf files Watch, TV and HomePod builds under its "iOS" set; report the real OS family instead.
const GDMF_OS: Record<string, string> = { Watch: "watchOS", AppleTV: "tvOS", AudioAccessory: "audioOS" };

/**
 * Devices Apple lists in gdmf (e.g. Vision Pro) but publishes no IPSW for. They get version and
 * dates from gdmf; signing can't be checked without an IPSW BuildManifest, so it's "unknown".
 */
function otaOnlyDevices(known: Set<string>, withTss: boolean) {
  const dates = DATES;
  if (!dates) return [];
  return dates.otaOnly(known).filter((d) => !DEVICE_FILTER || d.identifier.includes(DEVICE_FILTER))
    .sort((a, b) => cmpIdent(a.identifier, b.identifier)).map((d) => {
    const cls = productClass(d.identifier) ?? null;
    const latest = {
      version: d.version, build: d.build, url: null,
      ...(withTss && { signing: "unknown", tss_status: null, message: "no IPSW or full OTA update from Apple yet; signing can't be checked" }),
      dates: dates.lookup(d.build, [d.identifier]),
    };
    return {
      identifier: d.identifier, name: null, name_source: null,
      device_class: cls,
      platform: GDMF_OS[cls ?? ""] ?? d.platform, board: OTA_ASSETS.get(d.identifier)?.[0]?.board ?? null,
      source: "gdmf", latest_in_feed: latest,
      ...otaAssetsJson(d.identifier),
    };
  });
}

/** One entry per IPSW, newest first, with the devices it covers. */
function ipswsJson(results: Result[]) {
  return [...results]
    .sort(newestFirst)
    .map((r) => ({ ...ipswJson(r), devices: [...r.info.products].sort(cmpIdent).map((p) => deviceJson(r.info, p)) }));
}

/** Everything in one document: devices + IPSWs + summaries. */
function fullJson(results: Result[]) {
  const devices = devicesJson(results, true);
  const ipsws = ipswsJson(results);
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    sources: sources(),
    summary: {
      devices: { total: devices.length, ...tally(devices.map((d) => d.latest_in_feed)) },
      ipsws: { total: ipsws.length, ...tally(ipsws) },
    },
    devices,
    ipsws,
  }, null, 2));
}

function listDevices(results: Result[], json: boolean, withTss: boolean) {
  if (json) {
    const devices = devicesJson(results, withTss);
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      sources: sources(),
      summary: { total: devices.length, ...(withTss && tally(devices.map((d) => d.latest_in_feed))) },
      devices,
    }, null, 2));
    return;
  }
  const best = newestPerDevice(results);
  const ids = [...best.keys()].sort(cmpIdent);

  const sig = withTss ? `${"Signing".padEnd(10)} ` : "";
  console.log(`${"Identifier".padEnd(18)} ${"Name".padEnd(40)} ${"Latest in feed".padEnd(20)} ${sig}IPSW`);
  for (const p of ids) {
    const r = best.get(p)!;
    const s = withTss ? `${(r.state === "SIGNED*" ? "signed*" : signing(r.state)).padEnd(10)} ` : "";
    console.log(`${p.padEnd(18)} ${displayName(r.info, p).padEnd(40)} ${`${r.info.version} (${r.info.build})`.padEnd(20)} ${s}${r.url}`);
  }
  if (ids.some((p) => !best.get(p)!.info.names[p])) {
    console.error("\n[...] = Apple's firmware has no readable name (pre-2014 encrypted DeviceTree); showing class + board config.");
  }
  if (ids.some((p) => best.get(p)!.info.nameSource[p] === "user")) console.error("†  = name from --names file, not Apple.");
  if (withTss) console.error("signed* = TSS 69: build is signed, no ticket issued for the fake ECID.");
}

const GROUP_TITLE: Record<string, string> = { signed: "Signed", unsigned: "Unsigned", unknown: "Unknown / error" };

function report(results: Result[], json: boolean) {
  if (json) return fullJson(results);
  const groups: Record<string, Result[]> = { signed: [], unsigned: [], unknown: [] };
  for (const r of [...results].sort(newestFirst)) groups[signing(r.state)].push(r);
  for (const [group, rows] of Object.entries(groups)) {
    if (!rows.length) continue;
    console.log(`\n=== ${GROUP_TITLE[group]} (${rows.length}) ===`);
    for (const r of rows) {
      const devs = [...r.info.products].sort(cmpIdent).map((p) => {
        const n = displayName(r.info, p);
        return n === "?" ? p : `${p} (${n.replace(/^\[|\]$/g, "")})`;
      }).join(", ") || r.info.feed;
      console.log(`${r.state.padEnd(9)} ${r.info.version} (${r.info.build}) [${devs}]`);
      console.log(`          ${r.url}`);
      if (group === "unknown") console.log(`          ${r.msg}`);
    }
  }
}

async function main(): Promise<number> {
  const { values: a } = parseArgs({
    options: {
      feed: { type: "string", default: "all" },
      device: { type: "string" },
      url: { type: "string", multiple: true },
      jobs: { type: "string" },
      names: { type: "string" },
      config: { type: "string" },
      "print-config": { type: "boolean", default: false },
      "list-devices": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "no-names": { type: "boolean", default: false },
      "no-tss": { type: "boolean", default: false },
      "no-dates": { type: "boolean", default: false },
      "no-appledb": { type: "boolean", default: false },
      "no-ota": { type: "boolean", default: false },
      "no-ota-assets": { type: "boolean", default: false },
      "tech-specs": { type: "boolean", default: false },
      "no-tech-specs": { type: "boolean", default: false },
      "no-chip-images": { type: "boolean", default: false },
      history: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (a.help) { console.log(USAGE); return 0; }
  loadConfig(a.config);
  if (a["print-config"]) { console.log(JSON.stringify(CONFIG, null, 2)); return 0; }
  const feedNames = Object.keys(CONFIG.feeds);
  const useAppleDb = CONFIG.appledb.enabled && !a["no-appledb"];
  const choices = [...feedNames, ...(useAppleDb ? ["appledb"] : []), ...(CONFIG.ota.enabled ? ["ota"] : []), "all"];
  if (!choices.includes(a.feed)) throw new Error(`--feed must be one of: ${choices.join(", ")}`);
  const jobs = a.jobs ? Number(a.jobs) : CONFIG.jobs;
  const userNames: Record<string, string> = a.names ? JSON.parse(readFileSync(a.names, "utf8")) : {};
  DEVICE_FILTER = a.device;

  // gdmf first: AppleDB lookups are driven by the builds Apple itself lists.
  if (!a["no-dates"] || useAppleDb) {
    DATES = await DateIndex.load().catch((e) => {
      console.error(`warning: no gdmf.apple.com data: ${errorMessage(e)}`);
      return null;
    });
  }

  const ipsws = a.url?.length
    ? new Map(a.url.map((u) => [u, emptyInfo("url")]))
    : await discoverIpsws(a.feed, a.device, useAppleDb, CONFIG.ota.enabled && !a["no-ota"]);
  if (!ipsws.size) { console.error("No IPSWs matched."); return 1; }

  const wantTss = !(a["list-devices"] && a["no-tss"]);
  console.error(`Inspecting ${ipsws.size} IPSW(s)...`);
  const results = await runParallel(ipsws, jobs, !a["no-names"], wantTss);
  mergeDeviceInfo(results, userNames);
  if ((a["tech-specs"] || CONFIG.techspecs.enabled) && !a["no-tech-specs"]) await lookupTechSpecs(results);
  if (CONFIG.chip_images.enabled && !a["no-chip-images"]) await loadChipImages(results);
  if (a["no-dates"]) DATES = null;
  if (CONFIG.ota_assets.enabled && !a["no-ota-assets"] && !a.url?.length) {
    await loadOtaAssets(results, a.device, jobs);
    const updates = await inspectOtaUpdates(results, jobs, wantTss);
    if (updates.length) {
      results.push(...updates);
      mergeDeviceInfo(results, userNames);
    }
  }
  if (a.history && wantTss) {
    HISTORY = new History(a.history);
    const now = new Date().toISOString();
    for (const r of results) HISTORY.record(r.url, r.info.version, r.info.build, signing(r.state), now);
    HISTORY.save();
  }

  if (a["list-devices"]) listDevices(results, a.json, wantTss);
  else report(results, a.json);
  return 0;
}

/** IPSW URLs from Apple's feeds, then Apple's OTA server, then (third-party) AppleDB. */
async function discoverIpsws(feed: string, device: string | undefined, useAppleDb: boolean, useOta: boolean) {
  const feedNames = Object.keys(CONFIG.feeds);
  const ipsws = await collectIpsws(feed === "all" ? feedNames : feedNames.filter((f) => f === feed), device);
  // AppleDB URL lookup first, but merged last: its Apple-hosted firmware also lets the OTA step read
  // Watch board IDs from BuildManifests (first-party data) when nothing else on this host knows them.
  const adb = useAppleDb && DATES && (feed === "all" || feed === "appledb")
    ? await discoverViaAppleDb(DATES, device) : null;
  const firmwareFor = (dev: string) => [...ipsws, ...(adb ?? [])]
    .filter(([, info]) => info.products.has(dev))
    .sort(([, x], [, y]) => x.products.size - y.products.size)
    .map(([u]) => u);
  // Apple's OTA server first (first-party), so a URL both sources return is credited to Apple.
  if (useOta && DATES && (feed === "all" || feed === "ota")) {
    const have = new Set<string>();
    if (feed === "all") for (const info of ipsws.values()) for (const p of info.products) have.add(p);
    const { found, skippedEncrypted, noBoard, fromFirmware } = await discoverOta(DATES, have, device, firmwareFor);
    for (const [u, info] of found) if (!ipsws.has(u)) ipsws.set(u, info);
    console.error(`Apple OTA: ${found.size} full update(s) with a BuildManifest`
      + (skippedEncrypted ? `, ${skippedEncrypted} encrypted (.aea) left for the asset step` : "")
      + (fromFirmware ? `, ${fromFirmware} board ID(s) read from firmware` : "")
      + (noBoard ? `, ${noBoard} device(s) with no known board ID` : ""));
  }
  // Third-party URL discovery last: only adds URLs no Apple source returned.
  if (adb) {
    USED_APPLEDB = true;
    let added = 0;
    for (const [u, info] of adb) if (!ipsws.has(u)) { ipsws.set(u, info); added++; }
    console.error(`AppleDB: ${added} extra Apple-hosted URL(s) for gdmf builds (third-party discovery only)`);
  }
  return ipsws;
}

async function lookupTechSpecs(results: Result[]) {
  // One lookup per distinct marketing name + cellular hardware; devices sharing both share the page.
  const ts = TechSpecsLookup.load();
  const byName = new Map<string, { name: string; cellular?: boolean; ids: string[] }>();
  for (const [p, info] of devicesIn(results)) {
    const n = info.names[p];
    if (!n || info.nameSource[p] !== "devicetree") continue;
    const cellular = info.specs[p]?.radios.cellular;
    const key = `${n}\0${cellular}`;
    const g = byName.get(key) ?? { name: n, cellular, ids: [] };
    if (!g.ids.includes(p)) g.ids.push(p);
    byName.set(key, g);
  }
  let i = 0, found = 0;
  for (const { name, cellular, ids } of byName.values()) {
    process.stderr.write(`\r  tech specs [${++i}/${byName.size}]`);
    const t = await ts.forName(name, cellular);
    if (t) found++;
    for (const p of ids) TECH_SPECS.set(p, t);
  }
  // Product lines where the firmware name has no generation ("iPod touch"): launch order -> Nth generation.
  for (const { prefix, name } of CONFIG.techspecs.generations) {
    const ids = new Set<string>();
    for (const [p] of devicesIn(results)) if (p.startsWith(prefix)) ids.add(p);
    const majors = [...new Set([...ids].map((p) => Number(/(\d+),/.exec(p)?.[1])))].filter(Number.isFinite).sort((x, y) => x - y);
    const gens = await ts.generations(name);
    const contiguous = [...gens.keys()].sort((x, y) => x - y).every((g, i) => g === i + 1);
    if (!majors.length || majors.length !== gens.size || !contiguous) {
      if (majors.length) console.error(`\nApple Tech Specs: ${name}: ${majors.length} hardware generation(s) vs ${gens.size} page(s), not matching`);
      continue;
    }
    for (const [i, major] of majors.entries()) {
      const t = await ts.forEntry(gens.get(i + 1)!);
      if (t) found++;
      for (const p of ids) if (p.startsWith(`${prefix}${major},`)) TECH_SPECS.set(p, t);
    }
  }
  ts.save();
  console.error(`\nApple Tech Specs: ${found}/${byName.size} product name(s) matched`);
}

async function loadChipImages(results: Result[]) {
  const chips = new Set<string>();
  for (const [p, info] of devicesIn(results)) { const c = chipFor(p, info.names[p]); if (c) chips.add(c); }
  try {
    for (const [k, v] of await chipImages(chips)) CHIP_IMAGES.set(k, v);
    console.error(`Chip photos (Wikimedia Commons): ${CHIP_IMAGES.size}/${chips.size} chip(s)`);
  } catch (e) {
    console.error(`warning: chip photos: ${errorMessage(e)}`);
  }
}

async function loadOtaAssets(results: Result[], device: string | undefined, jobs: number) {
  // Every device in the report: from IPSWs (board from firmware) and gdmf-only ones (no board yet).
  const devs = new Map<string, string | undefined>();
  for (const [p, info] of devicesIn(results)) if (!devs.get(p)) devs.set(p, info.board[p]);
  for (const d of DATES?.otaOnly(new Set(devs.keys())) ?? []) devs.set(d.identifier, undefined);
  // Devices Apple's lists don't have yet, from AppleDB; kept below only if Apple's server answers.
  const candidates = await appledbNewDevices(new Set(devs.keys()));
  for (const id of candidates) devs.set(id, undefined);
  if (device) for (const k of devs.keys()) if (!k.includes(device)) devs.delete(k);
  const assets = await listOtaAssets(devs, jobs);
  let total = 0, withAny = 0, discovered = 0;
  for (const [k, v] of assets) {
    if (candidates.includes(k)) {
      if (!v.length) continue;
      discovered++;
    }
    OTA_ASSETS.set(k, v);
    total += v.length;
    if (v.length) withAny++;
  }
  console.error(`Apple OTA assets: ${total} update(s) for ${withAny}/${assets.size} device(s)`
    + (candidates.length ? `, ${discovered} new device(s) Apple answered for (of ${candidates.length} AppleDB candidates)` : ""));
}

/**
 * Full OTA updates newer than any readable firmware for their device: encrypted (.aea) HomePod,
 * Apple TV and Watch builds, and .zip updates for families the OTA feed step doesn't query.
 */
async function inspectOtaUpdates(results: Result[], jobs: number, wantTss: boolean): Promise<Result[]> {
  const best = newestPerDevice(results);
  const seen = new Set(results.map((r) => r.url));
  const todo = new Map<string, IpswInfo>();
  for (const [dev, assets] of OTA_ASSETS) {
    const cur = best.get(dev);
    for (const x of assets) {
      if (x.type !== "full" || (x.encrypted && !x.decryption_key) || !x.version || seen.has(x.url)) continue;
      if (cur && cmpVersion(x.version, cur.info.version) <= 0) continue;
      const info = todo.get(x.url) ?? { ...emptyInfo("ota"), ...(x.encrypted && { aeaKey: x.decryption_key! }) };
      info.board[dev] ??= x.board.toLowerCase();
      todo.set(x.url, info);
    }
  }
  if (!todo.size) return [];
  // DeviceTrees sit further into the stream; read them only for devices no other firmware names.
  const named = new Set<string>();
  for (const [p, info] of devicesIn(results)) if (info.names[p]) named.add(p);
  const needsNames = new Map<string, IpswInfo>(), rest = new Map<string, IpswInfo>();
  for (const [u, info] of todo) (Object.keys(info.board).some((p) => !named.has(p)) ? needsNames : rest).set(u, info);
  console.error(`Reading ${todo.size} OTA update(s) newer than any IPSW (BuildManifest${needsNames.size ? `, DeviceTree for ${needsNames.size}` : ""})...`);
  const n = Math.min(jobs, 4);
  const out = [
    ...(rest.size ? await runParallel(rest, n, false, wantTss) : []),
    ...(needsNames.size ? await runParallel(needsNames, n, true, wantTss) : []),
  ];
  // gdmf boards are per device; keep only those the manifest itself lists.
  for (const { info } of out) for (const p of Object.keys(info.board)) if (!info.products.has(p)) delete info.board[p];
  return out;
}

// Set exitCode rather than process.exit(): exit() can truncate large output written to a pipe.
if (typeof tls.setDefaultCACertificates !== "function") {
  // gdmf.ts needs it (Node 24.5+) to trust Apple's root CA.
  console.error(`signet needs Node.js 24.5 or later (this is ${process.version})`);
  process.exitCode = 2;
} else if (process.argv[2] === "serve") {
  serve(process.argv.slice(3)).catch((e) => { console.error(e); process.exitCode = 2; });
} else if (process.argv[2] === "decrypt") {
  try { process.exitCode = decryptCli(process.argv.slice(3)); } catch (e) {
    console.error(`signet decrypt: ${errorMessage(e)}`);
    // Bad flags are usage errors (2), like the main command; anything else failed to decrypt (1).
    process.exitCode = (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
} else {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(errorMessage(e)); process.exitCode = 2; });
}
