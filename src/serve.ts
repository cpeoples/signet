/**
 * `signet serve`: a live data service for the website (and anything else).
 *
 * Runs the full Signet pipeline against Apple's servers in a child process, keeps the result in
 * memory only (nothing is written to disk), and serves it over HTTP. Re-runs on an interval so
 * signing status stays current.
 *
 *   GET /health        { ready, generated_at, refreshing }
 *   GET /api/site      site-shaped data: families, devices (with every IPSW + OTA asset), summary
 *   GET /api/signing   { generated_at, devices: { "iPhone17,1": { build, version, signing } } }
 *   GET /api/report    the raw `signet --json` document
 *
 * CORS is open (read-only public data) so browsers can refresh signing badges live.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage, naturalCompare, productClass } from "./util.js";

/** Apple's ProductType family -> section on the site. Unknown families still appear, under their own name. */
const FAMILIES: [RegExp, string, string][] = [
  [/^iPhone/, "iphone", "iPhone"],
  [/^iPad/, "ipad", "iPad"],
  [/^Watch/, "watch", "Apple Watch"],
  [/^(Mac|MacBook|Macmini|iMac|VirtualMac)/, "mac", "Mac"],
  [/^AppleTV/, "apple-tv", "Apple TV"],
  [/^AudioAccessory/, "homepod", "HomePod"],
  [/^RealityDevice/, "vision", "Apple Vision"],
  [/^iPod/, "ipod", "iPod"],
  [/^iBridge/, "t2", "Apple T2 Security Chip"],
];

function family(id: string): { slug: string; name: string } {
  for (const [re, slug, name] of FAMILIES) if (re.test(id)) return { slug, name };
  const cls = productClass(id) ?? "other";
  return { slug: cls.toLowerCase(), name: cls };
}

const slugify = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** "iPhone17,1" -> 17001: newer hardware generations sort higher. */
const rank = (id: string) => { const m = /(\d+),(\d+)$/.exec(id); return m ? Number(m[1]) * 1000 + Number(m[2]) : 0; };

const OS: Record<string, string> = {
  iphone: "iOS", ipad: "iPadOS", watch: "watchOS", mac: "macOS", "apple-tv": "tvOS",
  homepod: "audioOS", vision: "visionOS", ipod: "iOS", t2: "bridgeOS",
};

/** Shape the raw report for the website: one record per device with all its firmware. */
export function siteData(doc: any) {
  const byDevice = new Map<string, any[]>();
  for (const i of doc.ipsws ?? []) {
    for (const d of i.devices ?? []) {
      const list = byDevice.get(d.identifier) ?? [];
      list.push({
        version: i.version, build: i.build, url: i.url, size_bytes: i.size_bytes, sha1: i.sha1,
        signing: i.signing, released: i.dates?.released ?? null, url_source: i.feed === "appledb" ? "appledb" : "apple",
      });
      byDevice.set(d.identifier, list);
    }
  }
  const devices = (doc.devices ?? []).map((d: any) => {
    const f = family(d.identifier);
    const ipsws = (byDevice.get(d.identifier) ?? []).sort((a, b) => naturalCompare(b.version, a.version)); // newest first
    const ts = d.tech_specs ?? null;
    return {
      identifier: d.identifier,
      slug: slugify(d.identifier),
      family: f.slug,
      family_name: f.name,
      os: OS[f.slug] ?? d.platform ?? null,
      rank: rank(d.identifier),
      name: d.name ?? ts?.product ?? null,
      name_source: d.name_source ?? null,
      board: d.board ?? null,
      platform: d.platform ?? null,
      image: d.images?.[0] ?? null,
      images: d.images ?? [],
      latest: d.latest_in_feed ?? null,
      ipsws,
      ota_assets: d.ota_assets ?? [],
      firmware_specs: d.firmware_specs ?? null,
      tech_specs: ts,
      year: ts?.year_introduced ?? null,
    };
  }).sort((a: any, b: any) => naturalCompare(a.identifier, b.identifier));

  const families = new Map<string, any>();
  for (const d of devices) {
    const f = families.get(d.family) ?? { slug: d.family, name: d.family_name, devices: 0, ipsws: 0, ota: 0, signed: 0, unsigned: 0, unknown: 0, image: null };
    f.devices++;
    f.ipsws += d.ipsws.length;
    f.ota += d.ota_assets.length;
    const signing: string = d.latest?.signing ?? "unknown";
    f[signing] = (f[signing] ?? 0) + 1;
    if (d.image) f.image = d.image; // devices are sorted by identifier, so the newest model's image wins
    families.set(d.family, f);
  }
  const order = FAMILIES.map(([, s]) => s);
  return {
    generated_at: doc.generated_at,
    sources: doc.sources ?? [],
    summary: {
      ...doc.summary,
      ota_assets: devices.reduce((n: number, d: any) => n + d.ota_assets.length, 0),
    },
    families: [...families.values()].sort((a, b) => {
      const x = order.indexOf(a.slug), y = order.indexOf(b.slug);
      return (x < 0 ? 99 : x) - (y < 0 ? 99 : y);
    }),
    devices,
  };
}

const signingOnly = (doc: any) => ({
  generated_at: doc.generated_at,
  devices: Object.fromEntries((doc.devices ?? []).map((d: any) => [d.identifier, {
    version: d.latest_in_feed?.version ?? null, build: d.latest_in_feed?.build ?? null, signing: d.latest_in_feed?.signing ?? "unknown",
  }])),
});

/** Run `signet --json <args>` and return the parsed document (stdout stays in memory). */
function runPipeline(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "--json", ...args], { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`signet exited with ${code}`));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(new Error("signet printed invalid JSON", { cause: e })); }
    });
  });
}

export async function serve(argv: string[]) {
  const { values: a } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string", default: "8787" },
      host: { type: "string", default: "127.0.0.1" },
      refresh: { type: "string", default: "30" }, // minutes; 0 = run once
    },
  });
  // Everything else is passed through to the pipeline (e.g. --device iPhone, --no-tech-specs).
  const own = ["--port", "--host", "--refresh"];
  const isOwn = (x: string) => own.some((o) => x === o || x.startsWith(`${o}=`));
  const passthrough = argv.filter((x, i) => !isOwn(x) && !own.includes(argv[i - 1]));

  let doc: any = null, site: any = null, refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    const t = Date.now();
    console.error(`signet serve: checking Apple (${passthrough.join(" ") || "all devices"})...`);
    try {
      doc = await runPipeline(passthrough);
      site = siteData(doc);
      console.error(`signet serve: ready, ${site.devices.length} devices in ${Math.round((Date.now() - t) / 1000)}s`);
    } catch (e) {
      console.error(`signet serve: refresh failed: ${errorMessage(e)}`);
    } finally {
      refreshing = false;
    }
  };

  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    });
    res.end(JSON.stringify(body));
  };

  const routes: Record<string, () => unknown> = {
    "/api/site": () => site,
    "/api/signing": () => signingOnly(doc),
    "/api/report": () => doc,
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/health") return send(res, 200, { ready: !!doc, generated_at: doc?.generated_at ?? null, refreshing });
    if (!doc) return send(res, 503, { error: "first check against Apple still running", refreshing });
    if (Object.hasOwn(routes, path)) return send(res, 200, routes[path]());
    send(res, 404, { error: "not found", endpoints: ["/health", ...Object.keys(routes)] });
  });
  server.listen(Number(a.port), String(a.host), () => console.error(`signet serve: http://${a.host}:${a.port}`));

  await refresh();
  const minutes = Number(a.refresh);
  if (minutes > 0) setInterval(() => void refresh(), minutes * 60_000); // refresh() logs its own errors
}
