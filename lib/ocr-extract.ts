// Document-intelligence layer: turns OCR text lines (with positions and confidence, from any engine: PaddleOCR,
// Tesseract or a PDF's own text) into invoice fields with a confidence for each, plus warnings. It never posts
// anything: the result becomes an invoice in 'review' that a person checks against the paper and approves.
// Pure and tested in ocr-extract.test.ts (synthetic layouts) and scripts/ocr-bench (rendered images).
import { gstinValid } from "./accounting";
import { GST_RATES, invoiceIssues, type InvoiceDraft, type InvoiceKind, type ItemDraft } from "./invoice";

export type OcrLine = { text: string; conf: number; box: [number, number, number, number] }; // x0, y0, x1, y1
export type OcrPage = { width: number; height: number; lines: OcrLine[]; engine?: string; rotation?: number };
export type OcrResult = { pages: OcrPage[]; warnings?: string[]; engine?: string; ms?: number };
export type Confidence = Record<string, number>; // field → 0..1 (party, gstin, number, date, due, total, cgst, sgst, igst, item0…)
export type Extraction = { draft: InvoiceDraft; confidence: Confidence; warnings: string[]; sellerGstin: string | null; buyerGstin: string | null; text: string };

type Row = { segs: OcrLine[]; text: string; conf: number; y0: number; y1: number; page: number };

// ---------- rows ----------
/** Groups OCR boxes into visual rows (left to right), page after page. */
export function toRows(r: OcrResult): Row[] {
  const rows: Row[] = [];
  let offset = 0;
  r.pages.forEach((p, pi) => {
    const lines = p.lines.filter((l) => l.text.trim()).map((l) => ({ ...l, box: [l.box[0], l.box[1] + offset, l.box[2], l.box[3] + offset] as OcrLine["box"] }))
      .sort((a, b) => (a.box[1] + a.box[3]) / 2 - (b.box[1] + b.box[3]) / 2);
    const pageRows: Row[] = [];
    for (const l of lines) {
      const h = l.box[3] - l.box[1];
      const row = pageRows.find((rw) => Math.min(rw.y1, l.box[3]) - Math.max(rw.y0, l.box[1]) > 0.5 * Math.min(h, rw.y1 - rw.y0));
      if (row) { row.segs.push(l); row.y0 = Math.min(row.y0, l.box[1]); row.y1 = Math.max(row.y1, l.box[3]); }
      else pageRows.push({ segs: [l], text: "", conf: 0, y0: l.box[1], y1: l.box[3], page: pi });
    }
    for (const rw of pageRows) {
      rw.segs.sort((a, b) => a.box[0] - b.box[0]);
      rw.text = rw.segs.map((s) => s.text.trim()).join("  ");
      rw.conf = rw.segs.reduce((s, x) => s + x.conf, 0) / rw.segs.length;
    }
    rows.push(...pageRows.sort((a, b) => a.y0 - b.y0));
    offset += p.height + 50;
  });
  return rows;
}

// ---------- numbers ----------
/** OCR digit look-alikes inside number-like tokens (O→0, l/I/|→1, S→5, B→8) — only when the token is mostly digits. */
function fixDigits(tok: string): string {
  const digits = (tok.match(/\d/g) ?? []).length;
  const letters = tok.replace(/[^A-Za-z]/g, "");
  // only tokens whose letters are all digit look-alikes ("8,26O.00", "l00"), never words like "Nov"
  if (!letters || /[^OolISB]/.test(letters) || digits < Math.max(1, tok.replace(/[^A-Za-z0-9]/g, "").length * 0.6)) return tok;
  return tok.replace(/[Oo]/g, "0").replace(/[lI|]/g, "1").replace(/S/g, "5").replace(/B/g, "8");
}
const AMOUNT = /(?<![\w.%/-])(?:₹|rs\.?|inr)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)(?:\s*\/-)?(?![\w%/]|\.\d|-\d)/gi;
/** Paise amounts in a piece of text, left to right (percentages, dates and long IDs are skipped). */
export function amountsIn(text: string): number[] {
  const t = text.split(/\s+/).map((tok) => { const m = tok.match(/^(₹|rs\.?|inr)(.+)$/i); return m ? m[1] + fixDigits(m[2]!) : fixDigits(tok); }).join(" ");
  const out: number[] = [];
  // Blurred photos often turn grouping commas into dots: "17.161.90", "2.450.00" → 17,161.90 / 2,450.00
  // (only when every group but the last has 2-3 digits and the last has exactly 2: real amounts, not dates).
  const fixedSeparators = t.replace(/(?<![\d.,])(\d{1,3}(?:[.,]\d{2,3})+)[.,](\d{2})(?![\d.,])/g, (_, a: string, b: string) => `${a.replace(/[.,]/g, ",")}.${b}`);
  for (const m of fixedSeparators.matchAll(AMOUNT)) {
    const raw = m[1]!.replace(/,/g, "");
    if (raw.replace(".", "").length > 11) continue;
    out.push(Math.round(Number(raw) * 100));
  }
  return out;
}
export function parseAmount(text: string): number | null { const a = amountsIn(text); return a.length ? a[a.length - 1]! : null; }

// ---------- GSTIN ----------
const LETTER_POS = new Set([2, 3, 4, 5, 6, 11]); // PAN letters (0-based in the 15 characters)
const DIGIT_POS = new Set([0, 1, 7, 8, 9, 10]);
const toDigit: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", T: "7" };
const toLetter: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G" };
/** Repairs typical OCR confusions by position and returns a GSTIN only if its check digit passes. */
export function repairGstin(raw: string): { gstin: string; repaired: boolean } | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 15) return null;
  if (gstinValid(s)) return { gstin: s, repaired: false };
  const fixed = s.split("").map((ch, i) => (DIGIT_POS.has(i) ? toDigit[ch] ?? ch : LETTER_POS.has(i) ? toLetter[ch] ?? ch : i === 13 && ch !== "Z" && "27".includes(ch) ? "Z" : ch)).join("");
  if (gstinValid(fixed)) return { gstin: fixed, repaired: true };
  return null;
}
/** Every valid GSTIN in the rows, in reading order, with the row it was on. */
function findGstins(rows: Row[]): { gstin: string; row: number; conf: number }[] {
  const out: { gstin: string; row: number; conf: number }[] = [];
  rows.forEach((r, i) => {
    const compact = r.text.toUpperCase().replace(/GSTIN|GST\s*NO|GST|UIN|[:\s.\-]/g, "");
    for (const m of compact.matchAll(/[0-9OIDQLZSB]{2}[A-Z0-9]{5}[0-9OIDQLZSB]{4}[A-Z0-9][A-Z0-9][Z27][A-Z0-9]/g)) {
      const g = repairGstin(m[0]);
      if (g && !out.some((x) => x.gstin === g.gstin)) out.push({ gstin: g.gstin, row: i, conf: r.conf * (g.repaired ? 0.75 : 1) });
    }
  });
  return out;
}

// ---------- dates ----------
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
function isoOf(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
/** Dates in Indian order (day first): 15/10/2026, 15-10-26, 15.10.2026, 15 Oct 2026, 15-Oct-2026. */
export function datesIn(text: string): string[] {
  const out: string[] = [];
  const t = text.split(/\s+/).map(fixDigits).join(" ");
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) { const v = isoOf(+m[3]!, +m[2]!, +m[1]!); if (v) out.push(v); }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s.-]*([A-Za-z]{3})[a-z]*[\s.,-]*(\d{4}|\d{2})\b/g)) {
    const mo = MON[m[2]!.toLowerCase()]; const v = mo ? isoOf(+m[3]!, mo, +m[1]!) : null; if (v) out.push(v);
  }
  return out;
}

// ---------- labels ----------
const L = {
  number: /\b(invoice|inv|bill|voucher)\s*(no|number|num|#)\b\.?|\binvoice\s*#/i,
  date: /\b(invoice\s*date|inv\.?\s*date|bill\s*date|dated|date)\b/i,
  due: /\b(due\s*date|due\s*on|payment\s*due|pay\s*by)\b/i,
  buyer: /\b(bill(ed)?\s*to|buyer|customer|consignee|ship(ped)?\s*to|recipient|sold\s*to|party\s*name|m\/s\.?)\b/i,
  grand: /\b(grand\s*total|total\s*amount|invoice\s*total|net\s*amount|amount\s*payable|net\s*payable|total\s*payable|bill\s*amount|total\s*invoice\s*value)\b/i,
  total: /\btotal\b/i,
  taxable: /\b(taxable\s*(value|amount|amt)|sub\s*-?\s*total|assessable\s*value)\b/i,
  cgst: /\bc\s*\.?\s*g\s*\.?\s*s\s*\.?\s*t\b/i,
  sgst: /\b(s|ut)\s*\.?\s*g\s*\.?\s*s\s*\.?\s*t\b/i,
  igst: /\bi\s*\.?\s*g\s*\.?\s*s\s*\.?\s*t\b/i,
  roundOff: /\bround(ed)?\s*(off|-off)?\b/i,
  heading: /\b(tax\s*invoice|invoice|bill\s*of\s*supply|retail\s*invoice|cash\s*memo|original|duplicate|triplicate|copy|estimate)\b/i,
  address: /\b(road|rd\.?|street|st\.?|nagar|colony|plot|floor|near|opp\.?|district|dist\.?|pin|phone|ph\.?|mob(ile)?|tel|email|e-mail|www\.|state\s*code|state)\b|@|\b\d{6}\b|\+91|\b\d{10}\b/i,
};

/** "TAX INVOICE", "ORIGINAL FOR RECIPIENT" and similar short heading rows. */
const isHeading = (t: string) => L.heading.test(t) && t.replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/).length <= 4;

/** The value written after a label on the same row (or the row's next segment / the next row). */
function afterLabel(rows: Row[], i: number, re: RegExp): { text: string; conf: number } | null {
  const r = rows[i]!;
  for (let k = 0; k < r.segs.length; k++) {
    const s = r.segs[k]!;
    const m = s.text.match(re);
    if (!m) continue;
    const rest = s.text.slice((m.index ?? 0) + m[0].length).replace(/^[\s:.#-]+/, "");
    if (rest.trim()) return { text: rest.trim(), conf: s.conf };
    const next = r.segs[k + 1];
    if (next) return { text: next.text.trim(), conf: next.conf };
    const below = rows[i + 1]?.segs.find((x) => Math.abs(x.box[0] - s.box[0]) < (s.box[2] - s.box[0]) * 1.5);
    if (below) return { text: below.text.trim(), conf: below.conf * 0.9 };
  }
  return null;
}

// ---------- items table ----------
type Col = "desc" | "hsn" | "qty" | "rate" | "disc" | "gst" | "amount" | "sn" | "unit";
const HEAD: [Col, RegExp][] = [
  ["sn", /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|#|no\.?)$/i],
  ["desc", /\b(description|particulars|item|items|product|goods|services|name of (the )?(product|goods|item))\b/i],
  ["hsn", /\b(hsn|sac)\b/i],
  ["qty", /\b(qty|quantity|qnty|nos)\b/i],
  ["unit", /^(unit|uom|per)$/i],
  ["rate", /\b(rate|price|unit\s*price|mrp)\b/i],
  ["disc", /\b(disc|discount)\b/i],
  ["gst", /\b(gst\s*%|gst\s*rate|tax\s*%|tax\s*rate|gst)\b/i],
  ["amount", /\b(amount|amt|value|total|taxable)\b/i],
];
function headerOf(r: Row): { col: Col; x: number }[] | null {
  const found: { col: Col; x: number }[] = [];
  for (const s of r.segs) {
    const words = s.text.split(/\s{2,}/);
    const w = (s.box[2] - s.box[0]) / Math.max(1, s.text.length);
    let pos = s.box[0];
    for (const word of words) {
      const hit = HEAD.find(([c, re]) => re.test(word.trim()) && !found.some((f) => f.col === c));
      if (hit) found.push({ col: hit[0], x: pos + (word.length * w) / 2 });
      pos += (word.length + 2) * w;
    }
  }
  const named = new Set(found.map((f) => f.col));
  return named.has("desc") && (named.has("qty") || named.has("rate")) && named.has("amount") ? found.sort((a, b) => a.x - b.x) : null;
}
const STOP_TABLE = /\b(sub\s*-?\s*total|total|taxable\s*value|cgst|sgst|igst|utgst|round|amount\s*in\s*words|rupees|grand|bank|terms|declaration|e\.?\s*&\s*o\.?\s*e)\b/i;

function readItems(rows: Row[], conf: Confidence): { items: ItemDraft[]; end: number } {
  const hi = rows.findIndex((r) => headerOf(r));
  if (hi < 0) return { items: [], end: -1 };
  const cols = headerOf(rows[hi]!)!;
  const items: ItemDraft[] = [];
  let i = hi + 1;
  for (; i < rows.length && items.length < 200; i++) {
    const r = rows[i]!;
    if (STOP_TABLE.test(r.text) && !/[a-z]{4,}.*\d+\s*(nos|pcs|kg|ltr|box|mtr)/i.test(r.text)) break;
    const cell: Partial<Record<Col, string>> = {};
    for (const s of r.segs) {
      const xc = (s.box[0] + s.box[2]) / 2;
      const near = cols.reduce((a, b) => (Math.abs(b.x - xc) < Math.abs(a.x - xc) ? b : a));
      // long text belongs to the description even when it starts left of the column centre
      const col = /[A-Za-z]{3,}/.test(s.text) && !/^\d/.test(s.text.trim()) && cols.some((c) => c.col === "desc") ? "desc" : near.col;
      cell[col] = cell[col] ? `${cell[col]} ${s.text.trim()}` : s.text.trim();
    }
    const desc = (cell.desc ?? "").replace(/^\d+[.)]?\s+/, "").trim();
    const nums = (k: Col) => (cell[k] ? amountsIn(cell[k]!) : []);
    const qtyText = fixDigits((cell.qty ?? "").replace(/[a-z]+/gi, " ").trim());
    let qty = /^\d+(\.\d{1,3})?$/.test(qtyText) ? Number(qtyText) : NaN;
    let rate = nums("rate").at(-1) ?? NaN;
    const amount = nums("amount").at(-1) ?? NaN;
    const disc = nums("disc").at(-1) ?? 0;
    if (!desc) continue; // blank, noise, or a stray number
    if (Number.isNaN(amount) && Number.isNaN(rate)) {
      if (items.length) items[items.length - 1]!.description += ` ${desc}`; // wrapped description
      continue;
    }
    if (Number.isNaN(qty)) qty = 1;
    if (Number.isNaN(rate) && !Number.isNaN(amount)) rate = Math.round((amount + disc) / qty);
    const hsn = (cell.hsn ?? "").replace(/\D/g, "");
    const gst = cell.gst ? Number((cell.gst.match(/\d+(\.\d+)?/) ?? [""])[0]) : NaN;
    const item: ItemDraft = { description: desc.slice(0, 200), hsn: /^\d{4,8}$/.test(hsn) ? hsn : undefined, qty, ratePaise: rate, discountPaise: disc,
      gstRate: (GST_RATES as readonly number[]).includes(gst) ? gst : null };
    const fits = !Number.isNaN(amount) && Math.abs(Math.round(qty * rate) - disc - amount) <= Math.max(100, amount * 0.005);
    // when qty×rate disagrees with the printed amount, trust the amount (the line total is what adds up)
    if (!Number.isNaN(amount) && !fits) { item.qty = 1; item.ratePaise = amount + disc; }
    conf[`item${items.length}`] = r.conf * (fits ? 1 : 0.6);
    items.push(item);
  }
  return { items, end: i };
}

// ---------- main ----------
const nearestRate = (pct: number) => (GST_RATES as readonly number[]).reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));

/**
 * Reads an invoice. `myGstin` is the business's own GSTIN: if the seller's GSTIN is ours it is a sale (the party is
 * the buyer), otherwise a purchase (the party is the seller). Without it, `kindHint` decides.
 */
export function extractInvoice(ocr: OcrResult, opts: { myGstin?: string | null; kindHint?: InvoiceKind; today?: string } = {}): Extraction {
  const rows = toRows(ocr);
  const conf: Confidence = {};
  const warnings: string[] = [...(ocr.warnings ?? [])];
  const text = rows.map((r) => r.text).join("\n");
  const buyerRow = rows.findIndex((r) => L.buyer.test(r.text));

  // GSTINs: the seller's is printed first / above the buyer block; ours tells us which side we are.
  const gstins = findGstins(rows);
  const mine = opts.myGstin?.toUpperCase() ?? null;
  let seller = gstins.find((g) => buyerRow < 0 || g.row < buyerRow) ?? null;
  let buyer = gstins.find((g) => g !== seller && (buyerRow < 0 || g.row >= buyerRow)) ?? null;
  if (mine && buyer?.gstin === mine && !seller) seller = null;
  if (mine && seller && seller.gstin !== mine && gstins.some((g) => g.gstin === mine)) buyer = gstins.find((g) => g.gstin === mine)!;
  const kind: InvoiceKind = mine ? (seller?.gstin === mine ? "sale" : "purchase") : opts.kindHint ?? "purchase";
  const party = kind === "sale" ? buyer : seller;
  if (party) conf.gstin = party.conf;

  // Party name: for a purchase, the seller's name at the top (biggest plain text line before the address/GSTIN);
  // for a sale, the line after "Bill to / Buyer".
  let partyName = "", partyConf = 0;
  if (kind === "purchase") {
    const limit = Math.min(seller ? seller.row + 1 : 8, buyerRow >= 0 ? buyerRow : 8, rows.length);
    const cands = rows.slice(0, Math.max(limit, 1)).map((r, i) => ({ r, i, h: r.y1 - r.y0 }))
      .filter(({ r }) => /[A-Za-z]{3,}/.test(r.text) && !isHeading(r.text) && !L.address.test(r.text) && !/gstin|invoice\s*(no|date)|^date/i.test(r.text));
    const best = cands.sort((a, b) => b.h - a.h || a.i - b.i)[0];
    if (best) { partyName = best.r.text.replace(/\s{2,}.*$/, "").replace(/^(from|seller|supplier)\s*[:-]?\s*/i, ""); partyConf = best.r.conf * 0.95; }
  } else if (buyerRow >= 0) {
    const same = afterLabel(rows, buyerRow, L.buyer);
    const t = same && /[A-Za-z]{3,}/.test(same.text) && !L.address.test(same.text) ? same : rows[buyerRow + 1] ? { text: rows[buyerRow + 1]!.segs[0]!.text, conf: rows[buyerRow + 1]!.conf } : null;
    if (t) { partyName = t.text.replace(/^(m\/s\.?|name)\s*[:-]?\s*/i, ""); partyConf = t.conf * 0.9; }
  }
  partyName = partyName.replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  conf.party = partyName ? partyConf : 0;

  // Number, dates.
  let number = "", date = "", due: string | null = null;
  for (let i = 0; i < rows.length && !number; i++) {
    if (!L.number.test(rows[i]!.text)) continue;
    const v = afterLabel(rows, i, L.number);
    const m = v?.text.match(/[A-Z0-9][A-Z0-9/\-_.]{0,39}/i);
    if (m && /\d/.test(m[0])) { number = m[0].replace(/[.\-/]+$/, ""); conf.number = v!.conf; }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!due && L.due.test(r.text)) { const v = afterLabel(rows, i, L.due); const d = v ? datesIn(v.text)[0] : undefined; if (d) { due = d; conf.due = v!.conf; } continue; }
    if (!date && L.date.test(r.text) && !/expir|exp\.|mfg|due/i.test(r.text)) {
      const v = afterLabel(rows, i, L.date);
      const d = (v && datesIn(v.text)[0]) || datesIn(r.text)[0];
      if (d) { date = d; conf.date = (v?.conf ?? r.conf); }
    }
  }
  if (!date) { const any = rows.map((r) => ({ d: datesIn(r.text)[0], c: r.conf, t: r.text })).find((x) => x.d && !/expir|exp\.|mfg|due/i.test(x.t)); if (any) { date = any.d!; conf.date = any.c * 0.7; } }
  if (opts.today && date > opts.today) warnings.push("The bill date is in the future — check the date.");

  // Items, then the summary block (taxes and totals are read from the rows after the table).
  const { items, end } = readItems(rows, conf);
  const summary = rows.slice(Math.max(end, 0));
  const lastAmount = (re: RegExp, exclude?: RegExp) => {
    for (let i = summary.length - 1; i >= 0; i--) {
      const r = summary[i]!;
      if (!re.test(r.text) || (exclude && exclude.test(r.text))) continue;
      const a = amountsIn(r.text.replace(/@?\s*\d+(\.\d+)?\s*%/g, " "));
      if (a.length) return { v: a[a.length - 1]!, c: r.conf };
    }
    return null;
  };
  const sumTax = (re: RegExp, exclude?: RegExp) => {
    let total = 0, c = 1, found = false;
    for (const r of summary) {
      if (!re.test(r.text) || (exclude && exclude.test(r.text)) || L.total.test(r.text) && !re.test(r.text.replace(L.total, ""))) continue;
      const a = amountsIn(r.text.replace(/@?\s*\d+(\.\d+)?\s*%/g, " "));
      if (a.length) { total += a[a.length - 1]!; c = Math.min(c, r.conf); found = true; }
    }
    return found ? { v: total, c } : null;
  };
  const cg = sumTax(L.cgst), sg = sumTax(L.sgst, L.cgst), ig = sumTax(L.igst);
  const grand = lastAmount(L.grand) ?? lastAmount(L.total, /sub\s*-?\s*total|taxable|cgst|sgst|igst|qty|quantity/i);
  const taxableRow = lastAmount(L.taxable);
  let cgst = cg?.v ?? 0, sgst = sg?.v ?? 0, igst = ig?.v ?? 0;
  if (cg) conf.cgst = cg.c; if (sg) conf.sgst = sg.c; if (ig) conf.igst = ig.c;
  let total = grand?.v ?? 0;
  if (grand) conf.total = grand.c;

  // Fallback when the item table could not be read: one line with the taxable value, clearly flagged.
  let itemsOut = items;
  let itemsGuessed = false;
  const itemsTaxable = items.reduce((s, i) => s + Math.round(i.qty * i.ratePaise) - (i.discountPaise ?? 0), 0);
  if (!itemsOut.length) {
    const taxable = taxableRow?.v ?? (total ? total - cgst - sgst - igst : 0);
    if (taxable > 0) {
      itemsOut = [{ description: "As per bill (items not read)", qty: 1, ratePaise: taxable, discountPaise: 0, gstRate: null }];
      conf.item0 = 0.3;
      itemsGuessed = true;
      warnings.push("The item lines could not be read. One line with the taxable value was added — type the items or check it.");
    }
  } else if (taxableRow && Math.abs(taxableRow.v - itemsTaxable) > 100) {
    warnings.push("The items do not add up to the taxable value printed on the bill — check the item lines.");
  }

  // GST rate per item: printed in the table, or worked out from tax ÷ taxable when every item shares one rate.
  const taxSum = cgst + sgst + igst;
  const tx = itemsOut.reduce((s, i) => s + Math.round(i.qty * i.ratePaise) - (i.discountPaise ?? 0), 0);
  if (tx > 0 && taxSum > 0 && itemsOut.every((i) => i.gstRate == null)) {
    const pct = (taxSum / tx) * 100, r = nearestRate(pct);
    if (Math.abs(pct - r) < 0.15) itemsOut = itemsOut.map((i) => ({ ...i, gstRate: r }));
  }
  if (tx > 0 && taxSum === 0 && total > tx + 100) warnings.push("No CGST/SGST/IGST was found, but the total is more than the items — check the taxes.");
  if (!total && tx) { total = tx + taxSum; conf.total = 0.4; warnings.push("The grand total was not found; it was calculated — check it."); }

  const draft: InvoiceDraft = {
    kind, number, date: date || opts.today || "", dueDate: due, party: { name: partyName, gstin: party?.gstin ?? null },
    items: itemsOut, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, totalPaise: total,
  };
  if (!number) { conf.number = 0; warnings.push("Invoice number not found."); }
  if (!date) { conf.date = 0; warnings.push("Bill date not found."); }

  // Arithmetic agreement is strong evidence: when items + taxes = total and the tax matches the rates, the
  // amounts were read right even if the OCR engine was unsure about individual characters.
  const issues = invoiceIssues(draft, mine);
  if (!issues.some((x) => ["items_total_mismatch", "tax_rate_mismatch", "cgst_sgst_differ", "igst_with_cgst"].includes(x)) && total > 0) {
    const keys = itemsGuessed ? ["cgst", "sgst", "igst"] : ["total", "cgst", "sgst", "igst", ...itemsOut.map((_, i) => `item${i}`)];
    for (const k of keys) if (conf[k] != null) conf[k] = Math.max(conf[k]!, 0.9);
  }
  const mean = rows.length ? rows.reduce((s, r) => s + r.conf, 0) / rows.length : 0;
  if (rows.length && mean < 0.7) warnings.push("Much of this bill was hard to read (blurred, faint or handwritten). Check every field carefully.");
  return { draft, confidence: conf, warnings: [...new Set(warnings)], sellerGstin: seller?.gstin ?? null, buyerGstin: buyer?.gstin ?? null, text: text.slice(0, 20000) };
}
