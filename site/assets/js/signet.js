const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [u, n] of [["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  }
  return "just now";
}
function tick() {
  for (const t of document.querySelectorAll("time[data-signet-ago]")) t.textContent = ago(t.dateTime);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-copy]");
  if (!el) return;
  const head = el.querySelector(".sg-tip__head");
  const before = head?.textContent;
  try {
    await navigator.clipboard.writeText(el.dataset.copy);
  } catch {
    return; // The value is still visible in the tooltip.
  }
  el.classList.add("is-copied");
  if (head) head.textContent = "Copied to clipboard";
  setTimeout(() => { el.classList.remove("is-copied"); if (head) head.textContent = before; }, 1600);
});

function filters() {
  const grid = document.querySelector("[data-sg-grid]");
  if (!grid) return;
  const input = document.querySelector("[data-sg-filter]");
  const buttons = [...document.querySelectorAll("[data-sg-state]")];
  const empty = document.querySelector("[data-sg-empty]");
  let state = "all";
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const li of grid.children) {
      const ok = (!q || li.dataset.sgName.includes(q)) && (state === "all" || li.dataset.sgSigning === state);
      li.hidden = !ok;
      if (ok) shown++;
    }
    empty.hidden = shown > 0;
  };
  input.addEventListener("input", apply);
  for (const b of buttons) b.addEventListener("click", () => {
    state = b.dataset.sgState;
    for (const x of buttons) x.setAttribute("aria-pressed", String(x === b));
    apply();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  tick();
  setInterval(tick, 60_000);
  filters();
});
