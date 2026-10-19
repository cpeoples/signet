/**
 * Observed signing windows. Apple publishes no signing end date, so we record what TSS says on
 * every run: first and last time a build was seen signed and when it was first seen unsigned.
 * Run the checker on a schedule (e.g. hourly cron) and the window narrows to that interval.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJson } from "./util.js";

export interface Observation {
  version: string;
  build: string;
  first_seen_signed: string | null;
  last_seen_signed: string | null;
  first_seen_unsigned: string | null; // set when a previously-signed build stops being signed
  first_checked?: string;
  last_checked: string;
  last_signing: string;
}

/** Signing window summary for output. */
export interface SigningWindow {
  observed_signed_since: string | null;
  last_seen_signed: string | null;
  /** Signing ended somewhere between last_seen_signed and this time. */
  unsigned_detected_at: string | null;
  first_checked: string | null;
  last_checked: string;
  note?: string;
}

export class History {
  private data: Record<string, Observation> = {};
  // Read strictly, unlike the caches: a corrupt history file must not be silently replaced.
  constructor(private path: string) {
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8"));
  }

  record(url: string, version: string, build: string, signing: string, now: string): void {
    if (signing === "unknown") { // don't let a failed check rewrite history
      if (this.data[url]) this.data[url].last_checked = now;
      return;
    }
    const o = this.data[url] ?? {
      version, build, first_seen_signed: null, last_seen_signed: null, first_seen_unsigned: null,
      first_checked: now, last_checked: now, last_signing: signing,
    };
    o.first_checked ??= now;
    if (signing === "signed") {
      o.first_seen_signed ??= now;
      o.last_seen_signed = now;
      o.first_seen_unsigned = null; // re-signed (Apple occasionally does this)
    } else if (signing === "unsigned" && o.last_seen_signed && !o.first_seen_unsigned) {
      o.first_seen_unsigned = now;
    }
    o.last_checked = now;
    o.last_signing = signing;
    this.data[url] = o;
  }

  window(url: string): SigningWindow | null {
    const o = this.data[url];
    if (!o) return null;
    const w: SigningWindow = {
      observed_signed_since: o.first_seen_signed,
      last_seen_signed: o.last_seen_signed,
      unsigned_detected_at: o.first_seen_unsigned,
      first_checked: o.first_checked ?? null,
      last_checked: o.last_checked,
    };
    if (!o.first_seen_signed && o.last_signing === "unsigned") w.note = "already unsigned when first checked";
    return w;
  }

  save(): void {
    writeJson(this.path, this.data);
  }
}
