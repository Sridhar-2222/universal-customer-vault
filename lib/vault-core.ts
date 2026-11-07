// Universal Customer Vault: smart filing core (business-neutral, dependency-free). Shared with Rx Fingertip.
// used by Rx Fingertip (src/lib/customer-vault.ts adds pharmacy word rules) and by the separate generic package
// (packages/universal-vault/src/vault-core.ts must stay byte-identical; a test checks it).
// Input is text read ON THE PHONE from a photo (OCR); nothing here sends anything anywhere.

export type KindRule = { kind: string; words: RegExp[] };

/** The document kind whose words appear most often; ties go to the earlier rule; none found → fallback. */
export function guessKind(text: string, rules: readonly KindRule[], fallback = "other"): string {
  let best = fallback;
  let bestScore = 0;
  for (const r of rules) {
    let score = 0;
    for (const w of r.words) {
      const g = new RegExp(w.source, w.flags.includes("g") ? w.flags : w.flags + "g");
      score += (text.match(g) ?? []).length;
    }
    if (score > bestScore) { best = r.kind; bestScore = score; }
  }
  return best;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");
function iso(y: number, m: number, d: number, latest: Date): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000 || dt.getTime() > latest.getTime()) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * The first plausible document date in the text, as YYYY-MM-DD. Indian order (day first) for numeric dates:
 * 05/11/2026, 5-11-26, 05.11.2026; also "5 Nov 2026", "Nov 5, 2026". Dates after tomorrow or before 2000 are
 * ignored (they are usually expiry dates or noise). Null when none is found.
 */
export function findDocDate(text: string, today = new Date()): string | null {
  const latest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const found: { at: number; iso: string }[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const v = iso(Number(m[3]), Number(m[2]), Number(m[1]), latest);
    if (v) found.push({ at: m.index ?? 0, iso: v });
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})\b/g)) {
    const mo = MONTHS[m[2]!.slice(0, m[2]!.toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
    const v = mo ? iso(Number(m[3]), mo, Number(m[1]), latest) : null;
    if (v) found.push({ at: m.index ?? 0, iso: v });
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})[\s.]+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[1]!.slice(0, m[1]!.toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
    const v = mo ? iso(Number(m[3]), mo, Number(m[2]), latest) : null;
    if (v) found.push({ at: m.index ?? 0, iso: v });
  }
  found.sort((a, b) => a.at - b.at);
  return found[0]?.iso ?? null;
}

/** Text kept with a file: spaces tidied, at most `max` characters (the database allows 8000). */
export function cleanText(text: string, max = 8000): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

/** "Report · 05 Nov 2026", or just the kind when no date was found. */
export function suggestTitle(kindLabel: string, isoDate: string | null): string {
  if (!isoDate) return kindLabel;
  const [y, m, d] = isoDate.split("-");
  const mon = Object.keys(MONTHS).find((k) => MONTHS[k] === Number(m) && k.length === 3) ?? m;
  return `${kindLabel} · ${d} ${mon!.charAt(0).toUpperCase()}${mon!.slice(1)} ${y}`;
}

/** Every word of the query appears somewhere in the given fields (case-insensitive). Empty query matches all. */
export function textMatches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join(" \n ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A short piece of the text around the first query word, for showing why a file matched. */
export function snippet(text: string | null | undefined, query: string, radius = 40): string {
  if (!text) return "";
  const w = query.toLowerCase().split(/\s+/).find(Boolean);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!w) return flat.slice(0, radius * 2);
  const i = flat.toLowerCase().indexOf(w);
  if (i < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, i + w.length + radius)}${i + w.length + radius < flat.length ? "…" : ""}`;
}
