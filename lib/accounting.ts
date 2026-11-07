// Accounting helpers used by the screens (pure, tested in accounting.test.ts). Money is kept in paise (integers),
// exactly like the database, so totals never drift. The database repeats the balance rule; this is for instant
// feedback before saving.
export type Line = { account: string; debit: number; credit: number; note?: string };

/** "1,250.50" or "₹ 1250.5" → 125050 paise; null if not a valid amount (max 2 decimals, up to ₹10 crore). */
export function toPaise(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [r, p = ""] = t.split(".");
  const v = Number(r) * 100 + Number((p + "00").slice(0, 2));
  return v > 0 && v <= 100_000_000_00 ? v : null;
}

/** 125050 → "₹1,250.50" (Indian digit grouping). */
export function formatINR(paise: number): string {
  const neg = paise < 0;
  const a = Math.abs(Math.round(paise));
  const r = Math.floor(a / 100).toString();
  const p = String(a % 100).padStart(2, "0");
  const last3 = r.slice(-3);
  const rest = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}₹${rest ? rest + "," : ""}${last3}.${p}`;
}

export const totalDebit = (lines: Line[]) => lines.reduce((s, l) => s + l.debit, 0);
export const totalCredit = (lines: Line[]) => lines.reduce((s, l) => s + l.credit, 0);
/** The same rule the database enforces at posting: ≥2 lines, each one-sided, debits = credits > 0. */
export function isBalanced(lines: Line[]): boolean {
  if (lines.length < 2) return false;
  if (lines.some((l) => l.debit < 0 || l.credit < 0 || (l.debit > 0) === (l.credit > 0))) return false;
  const d = totalDebit(lines);
  return d > 0 && d === totalCredit(lines);
}

export type MoneyAccount = "CASH" | "BANK" | "CARD";
/** A personal income or expense as two balanced lines. */
export function simpleEntry(kind: "income" | "expense", amount: number, money: MoneyAccount, category: string): Line[] {
  return kind === "expense"
    ? [{ account: category, debit: amount, credit: 0 }, { account: money, debit: 0, credit: amount }]
    : [{ account: money, debit: amount, credit: 0 }, { account: category, debit: 0, credit: amount }];
}

export const PERSONAL_EXPENSES = ["HOUSEHOLD", "BILLS", "FOOD", "TRAVEL", "HEALTH", "EDUCATION", "OTHER_EXPENSE"] as const;
export const PERSONAL_INCOME = ["SALARY", "OTHER_INCOME"] as const;

const GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** GSTIN format and check digit (15 characters; the last one is computed from the first 14). */
export function gstinValid(g: string): boolean {
  const s = g.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const prod = GST_CHARS.indexOf(s[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36] === s[14];
}

export type InvoiceItem = { qty: number; ratePaise: number; discountPaise?: number };
export type InvoiceFields = { items: InvoiceItem[]; cgstPaise: number; sgstPaise: number; igstPaise: number; grandTotalPaise: number; gstin?: string };
export type InvoiceIssue = "items_total_mismatch" | "cgst_sgst_differ" | "igst_with_cgst" | "bad_gstin" | "no_items";
/**
 * Checks an invoice read by OCR before anything is posted: items + taxes must equal the grand total (within ₹1 for
 * rounding), CGST must equal SGST, IGST cannot appear with CGST/SGST, and the GSTIN must pass its check digit.
 */
export function checkInvoice(f: InvoiceFields): InvoiceIssue[] {
  const out: InvoiceIssue[] = [];
  if (!f.items.length) out.push("no_items");
  const items = f.items.reduce((s, i) => s + Math.round(i.qty * i.ratePaise) - (i.discountPaise ?? 0), 0);
  const total = items + f.cgstPaise + f.sgstPaise + f.igstPaise;
  if (f.items.length && Math.abs(total - f.grandTotalPaise) > 100) out.push("items_total_mismatch");
  if (f.cgstPaise !== f.sgstPaise) out.push("cgst_sgst_differ");
  if (f.igstPaise > 0 && (f.cgstPaise > 0 || f.sgstPaise > 0)) out.push("igst_with_cgst");
  if (f.gstin && !gstinValid(f.gstin)) out.push("bad_gstin");
  return out;
}

/** A sales invoice as a balanced business entry (receivable against sales and output GST). */
export function salesEntry(taxablePaise: number, cgst: number, sgst: number, igst: number): Line[] {
  const lines: Line[] = [{ account: "RECEIVABLES", debit: taxablePaise + cgst + sgst + igst, credit: 0 }, { account: "SALES", debit: 0, credit: taxablePaise }];
  if (cgst) lines.push({ account: "OUTPUT_CGST", debit: 0, credit: cgst });
  if (sgst) lines.push({ account: "OUTPUT_SGST", debit: 0, credit: sgst });
  if (igst) lines.push({ account: "OUTPUT_IGST", debit: 0, credit: igst });
  return lines;
}
