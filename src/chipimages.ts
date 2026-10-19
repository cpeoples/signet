/**
 * Chip photos from Wikimedia Commons, via each chip's English Wikipedia article ("Apple T2" ->
 * File:Apple_T2_APL1027.jpg). Third-party: used only for the picture, always with its author and
 * license (Commons images are CC-licensed and require attribution).
 *
 * The chip name comes from first-party data (Apple Tech Specs "A18 Pro chip", or the T2 family).
 * Redirects to umbrella articles ("Apple S9" -> "Apple silicon") are rejected so a chip never
 * shows another chip's photo.
 */
import { CONFIG } from "./config.js";
import { fetchRetry } from "./retry.js";

export interface ChipImage {
  chip: string;
  image: string;
  /** Commons file page (credit link). */
  file_url: string;
  artist: string | null;
  license: string | null;
  license_url: string | null;
  article: string;
  source: "Wikimedia Commons (third-party)";
}

/** "A18 Pro chip", "Apple M4 chip with 10-core CPU", "S9 SiP" -> "A18 Pro", "M4", "S9". */
export function chipName(line: string | undefined): string | null {
  const m = /\b([AMSTHUWR]\d{1,2}[XZ]?(?: (?:Pro|Max|Ultra|Bionic|Fusion))*)\b/.exec(line ?? "");
  return m ? m[1].replace(/ (Bionic|Fusion)$/, "") : null;
}

/** MediaWiki's limit on titles per query. */
const MAX_TITLES = 50;

const strip = (html: string | undefined) => html?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;

async function api(params: Record<string, string>): Promise<any> {
  const u = new URL(CONFIG.chip_images.api);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", ...params })) u.searchParams.set(k, v);
  const r = await fetchRetry(u.toString(), { headers: { "User-Agent": CONFIG.chip_images.user_agent } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${u.host}`);
  return r.json();
}

/** chip name -> photo (missing = no article, no photo, or only an umbrella article). */
export async function chipImages(chips: Iterable<string>): Promise<Map<string, ChipImage>> {
  const out = new Map<string, ChipImage>();
  const names = [...new Set(chips)];
  const fileFor = new Map<string, { chip: string; article: string }[]>();
  for (let i = 0; i < names.length; i += MAX_TITLES) {
    const batch = names.slice(i, i + MAX_TITLES);
    const j = await api({ action: "query", redirects: "1", prop: "pageimages", piprop: "name", titles: batch.map((c) => `Apple ${c}`).join("|") });
    // Follow normalizations and redirects back to every chip that asked ("M2 Pro" and "M2 Max" both land on "Apple M2").
    const back = new Map<string, string[]>(batch.map((c) => [`Apple ${c}`, [c]]));
    const via = (from: string, to: string) => { if (back.has(from)) back.set(to, [...(back.get(to) ?? []), ...back.get(from)!]); };
    for (const n of j.query?.normalized ?? []) via(n.from, n.to);
    for (const r of j.query?.redirects ?? []) via(r.from, r.to);
    for (const p of j.query?.pages ?? []) {
      if (!p.pageimage) continue;
      for (const chip of back.get(p.title) ?? []) {
        // "Apple A18" for "A18 Pro" is fine (same die family); "Apple silicon" for "S9" is not.
        const base = /^[A-Z]\d+/.exec(chip)![0];
        if (!new RegExp(`^Apple ${base}\\b`).test(p.title)) continue;
        const k = `File:${p.pageimage}`;
        fileFor.set(k, [...(fileFor.get(k) ?? []), { chip, article: p.title }]);
      }
    }
  }
  const files = [...fileFor.keys()];
  for (let i = 0; i < files.length; i += MAX_TITLES) {
    const j = await api({ action: "query", prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "480", titles: files.slice(i, i + MAX_TITLES).join("|") });
    const back = new Map<string, string>(files.map((f) => [f, f]));
    for (const n of j.query?.normalized ?? []) back.set(n.to, n.from);
    for (const p of j.query?.pages ?? []) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const md = ii.extmetadata ?? {};
      for (const req of fileFor.get(back.get(p.title) ?? p.title) ?? []) {
        out.set(req.chip, {
          chip: req.chip,
          image: String(ii.thumburl ?? ii.url).split("?")[0],
          file_url: ii.descriptionurl,
          artist: strip(md.Artist?.value),
          license: strip(md.LicenseShortName?.value),
          license_url: md.LicenseUrl?.value ?? null,
          article: req.article,
          source: "Wikimedia Commons (third-party)",
        });
      }
    }
  }
  return out;
}
