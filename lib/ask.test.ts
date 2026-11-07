import { describe, expect, test } from "bun:test";
import { answerQuestion, parseQuestion, type Api } from "./ask";
import { balanceSheet, gstNet, profitAndLoss, type Total } from "./reports";
import { financialYear, periodFrom } from "./periods";

const today = new Date(2026, 10, 7); // 7 Nov 2026
const T = (code: string, type: string, dr: number, cr: number, name = code): Total => ({ code, name, type, debit_paise: dr, credit_paise: cr });

describe("periods", () => {
  test("common phrases", () => {
    expect(periodFrom("last month", today)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodFrom("this month", today)).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(periodFrom("in december", today)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(periodFrom("october 2026", today)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodFrom("last 7 days", today)).toMatchObject({ from: "2026-11-01", to: "2026-11-07" });
    expect(periodFrom("this week", today)).toMatchObject({ from: "2026-11-02", to: "2026-11-07" }); // Monday start
    expect(periodFrom("yesterday", today)).toMatchObject({ from: "2026-11-06", to: "2026-11-06" });
    expect(financialYear(today)).toMatchObject({ from: "2026-04-01", to: "2027-03-31", label: "FY 2026-27" });
    expect(financialYear(new Date(2026, 1, 3))).toMatchObject({ from: "2025-04-01" });
  });
});

describe("parseQuestion", () => {
  const cases: [string, string, string[]?][] = [
    ["How much did I spend on petrol last month?", "spent", ["TRAVEL"]],
    ["What did I spend this month", "spent"],
    ["groceries in october", "spent", ["FOOD"]],
    ["How much did I earn this year?", "earned"],
    ["sales last month", "earned", ["SALES"]],
    ["Profit this financial year", "profit"],
    ["Biggest expenses this year", "top_expenses"],
    ["Cash balance", "balance", ["CASH"]],
    ["how much money is in the bank", "balance", ["BANK"]],
    ["Who owes me?", "receivables"],
    ["What do I owe suppliers?", "payables"],
    ["Overdue payments", "overdue"],
    ["GST payable last month", "gst"],
    ["tell me a joke", "unknown"],
  ];
  for (const [q, intent, accounts] of cases)
    test(q, () => {
      const a = parseQuestion(q, today);
      expect(a.intent).toBe(intent as never);
      if (accounts) expect(a.accounts).toEqual(accounts);
    });
});

describe("reports", () => {
  const ts = [T("CASH", "asset", 500000, 200000), T("RECEIVABLES", "asset", 330400, 130400), T("PAYABLES", "liability", 200000, 708000),
    T("CAPITAL", "equity", 0, 100000), T("SALES", "income", 0, 280000), T("OUTPUT_CGST", "liability", 0, 25200), T("OUTPUT_SGST", "liability", 0, 25200),
    T("PURCHASES", "expense", 600000, 0), T("INPUT_CGST", "asset", 54000, 0), T("INPUT_SGST", "asset", 54000, 0), T("BANK", "asset", 130400, 0)];
  test("profit and loss", () => {
    const p = profitAndLoss(ts);
    expect(p.totalIncome).toBe(280000); expect(p.totalExpenses).toBe(600000); expect(p.net).toBe(-320000);
  });
  test("balance sheet balances when the ledger does", () => {
    const debits = ts.reduce((s, t) => s + t.debit_paise, 0), credits = ts.reduce((s, t) => s + t.credit_paise, 0);
    const fixed = [...ts, T("OTHER_INCOME", "income", 0, debits - credits)]; // make the sample balanced
    expect(balanceSheet(fixed).balanced).toBe(true);
  });
  test("GST net", () => {
    const g = gstNet([{ kind: "sale", invoices: 2, taxable_paise: 290000, cgst_paise: 25200, sgst_paise: 25200, igst_paise: 1800, total_paise: 0 },
      { kind: "purchase", invoices: 1, taxable_paise: 600000, cgst_paise: 54000, sgst_paise: 54000, igst_paise: 0, total_paise: 0 }]);
    expect(g.output).toBe(52200); expect(g.input).toBe(108000); expect(g.payable).toBe(-55800);
  });
});

describe("answers", () => {
  const api: Api = {
    totals: async () => [T("TRAVEL", "expense", 250000, 0, "Travel"), T("FOOD", "expense", 125000, 0, "Food & groceries"), T("SALARY", "income", 0, 5000000, "Salary"), T("CASH", "asset", 400000, 375000, "Cash")],
  };
  test("spent on a topic", async () => {
    expect((await answerQuestion(parseQuestion("petrol last month", today), api, "2026-11-07"))[0]).toBe("You spent ₹2,500.00 on travel last month (1 Oct 2026 – 31 Oct 2026).");
  });
  test("profit", async () => {
    expect((await answerQuestion(parseQuestion("profit this month", today), api, "2026-11-07"))[0]).toContain("Profit this month");
  });
  test("cash balance", async () => {
    expect(await answerQuestion(parseQuestion("cash balance", today), api, "2026-11-07")).toEqual(["Cash balance today: ₹250.00."]);
  });
  test("business questions on a personal book say so instead of guessing", async () => {
    expect((await answerQuestion(parseQuestion("who owes me", today), api, "2026-11-07"))[0]).toContain("business books");
  });
  test("receivables list", async () => {
    const b: Api = { ...api, parties: async () => [{ name: "Ravi Traders", kind: "customer", outstanding_paise: 200000, overdue_paise: 200000, oldest_due: "2026-10-30" }] };
    expect(await answerQuestion(parseQuestion("who owes me", today), b, "2026-11-07")).toEqual(["Customers owe you ₹2,000.00 today:", "• Ravi Traders: ₹2,000.00"]);
    expect((await answerQuestion(parseQuestion("overdue", today), b, "2026-11-07"))[1]).toBe("• Ravi Traders: ₹2,000.00 (due since 30 Oct 2026)");
  });
  test("unknown questions get examples, not a guess", async () => {
    expect((await answerQuestion(parseQuestion("tell me a joke", today), api, "2026-11-07"))[0]).toBe("I can answer questions like:");
  });
});
