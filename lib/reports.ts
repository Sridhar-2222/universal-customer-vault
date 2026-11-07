// Reports built from customer_vault.account_totals() and customer_vault.gst_summary() (pure; tested in reports.test.ts).
export type Total = { code: string; name: string; type: string; debit_paise: number; credit_paise: number };
export type Row = { code: string; name: string; amount: number };
export type GstRow = { kind: string; invoices: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number };

const n = (x: number | string) => Number(x);
/** Natural balance: debit-side accounts (assets, expenses) are debit − credit; the others credit − debit. */
export const balanceOf = (t: Total) => (t.type === "asset" || t.type === "expense" ? n(t.debit_paise) - n(t.credit_paise) : n(t.credit_paise) - n(t.debit_paise));
const rows = (ts: Total[], type: string): Row[] =>
  ts.filter((t) => t.type === type).map((t) => ({ code: t.code, name: t.name, amount: balanceOf(t) })).filter((r) => r.amount !== 0);
const sum = (rs: Row[]) => rs.reduce((s, r) => s + r.amount, 0);

export function profitAndLoss(ts: Total[]) {
  const income = rows(ts, "income"), expenses = rows(ts, "expense");
  const totalIncome = sum(income), totalExpenses = sum(expenses);
  return { income, expenses, totalIncome, totalExpenses, net: totalIncome - totalExpenses };
}

/** Balance sheet from totals since the beginning up to the date. Profit to date is shown under equity. */
export function balanceSheet(ts: Total[]) {
  const assets = rows(ts, "asset"), liabilities = rows(ts, "liability"), equity = rows(ts, "equity");
  const earnings = profitAndLoss(ts).net;
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = sum(equity) + earnings;
  return { assets, liabilities, equity, earnings, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

/** GST to pay for a period: output tax on sales minus input tax credit on purchases (negative = credit carried forward). */
export function gstNet(rs: GstRow[]) {
  const tax = (r?: GstRow) => (r ? n(r.cgst_paise) + n(r.sgst_paise) + n(r.igst_paise) : 0);
  const sale = rs.find((r) => r.kind === "sale"), purchase = rs.find((r) => r.kind === "purchase");
  const output = tax(sale), input = tax(purchase);
  return { output, input, payable: output - input, salesTaxable: n(sale?.taxable_paise ?? 0), purchaseTaxable: n(purchase?.taxable_paise ?? 0) };
}
