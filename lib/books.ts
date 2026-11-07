// Supabase-backed data for the accounting screens (public anon key + the person's session; RLS decides access).
import { supabase } from "./supabase";
import type { Api, PartyBalance } from "./ask";
import type { GstRow, Total } from "./reports";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
export const getTotals = (book: string, from: string, to: string) => rpc<Total[]>("account_totals", { p_book: book, p_from: from, p_to: to });
export const getParties = (book: string, asOf: string) => rpc<PartyBalance[]>("party_balances", { p_book: book, p_as_of: asOf });
export const getGst = (book: string, from: string, to: string) => rpc<GstRow[]>("gst_summary", { p_book: book, p_from: from, p_to: to });
export type LedgerRow = { entry_date: string; entry_id: string | null; memo: string | null; party: string | null; debit_paise: number; credit_paise: number; balance_paise: number };
export const getLedger = (book: string, code: string, from: string, to: string) => rpc<LedgerRow[]>("account_ledger", { p_book: book, p_code: code, p_from: from, p_to: to });

export function bookApi(book: string, business: boolean): Api {
  return {
    totals: (f, t) => getTotals(book, f, t),
    ...(business ? { parties: (d: string) => getParties(book, d), gst: (f: string, t: string) => getGst(book, f, t) } : {}),
  };
}

/** Error text from the database codes, in plain words. */
export function plainError(message: string): string {
  if (message.includes("not_allowed")) return "Only the owner or an admin can do this.";
  if (message.includes("has_issues")) return "Fix the problems listed above first.";
  if (message.includes("confirm_required")) return "Tick the box to confirm you checked this bill against the paper.";
  if (message.includes("more_than_due")) return "That is more than what is still due.";
  if (message.includes("has_payments")) return "This invoice has payments, so it cannot be cancelled.";
  if (message.includes("not_balanced")) return "Debits and credits do not match, so nothing was posted.";
  if (message.includes("bad_gstin")) return "The GSTIN is not valid.";
  if (message.includes("before_invoice")) return "The payment date is before the invoice date.";
  return "Could not save. Check the internet and try again.";
}
