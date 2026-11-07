// Invoice form logic (pure; tested in invoice.test.ts). Mirrors public.invoice_issues() in
// 0003_business_accounting.sql so the person sees problems instantly; the database checks again before posting.
import { gstinValid } from "./accounting";

export type InvoiceKind = "sale" | "purchase";
export type ItemDraft = { description: string; hsn?: string; qty: number; unit?: string; ratePaise: number; discountPaise?: number; gstRate?: number | null };
export type InvoiceDraft = {
  kind: InvoiceKind;
  number: string;
  date: string; // YYYY-MM-DD
  dueDate?: string | null;
  party: { name: string; gstin?: string | null; phone?: string | null };
  items: ItemDraft[];
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
};
export type Issue =
  | "no_items" | "items_total_mismatch" | "cgst_sgst_differ" | "igst_with_cgst" | "tax_rate_mismatch" | "wrong_tax_type"
  | "bad_gstin" | "duplicate_number" | "no_party" | "no_number" | "bad_date" | "bad_amount";

export const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40] as const;

export const itemTaxable = (i: ItemDraft) => Math.round(i.qty * i.ratePaise) - (i.discountPaise ?? 0);
export const taxableTotal = (d: InvoiceDraft) => d.items.reduce((s, i) => s + itemTaxable(i), 0);
export const roundOff = (d: InvoiceDraft) => d.totalPaise - taxableTotal(d) - d.cgstPaise - d.sgstPaise - d.igstPaise;
/** GST expected from the item rates (null when any item has no rate). */
export function expectedTax(d: InvoiceDraft): number | null {
  if (!d.items.length || d.items.some((i) => i.gstRate == null)) return null;
  return d.items.reduce((s, i) => s + Math.round((itemTaxable(i) * (i.gstRate ?? 0)) / 100), 0);
}
/** Suggested CGST/SGST or IGST from the rates, by whether the party is in the same state as the business. */
export function suggestTaxes(d: InvoiceDraft, businessGstin?: string | null): { cgst: number; sgst: number; igst: number } | null {
  const t = expectedTax(d);
  if (t == null) return null;
  const mine = businessGstin?.slice(0, 2), theirs = d.party.gstin?.slice(0, 2);
  if (mine && theirs && mine !== theirs) return { cgst: 0, sgst: 0, igst: t };
  const half = Math.round(t / 2); // CGST must equal SGST; an odd paisa goes to round-off
  return { cgst: half, sgst: half, igst: 0 };
}

/** Problems that block posting; same names as the database. */
export function invoiceIssues(d: InvoiceDraft, businessGstin?: string | null): Issue[] {
  const out = new Set<Issue>();
  if (!d.party.name.trim()) out.add("no_party");
  if (!d.number.trim()) out.add("no_number");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || Number.isNaN(Date.parse(d.date))) out.add("bad_date");
  if (!(d.totalPaise > 0)) out.add("bad_amount");
  if (!d.items.length) out.add("no_items");
  if (d.items.some((i) => !(i.qty > 0) || i.ratePaise < 0 || itemTaxable(i) < 0 || !i.description.trim())) out.add("bad_amount");
  if (d.items.length && Math.abs(roundOff(d)) > 100) out.add("items_total_mismatch");
  if (d.cgstPaise !== d.sgstPaise) out.add("cgst_sgst_differ");
  if (d.igstPaise > 0 && (d.cgstPaise > 0 || d.sgstPaise > 0)) out.add("igst_with_cgst");
  const exp = expectedTax(d);
  if (exp != null && Math.abs(exp - (d.cgstPaise + d.sgstPaise + d.igstPaise)) > 100) out.add("tax_rate_mismatch");
  const g = d.party.gstin?.trim();
  if (g && !gstinValid(g)) out.add("bad_gstin");
  const mine = businessGstin?.slice(0, 2), theirs = g?.slice(0, 2);
  if (mine && theirs && gstinValid(g!)) {
    if (mine === theirs && d.igstPaise > 0) out.add("wrong_tax_type");
    if (mine !== theirs && (d.cgstPaise > 0 || d.sgstPaise > 0)) out.add("wrong_tax_type");
  }
  return [...out].sort();
}

export const issueText: Record<Issue, string> = {
  no_items: "Add at least one item.",
  items_total_mismatch: "Items + GST do not add up to the grand total (more than ₹1 apart).",
  cgst_sgst_differ: "CGST and SGST must be equal.",
  igst_with_cgst: "Use either IGST, or CGST + SGST — not both.",
  tax_rate_mismatch: "The GST amount does not match the GST rates of the items.",
  wrong_tax_type: "Same state needs CGST + SGST; another state needs IGST.",
  bad_gstin: "The GSTIN is not valid (check digit does not match).",
  duplicate_number: "An invoice with this number is already posted.",
  no_party: "Enter the customer or supplier name.",
  no_number: "Enter the invoice number.",
  bad_date: "Enter the date as YYYY-MM-DD.",
  bad_amount: "Check quantities, rates and the total.",
};

/** The JSON that public.save_invoice() takes. */
export function toPayload(d: InvoiceDraft, ocr?: Record<string, unknown>) {
  return {
    kind: d.kind, number: d.number.trim(), date: d.date, due_date: d.dueDate || null,
    party: { name: d.party.name.trim(), gstin: d.party.gstin?.trim().toUpperCase() || null, phone: d.party.phone?.trim() || null },
    items: d.items.map((i) => ({ description: i.description.trim(), hsn: i.hsn?.trim() || null, qty: i.qty, unit: i.unit?.trim() || null,
      rate: i.ratePaise, discount: i.discountPaise ?? 0, gst_rate: i.gstRate ?? null })),
    cgst: d.cgstPaise, sgst: d.sgstPaise, igst: d.igstPaise, total: d.totalPaise,
    ...(ocr ? { ocr } : {}),
  };
}

export const emptyInvoice = (kind: InvoiceKind, today: string): InvoiceDraft => ({
  kind, number: "", date: today, dueDate: null, party: { name: "" },
  items: [{ description: "", qty: 1, ratePaise: 0, gstRate: 18 }], cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0,
});
