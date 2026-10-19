// Replaces the theme's search.js (same export and modal markup) with a device search.
import { lock, unlock } from "./scroll-lock.js";

let DATA = null;
let loading = null;

function loadIndex() {
  const url = document.querySelector('meta[name="search-index-url"]')?.content || "/index.json";
  loading ??= fetch(url, { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((d) => {
      DATA = { devices: d.devices || [], families: d.families || [], pages: d.pages || [], badges: d.badges || {} };
      for (const x of DATA.devices) {
        // Also match the model without its comma ("iphone171").
        x._hay = [x.t, x.i, x.i.replace(",", ""), x.b, x.bd, x.v, x.f].join(" ").toLowerCase();
        x._title = x.t.toLowerCase();
        x._ids = [x.i, x.b, x.bd].map((v) => v.toLowerCase());
      }
      for (const p of DATA.pages) p._title = p.t.toLowerCase();
    });
  return loading;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const compile = (q) => q.toLowerCase().split(/\s+/).filter(Boolean).map((t) => ({
  t,
  word: new RegExp("(^|[\\s,(])" + escRe(t)),
  mark: new RegExp("(" + escRe(esc(t)) + ")", "ig"),
}));

function hl(text, ts) {
  let out = esc(text);
  for (const { mark } of ts) out = out.replace(mark, "<mark>$1</mark>");
  return out;
}

function score(x, ts) {
  let total = 0;
  for (const { t, word } of ts) {
    let s = 0;
    if (x._ids.includes(t)) s += 60;
    if (word.test(x._title)) s += 30;
    else if (x._title.includes(t)) s += 15;
    else if (word.test(x._hay)) s += 10;
    else if (x._hay.includes(t)) s += 4;
    if (!s) return 0;
    total += s;
  }
  // Break ties by newest hardware, then shorter title, then signed.
  return total + (x.r || 0) / 1e5 - x.t.length / 1e4 + (x.s === "signed" ? 0.00005 : 0);
}

// Badge markup comes from layouts/_partials/signet/badge.html via index.json.
const badge = (s) => DATA.badges[s] ?? DATA.badges.unknown ?? "";
const thumb = (x) => `<span class="sg-sr__img">${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy" decoding="async">` : `<span>${esc(x.i[0])}</span>`}</span>`;

function buildModal() {
  const root = document.createElement("div");
  root.className = "site-search sg-search";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Search devices");
  root.innerHTML = `
    <div class="site-search__panel">
      <div class="site-search__input-row">
        <svg class="site-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="site-search__input" type="search" placeholder="iPhone 16 Pro, iPhone17,1, d93ap, 24A446…" aria-label="Search devices" role="combobox" aria-controls="site-search-results" aria-autocomplete="list" aria-expanded="false" autocomplete="off" spellcheck="false">
        <kbd class="site-search__esc">esc</kbd>
      </div>
      <ul class="site-search__results" id="site-search-results" role="listbox" aria-label="Search results"></ul>
      <p class="site-search__empty" hidden>No devices match. Try a model number like <code>iPhone17,1</code>.</p>
      <div class="site-search__footer">
        <span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> navigate</span>
        <span><kbd>&crarr;</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`;
  document.body.appendChild(root);
  return root;
}

export function initSearch() {
  let modal, input, results, empty;
  let active = -1, isOpen = false, lastTrigger = null;

  const items = () => results.querySelectorAll(".site-search__result");
  const setActive = (i) => {
    const els = items();
    active = Math.max(0, Math.min(i, els.length - 1));
    els.forEach((el, n) => {
      el.classList.toggle("is-active", n === active);
      el.setAttribute("aria-selected", String(n === active));
    });
    const el = els[active];
    if (el) { input.setAttribute("aria-activedescendant", el.id); el.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const render = (html) => { results.innerHTML = html; setActive(0); };

  const option = (i, href, inner, cls = "site-search__result") =>
    `<li><a class="${cls}" href="${esc(href)}" id="site-search-opt-${i}" role="option" aria-selected="false">${inner}</a></li>`;

  const row = (i, x, ts) => option(i, x.u, `
      ${thumb(x)}
      <span class="sg-sr__body">
        <span class="sg-sr__title">${hl(x.t, ts)}</span>
        <span class="sg-sr__meta"><code>${hl(x.i, ts)}</code>${x.b ? ` · ${hl(x.b, ts)}` : ""}${x.v ? ` · ${esc(x.v)} <span class="sg-mono">(${hl(x.bd, ts)})</span>` : ""}</span>
      </span>
      ${badge(x.s)}`, "site-search__result sg-sr");

  const emptyState = () => {
    empty.hidden = true;
    const fams = DATA?.families || [];
    if (!fams.length) { results.innerHTML = ""; return; }
    render(`<li class="site-search__hint" role="presentation">Type a name, model number, board or build, or jump to a family</li>` +
      fams.map((f, i) => option(i, f.u, `
          <span class="site-search__result-title">${esc(f.t)}</span>
          <span class="site-search__result-section">${f.n} models · ${f.s} signed</span>`)).join(""));
  };

  const onQuery = (q) => {
    if (!q.trim()) return emptyState();
    if (!DATA) return;
    const ts = compile(q);
    const hits = DATA.devices.map((x) => [score(x, ts), x]).filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0]).slice(0, 14).map(([, x]) => x);
    const pageHits = DATA.pages.filter((p) => ts.every(({ t }) => p._title.includes(t)));
    if (!hits.length && !pageHits.length) { results.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    render(hits.map((x, i) => row(i, x, ts)).join("") + pageHits.map((p, j) => option(hits.length + j, p.u, `
        <span class="site-search__result-title">${hl(p.t, ts)}</span>
        ${p.d ? `<span class="site-search__result-desc">${esc(p.d)}</span>` : ""}`)).join(""));
  };

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const el = items()[active]; if (el) location.href = el.href; }
    else if (e.key === "Tab") e.preventDefault();
  };

  const open = (trigger) => {
    if (isOpen) return;
    if (!modal) {
      modal = buildModal();
      input = modal.querySelector(".site-search__input");
      results = modal.querySelector(".site-search__results");
      empty = modal.querySelector(".site-search__empty");
      input.addEventListener("input", () => onQuery(input.value));
      input.addEventListener("keydown", onKey);
      modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    }
    lastTrigger = trigger || document.activeElement;
    loadIndex().then(() => { if (isOpen) onQuery(input.value); });
    modal.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    lock();
    isOpen = true;
    setTimeout(() => input.focus(), 30);
  };

  const close = () => {
    if (!modal || !isOpen) return;
    modal.classList.remove("is-open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    unlock();
    isOpen = false;
    active = -1;
    lastTrigger?.focus?.();
    lastTrigger = null;
  };

  for (const b of document.querySelectorAll("[data-search-trigger], [data-search-open]")) b.addEventListener("click", () => open(b));
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
    else if (e.key === "/" && !isOpen) { e.preventDefault(); open(); }
  });
}
