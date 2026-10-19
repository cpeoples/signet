/**
 * Apple Tech Specs (support.apple.com), first-party but HTML: product images, retail specs (capacity,
 * display, chip, size and weight, ...), keyed by the marketing name the firmware already gives us.
 *
 *   1. Family indexes (support.apple.com/en-us/docs/{iphone,ipad,...}) list products by name and
 *      link to a product hub page.
 *   2. The hub's "Tech Specs" link leads to the specs article (h3 section titles, p and li items, images).
 *
 * Pages are cached on disk (specs never change), so later runs make no requests for known devices.
 * Best effort: anything that doesn't match or parse is simply omitted.
 */
import { CONFIG, ua } from "./config.js";
import { fetchOk } from "./retry.js";
import { errorMessage, readCache, writeJson } from "./util.js";

export interface TechSpecs {
  /** Product title as Apple's page shows it, e.g. "iPhone 16 Pro". */
  product: string;
  url: string;
  year_introduced: string | null;
  images: string[];
  /** Section title -> lines, as written by Apple ("Capacity" -> ["128GB", "256GB", ...]). */
  sections: Record<string, string[]>;
}

type Cache = { version?: number; index: Record<string, string>; index_at?: string; specs: Record<string, TechSpecs | null> };
/** Bump when parseSpecs output changes so cached pages are re-parsed. */
const CACHE_VERSION = 3;
const TITLE_SUFFIX = /\s*-\s*(Tech Specs|Technical Specifications?)$/i;
/** Product title, tidied (also fixes titles cached before the suffix rule covered them). */
export const productTitle = (t: TechSpecs) => t.product.replace(TITLE_SUFFIX, "");

async function get(url: string): Promise<{ html: string; url: string }> {
  const r = await fetchOk(url, { headers: ua() });
  return { html: await r.text(), url: r.url };
}

const ENTITIES: Record<string, string> = { amp: "&", quot: "\"", apos: "'", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"",
  nbsp: " ", ordm: "°", deg: "°", trade: "™", reg: "®", copy: "©", ndash: "–", mdash: "—", times: "×", micro: "µ", plusmn: "±", fnof: "ƒ", shy: "" };
const decode = (s: string) => s
  .replace(/<sup\b[^>]*>[\s\d,*†‡§-]*<\/sup>/gi, "")                 // footnote markers ("32GB<sup>2</sup>")
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|td|th|tr)>/gi, " ").replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
  .replace(/[\u2010-\u2011]/g, "-").replace(/\s+/g, " ").trim();
const norm = (s: string) => decode(s).toLowerCase()
  // Firmware writes "iPad Pro (12.9-inch) (3rd generation)", Apple's index "iPad Pro 12.9-inch (3rd generation)".
  .replace(/\((\d+(?:\.\d+)?-inch)\)/g, "$1").replace(/\s+/g, " ").trim();

/** name -> product hub URL, from every family index page. */
async function loadIndex(): Promise<Record<string, string>> {
  const index: Record<string, string> = {};
  for (const fam of CONFIG.techspecs.families) {
    try {
      const { html } = await get(`${CONFIG.techspecs.base}/docs/${fam}`);
      for (const m of html.matchAll(/<a\b([^>]*?)data-ss-analytics-link-text="([^"]+)"/gs)) {
        const href = /href="([^"]+)"/.exec(m[1])?.[1];
        if (href && /\/docs\/[a-z-]+\/(pl)?\d+$/.test(href)) index[decode(m[2])] ??= href;
      }
    } catch (e) {
      console.error(`warning: tech specs index ${fam}: ${errorMessage(e)}`);
    }
  }
  return index;
}

/** [normalized name, index entry] for every product in the index. */
type IndexKeys = (readonly [string, string])[];

/**
 * Apple titles one page for two chips ("Mac mini (M6 or M5 Pro)") while the firmware names each
 * model ("Mac mini (M6)"). Maps every single-chip name to the shared page.
 */
function chipChoices(keys: IndexKeys): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, entry] of keys) {
    const m = /^(.*\()([^()]*)\)$/.exec(k);
    const parts = m?.[2].split(", ") ?? [];
    const i = parts.findIndex((p) => p.includes(" or "));
    if (!m || i < 0) continue;
    for (const chip of parts[i].split(" or ")) out.set(`${m[1]}${parts.map((p, j) => (j === i ? chip : p)).join(", ")})`, entry);
  }
  return out;
}

/**
 * Firmware name -> index entry. Exact first (including one chip of a shared "X or Y" page); then
 * without size or connectivity suffixes the firmware adds ("Apple Watch Series 2 42mm",
 * "... (GPS + Cellular)"); then a unique prefix match, using Wi-Fi vs Cellular to pick between variants.
 */
function match(keys: IndexKeys, choices: Map<string, string>, name: string, cellularHw?: boolean): string | null {
  const n = norm(name);
  const base = n.replace(/\s*\d+mm$/, "").replace(/\s*\((gps|wi-fi)[^)]*\)/g, "").trim();
  for (const t of [n, base]) {
    const e = keys.find(([k]) => k === t)?.[1] ?? choices.get(t);
    if (e) return e;
  }
  // Firmware's baseband presence beats the name ("iPad Pro (11-inch)" covers Wi-Fi and Cellular models).
  const cellular = cellularHw ?? /cellular/.test(n);
  for (const t of [n, base]) {
    let c = keys.filter(([k]) => k.startsWith(t + " "));
    if (c.length > 1) c = c.filter(([k]) => /cellular/.test(k) === cellular);
    if (c.length === 1) return c[0][1];
  }
  return null; // ambiguous (e.g. one firmware name for M3, M3 Pro and M3 Max pages): don't guess
}

function parseSpecs(html: string, url: string): TechSpecs | null {
  const start = html.indexOf('<div id="sections"');
  if (start < 0) return null;
  const end = html.indexOf("ac-gf-content", start);
  const body = html.slice(start, end < 0 ? undefined : end);

  const product = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? "").replace(TITLE_SUFFIX, "");
  if (!product) return null;
  const images = [...new Set([...body.matchAll(/<img\b[^>]*class="gb-image[^"]*"[^>]*src="(https:[^"]+)"/g)].map((m) => m[1]))];
  const year = /Year introduced:\s*(\d{4})/i.exec(decode(body))?.[1] ?? null;

  // Walk h3, p and li in document order; each h3 opens a section.
  const sections: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const m of body.matchAll(/<(h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const text = decode(m[2]);
    if (!text) continue;
    if (m[1] === "h3") {
      cur = text.replace(/\d+$/, "").trim(); // footnote markers: "Capacity1" -> "Capacity"
      sections[cur] ??= [];
    } else if (cur && !/^(Year introduced|Identify your)/i.test(text) && !sections[cur].includes(text)) {
      sections[cur].push(text);
    }
  }
  for (const k of Object.keys(sections)) if (!sections[k].length) delete sections[k];
  return { product, url, year_introduced: year, images, sections };
}

/**
 * Compact, uniform hardware summary of Apple's spec sections. Section titles and wording vary by
 * product and era, so each field takes the lines that look like hardware facts from the sections
 * that carry them, and skips marketing prose, software features, legal footnotes, in-the-box and
 * environmental content. Fields with nothing to show are left out.
 */
export interface SpecSummary {
  capacity?: string[];
  chip?: string[];
  memory?: string[];
  display?: string[];
  rear_camera?: string[];
  front_camera?: string[];
  video?: string;
  battery?: string[];
  charging?: string[];
  ports?: string[];
  wireless?: string[];
  sim?: string;
  water_resistance?: string;
  sensors?: string[];
  size?: string[];
  colors?: string[];
}

const SKIP_LINE = /^(learn more|see |for details|visit |model a\d)|user guide|available separately\)?$/i;

/** Clean a line; "X:" headers absorb the short lines after them ("USB-C ... for: Charging, USB 3"). */
function lines(raw: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let s = raw[i].normalize("NFKC").replace(/\u200b/g, "").replace(/&fnof;/g, "ƒ").replace(/^New /, "").replace(/\*+$/, "")
      .replace(/(?<=[a-z]{3})\d{1,2}(?=$|[\s:),])/g, "") // footnote digits: "Qi chargers7", "Wideband chip13"
      .trim();
    if (s.endsWith(":") && raw[i + 1] && raw[i + 1].length <= 40) {
      const items: string[] = [];
      while (raw[i + 1] && raw[i + 1].length <= 40 && !raw[i + 1].endsWith(":") && !/\bchip$/i.test(raw[i + 1])) items.push(raw[++i]);
      s = `${s} ${items.join(", ")}`;
    }
    // Prose (several sentences) is explanation, not a spec.
    if (s && !SKIP_LINE.test(s) && !/[a-z)]\.\s+[A-Z]/.test(s)) out.push(s);
  }
  return out;
}

/** Over-long line: trim a "Header: a, b, c" list from the end, else keep the first clause. */
const short = (s: string, max: number): string | null => {
  if (s.length <= max) return s;
  const colon = s.indexOf(": ");
  if (colon > 0 && s.includes(", ", colon)) {
    const items = s.slice(colon + 2).split(", ");
    while (items.length > 1 && `${s.slice(0, colon + 2)}${items.join(", ")}`.length > max) items.pop();
    const t = `${s.slice(0, colon + 2)}${items.join(", ")}`;
    if (t.length <= max) return t;
  }
  const first = s.split(/;\s|,\s(?=[A-Z0-9])/)[0];
  return first.length <= max ? first : null;
};

function pick(src: string[], re: RegExp, max: number, cap: number): string[] {
  const out: string[] = [];
  for (const l of src) {
    if (!re.test(l)) continue;
    const s = short(l, max);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Metric value of "5.89 inches (149.6 mm)", "46mm", "9.5 cm", "0.76 pound (345 grams)" ... */
function metric(v: string, kind: "len" | "mass"): number | null {
  const re = kind === "len" ? /([\d.]+)\s*(mm|cm)\b/i : /([\d.,]+)\s*(g|grams|kg|kilograms)\b/i;
  const m = re.exec(/\(([^)]*)\)/.exec(v)?.[1] ?? "") ?? re.exec(v);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return /^(cm|kg|kilograms)$/i.test(m[2]) ? +(n * (kind === "len" ? 10 : 1000)).toFixed(1) : n;
}

/** Size and weight lines -> "149.6 × 71.5 × 8.25 mm, 199 g", one per model when the page lists several. */
function sizes(raw: string[]): string[] {
  const out: string[] = [];
  let label = "", dims: Record<string, number> = {}, grams: number[] = [];
  const flush = () => {
    const hwd = [dims.height, dims.width, dims.depth].filter((x) => x != null);
    const g = [...new Set(grams)].sort((a, b) => a - b);
    const w = !g.length ? "" : g.length === 1 ? `${g[0]} g` : `${g[0]}\u2013${g[g.length - 1]} g`;
    const parts = [hwd.length ? `${hwd.join(" × ")} mm` : "", w].filter(Boolean);
    if (parts.length) out.push(`${label ? `${label}: ` : ""}${parts.join(", ")}`);
    dims = {}; grams = [];
  };
  for (const l of raw.map((x) => x.replace(/^(\w+):(\S)/, "$1: $2"))) {
    const dim = /^(height|width|depth|length|thickness)\b[^:]*:\s*(.+)$/i.exec(l) ?? /^(.+?)\s+(high|tall|wide|deep)\b/i.exec(l);
    if (dim) {
      const key = /^(height|length|high|tall)$/i.test(dim[1]) || /^(high|tall)$/i.test(dim[2]) ? "height"
        : /^(width|wide)$/i.test(dim[1]) || /^wide$/i.test(dim[2]) ? "width" : "depth";
      const v = metric(/^(height|width|depth|length|thickness)$/i.test(dim[1]) ? dim[2] : l, "len");
      if (v == null) continue;
      if (dims[key] != null) { flush(); label = ""; }
      dims[key] = v;
    } else if (/^weight\b|^[\d.,\u2013-]+\s*(ounces|pounds?)\b/i.test(l) && !/battery/i.test(l)) {
      const v = metric(l.replace(/\u2013[\d.]+(?=\s*(g|grams|kg))/i, ""), "mass");
      if (v != null) grams.push(v);
    } else if (/^(\d+mm|[A-Z][\w ,()-]{2,30})$/.test(l) && !/^(dimensions|weight|size)$/i.test(l)) {
      flush(); label = l; // model sub-heading: "46mm", "iPhone 16 Pro Max", "14-inch model"
    }
  }
  flush();
  return out.slice(0, 4);
}

/**
 * Camera lines -> one "<resolution> <lens>" entry per camera, e.g. "12MP Main camera" -> "12MP",
 * "Dual 12MP Wide and Ultra Wide cameras" -> "12MP Wide", "12MP Ultra Wide",
 * "48MP Fusion Ultra Wide: 13 mm, ..." -> "48MP Fusion Ultra Wide". Lens names (Main, Wide) are kept
 * only when they tell several cameras apart.
 */
function cameras(src: string[]): string[] {
  const MP = /(\d+(?:\.\d+)?)\s?(?:stereo\s)?(?:MP|-?megapixels?)\b/i;
  const NOISE = /\b(camera system|cameras?|photos|isight|facetime|hd|landscape|front|stereo)\b/gi;
  type Line = { umbrella: boolean; cams: string[] };
  const parsed: Line[] = [];
  for (const raw of src) {
    // Modes and virtual crops, not cameras: "Panorama (up to 63MP)", "48MP macro photography",
    // "Also enables 12MP 2x Telephoto", "12MP optical-quality 2x Telephoto".
    if (/macro|photography|panorama|up to \d+MP|also enables|optical-quality/i.test(raw)) continue;
    const m = MP.exec(raw);
    if (!m) continue;
    const mp = `${m[1]}MP${/stereo/i.test(raw) ? " stereo" : ""}`;
    const before = raw.slice(0, m.index), after = raw.slice(m.index + m[0].length);
    let rest: string;
    if (/:\s*$/.test(before)) rest = before.replace(/:\s*$/, "");                 // "Ultra Wide: 10MP, ƒ/2.4 ..."
    else if (/^[^:]*system\s*:/i.test(after)) rest = after.split(":")[1];        // "Pro 12MP camera system: Ultra Wide, Wide, and Telephoto"
    else if (/^\s*(dual|triple)\b/i.test(raw)) rest = after.split(":")[0];       // "Triple 12MP Ultra Wide, Wide, and Telephoto cameras"
    else rest = after.split(/[:,]/)[0];                                           // "48MP Fusion Main: 24 mm, ..."
    rest = rest.split(/\s+with\s|\(|;/)[0].replace(NOISE, " ").replace(/\s+/g, " ").trim();
    const lenses = rest.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
    const umbrella = /^(dual|triple|pro|single)\b/i.test(raw.trim()) || /system/i.test(raw) || /^\s*(dual|pro)\b/i.test(rest);
    parsed.push({ umbrella, cams: lenses.length > 1 ? lenses.map((l) => `${mp} ${l}`) : [`${mp} ${rest}`.trim()] });
  }
  // Umbrella lines ("48MP Pro Fusion camera system") only when no per-camera lines follow.
  const individual = parsed.filter((p) => !p.umbrella);
  const cams = [...new Set((individual.length ? individual : parsed).flatMap((p) => p.cams)
    .map((c) => c.replace(/^(\S+MP(?: stereo)?) (?:dual|pro) /i, "$1 ").replace(/\b[a-z](?=[a-z-]*$|[a-z-]* )/g, (ch) => ch.toUpperCase())))];
  return cams.length === 1 ? [cams[0].replace(/\s+(main|(?<!ultra )wide|wide-angle)$/i, "")] : cams;
}

/** Zoom summary: the overall range when Apple gives one, else the first clause. */
const zoom = (l: string) => /(\d+(?:\.\d+)?x optical(?:-quality)? zoom range)/i.exec(l)?.[1] ?? l.split(/[;,]\s/)[0];

const summaries = new WeakMap<TechSpecs, SpecSummary>();

/** summarizeSpecs(), once per page: the report asks for a device's summary several times. */
export function summarize(t: TechSpecs): SpecSummary {
  let s = summaries.get(t);
  if (!s) summaries.set(t, (s = summarizeSpecs(t)));
  return s;
}

function summarizeSpecs(t: TechSpecs): SpecSummary {
  const skipSec = /in the box|environment|accessibility|built-in apps|languages|requirements/i;
  const rawSec = (re: RegExp) => Object.entries(t.sections).filter(([k]) => re.test(k.replace(/&shy;/g, ""))).flatMap(([, v]) => v);
  const sec = (re: RegExp) => lines(rawSec(re));
  const all = Object.entries(t.sections).filter(([k]) => !skipSec.test(k)).flatMap(([, v]) => lines(v));
  const s: SpecSummary = {};
  const set = <K extends keyof SpecSummary>(k: K, v: SpecSummary[K] | undefined) => {
    if (v && (!Array.isArray(v) || v.length)) s[k] = v;
  };
  const chip = sec(/^(chips?|processor)$/i);
  const cap = pick(sec(/^(capacity|storage)$/i), /\d\s?(GB|TB)\b/, 60, 6);
  set("capacity", cap.length ? cap : pick(chip, /^\d+\s?(GB|TB) capacity$/i, 30, 1).map((l) => l.replace(/ capacity$/i, "")));
  set("chip", [...new Set([...chip.slice(0, 1), ...pick(chip, /chip\b|core|neural|coprocessor|bit architecture/i, 80, 5)])]
    .filter((l) => !/capacity$|memory|latency|bandwidth/i.test(l)).slice(0, 6));
  set("memory", pick([...sec(/^memory$/i), ...chip.filter((l) => /unified memory/i.test(l))], /\d\s?GB/, 80, 3));
  set("display", pick(sec(/display$|^retina/i).filter((l) => !/support$/i.test(l)),
    /inch|pixel|ppi|\d\s?Hz|nits|OLED|LCD|Retina|ProMotion|Always-On|P3/i, 90, 6));
  const mp = /\d(\.\d+)?\s?(stereo\s)?(MP|-?megapixels?)\b/i;
  // Older iPads: one combined section with "FaceTime HD Camera" / "iSight Camera" sub-headings.
  const combined = { front: [] as string[], rear: [] as string[] };
  let side: "front" | "rear" = "rear";
  for (const l of sec(/^cameras, photos/i)) {
    if (/camera\b/i.test(l)) side = /facetime|front/i.test(l) ? "front" : "rear";
    combined[side].push(l);
  }
  // Macs: the only camera is the FaceTime (front) one, whatever Apple calls the section.
  const isMac = /^(mac|imac)/i.test(t.product);
  const rearSec = sec(/^(camera|cameras|rear camera|main camera|back camera|isight camera|camera system)$/i);
  const rear = isMac ? [] : [...rearSec, ...combined.rear];
  set("rear_camera", [
    ...cameras(pick(rear, mp, 200, 8)),
    ...pick(rear, /optical(-quality)? zoom/i, 200, 1).map(zoom).filter((z) => /^\d/.test(z)),
  ]);
  set("front_camera", cameras(pick([
    ...sec(/truedepth|front camera|facetime( hd)? camera/i),
    ...combined.front,
    ...(isMac ? rearSec : []),
  ], mp, 200, 2)));
  set("video", pick([...sec(/video recording/i), ...rear, ...sec(/truedepth/i)], /^(8K|4K|1080p|720p).*video recording/i, 110, 1)[0]);
  const power = sec(/battery|^power$|wireless charging|magsafe/i);
  set("battery", pick(power, /up to \d+ hours|\d\s?Wh\b|mAh|all-day/i, 80, 3));
  set("charging", pick(power.filter((l) => !/^(built-in|charging via)|cable\b|while charging|playback|connector|port\b/i.test(l)), /charging|magsafe|\bqi\b/i, 70, 3));
  set("ports", pick(sec(/charging and expansion|connector|ports|connections|interfaces|connectivity|expansion/i),
    /USB|Lightning|Thunderbolt|HDMI|Ethernet|MagSafe|SDXC|headphone|DisplayPort|Smart Connector/i, 110, 5));
  set("wireless", pick(sec(/wireless|cellular|connectivity|interfaces/i)
    .map((l) => l.replace(/^(all models|wi-fi( \+ cellular)? models?)\s*/i, ""))
    .filter((l) => !/\bbands?\s+n?\d|MHz\)|models$/i.test(l)),
    /Wi-?Fi|802\.11|Bluetooth|\b5G\b|LTE|Ultra Wideband|NFC|Thread|UMTS|GSM/i, 70, 6));
  set("sim", pick(sec(/^sim/i).map((l) => l.replace(/^wi-fi \+ cellular models?\s*/i, "")), /sim/i, 80, 1)[0]);
  set("water_resistance", pick(all, /water resistan|\bIP[4-8]\d\b|splash/i, 110, 1)[0]);
  set("sensors", pick(sec(/^sensors$/i), /./, 45, 10));
  set("size", sizes(rawSec(/size|weight|dimensions/i)));
  set("colors", pick(sec(/^(finish|finishes|colors?)$/i).filter((l) => !/design$|shield|glass|(front|back)$/i.test(l)), /^[A-Z][\w() -]+$/, 30, 10));
  // Drop lines another line already contains ("USB-C connector" vs "USB-C connector with support for: ...").
  for (const v of Object.values(s)) if (Array.isArray(v)) {
    const keep = v.filter((l, i) => !v.some((o, j) => j !== i && o.length > l.length && o.startsWith(l)));
    v.splice(0, v.length, ...keep);
  }
  return s;
}

export class TechSpecsLookup {
  private refreshed = false;
  private keys: IndexKeys = [];
  private choices = new Map<string, string>();
  private constructor(private cache: Cache) {
    this.indexKeys();
  }

  private indexKeys() {
    this.keys = Object.keys(this.cache.index).map((k) => [norm(k), k] as const);
    this.choices = chipChoices(this.keys);
  }

  /** Re-read the family indexes (once per run) and merge: a partial response never drops products. */
  private async refreshIndex() {
    if (this.refreshed) return;
    this.refreshed = true;
    const idx = await loadIndex();
    if (!Object.keys(idx).length) return;
    this.cache.index = { ...this.cache.index, ...idx };
    this.cache.index_at = new Date().toISOString();
    this.indexKeys();
  }

  static load(): TechSpecsLookup {
    let cache: Cache = { index: {}, specs: {}, ...readCache<Partial<Cache>>(CONFIG.techspecs.cache) };
    if (cache.version !== CACHE_VERSION) cache = { version: CACHE_VERSION, index: cache.index, index_at: cache.index_at, specs: {} };
    return new TechSpecsLookup(cache);
  }

  /** Specs for a firmware marketing name (null when Apple has no matching page). */
  async forName(name: string, cellular?: boolean): Promise<TechSpecs | null> {
    const fresh = this.cache.index_at && Date.now() - Date.parse(this.cache.index_at) < CONFIG.techspecs.index_max_age_days * 864e5;
    if (!fresh || !this.keys.length) await this.refreshIndex();
    let entry = match(this.keys, this.choices, name, cellular);
    // Unknown name: Apple may have added the product (or a previous index fetch came back partial).
    if (!entry && !this.refreshed) { await this.refreshIndex(); entry = match(this.keys, this.choices, name, cellular); }
    if (!entry) return null;
    return this.forEntry(entry, name);
  }

  /**
   * Apple's "(Nth generation)" pages for a product line, as generation -> index entry. Several
   * entries can name one generation ("iPod touch 16 GB (5th generation, Mid 2013)"); the plainest wins.
   */
  async generations(base: string): Promise<Map<number, string>> {
    if (!this.keys.length) await this.refreshIndex();
    const b = norm(base), out = new Map<number, string>();
    for (const [n, k] of this.keys) {
      if (!n.startsWith(b + " ")) continue;
      const g = /\((\d+)(?:st|nd|rd|th) generation\b/.exec(n);
      if (!g) continue;
      const cur = out.get(Number(g[1]));
      if (!cur || k.length < cur.length) out.set(Number(g[1]), k);
    }
    return out;
  }

  /** Specs for one index entry (a product hub). */
  async forEntry(entry: string, label = entry): Promise<TechSpecs | null> {
    if (!(entry in this.cache.index)) return null;
    if (entry in this.cache.specs) return this.cache.specs[entry];
    let specs: TechSpecs | null = null;
    try {
      const hub = await get(this.cache.index[entry]);
      // Every hub has Apple's product thumbnail (even products too old for a Tech Specs article).
      const thumb = /class="product-thumbnail"[^>]*src="([^"]+)"/.exec(hub.html)?.[1];
      const thumbnail = thumb ? decode(thumb).replace(/size=\d+x\d+/, "size=480x480") : null;
      // Hub page -> its "Tech Specs" link.
      let href: string | undefined;
      for (const m of hub.html.matchAll(/<a\b([^>]*?)>([\s\S]{0,200}?)<\/a>/g)) {
        if (/^(Tech Specs|Technical Specifications)$/i.test(decode(m[2]))) { href = /href="([^"]+)"/.exec(m[1])?.[1]; break; }
      }
      if (href) {
        const page = await get(new URL(href, hub.url).toString());
        specs = parseSpecs(page.html, page.url);
      }
      // The index name is Apple's canonical one ("iPod touch (1st Generation)"); old spec pages often
      // title themselves generically ("iPod touch").
      if (specs && /generation/i.test(entry) && !/generation/i.test(specs.product)) specs.product = entry;
      if (thumbnail) {
        if (specs) { if (!specs.images.length) specs.images = [thumbnail]; }
        else specs = { product: entry, url: hub.url, year_introduced: null, images: [thumbnail], sections: {} };
      }
    } catch (e) {
      console.error(`\nwarning: tech specs ${label}: ${errorMessage(e)}`);
      return null; // don't cache transient failures
    }
    this.cache.specs[entry] = specs;
    return specs;
  }

  save() {
    if (CONFIG.techspecs.cache) writeJson(CONFIG.techspecs.cache, this.cache);
  }
}
