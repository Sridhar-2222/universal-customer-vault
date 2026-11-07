// Plain-language questions about your accounts ("How much did I spend on petrol last month?", "Who owes me?").
// Free and private: the question is understood ON THE DEVICE by fixed rules (no AI service), then answered only
// from posted entries through the same report functions the screens use. Unknown questions get examples back,
// never a guess. Pure and tested in ask.test.ts.
import { formatINR } from "./accounting";
import { periodFrom, pretty, type Range } from "./periods";
import { gstNet, profitAndLoss, balanceOf, type GstRow, type Total } from "./reports";

export type Intent = "spent" | "earned" | "profit" | "top_expenses" | "balance" | "receivables" | "payables" | "overdue" | "gst" | "unknown";
export type Ask = { intent: Intent; range: Range; accounts?: string[]; topic?: string };
export type PartyBalance = { name: string; kind: string; outstanding_paise: number; overdue_paise: number; oldest_due: string | null };
export type Api = {
  totals: (from: string, to: string) => Promise<Total[]>;
  parties?: (asOf: string) => Promise<PartyBalance[]>; // business books only
  gst?: (from: string, to: string) => Promise<GstRow[]>; // business books only
};

// Words → account codes (personal and business charts in 0002/0003).
const TOPICS: { words: RegExp; accounts: string[]; topic: string }[] = [
  { words: /\b(food|grocer(y|ies)|restaurants?|vegetables?|milk|swiggy|zomato)\b/, accounts: ["FOOD"], topic: "food & groceries" },
  { words: /\b(travel|petrol|fuel|diesel|bus|train|flights?|cabs?|auto|uber|ola)\b/, accounts: ["TRAVEL"], topic: "travel" },
  { words: /\b(medical|medicines?|doctors?|hospital|pharmacy|health)\b/, accounts: ["HEALTH"], topic: "medical" },
  { words: /\b(electricity|power|water|gas|phone|mobile|internet|subscriptions?|recharge|bills?)\b/, accounts: ["BILLS"], topic: "bills & subscriptions" },
  { words: /\b(school|fees|education|tuition|college)\b/, accounts: ["EDUCATION"], topic: "education" },
  { words: /\b(household|home|rent|maid|repairs?)\b/, accounts: ["HOUSEHOLD"], topic: "household" },
  { words: /\b(purchases?|stock bought|buying)\b/, accounts: ["PURCHASES"], topic: "purchases" },
  { words: /\bsalary\b/, accounts: ["SALARY"], topic: "salary" },
  { words: /\b(sales|sold|revenue|turnover)\b/, accounts: ["SALES"], topic: "sales" },
];

export function parseQuestion(text: string, today = new Date()): Ask {
  const q = ` ${text.toLowerCase().replace(/[?!.,]/g, " ").replace(/\s+/g, " ")} `;
  const range = periodFrom(q, today);
  const topic = TOPICS.find((t) => t.words.test(q));
  const base = { range, ...(topic ? { accounts: topic.accounts, topic: topic.topic } : {}) };
  if (/\b(overdue|past due|late payments?|not paid on time)\b/.test(q)) return { intent: "overdue", range };
  if (/\b(gst|tax payable|input credit|itc)\b/.test(q)) return { intent: "gst", range };
  if (/\b(owes? me|owe us|receivables?|to collect|collect from|customers? (owe|due|pending))\b/.test(q)) return { intent: "receivables", range };
  if (/\b(i owe|do i owe|we owe|do we owe|payables?|to pay suppliers|suppliers? (due|pending)|have to pay)\b/.test(q)) return { intent: "payables", range };
  if (/\b(profit|loss|net income|how did (i|we) do)\b/.test(q)) return { intent: "profit", range };
  if (/\b(biggest|top|largest|most)\b/.test(q) && /\b(expenses?|spend(ing)?|spent|costs?)\b/.test(q)) return { intent: "top_expenses", range };
  if (/\b(balance|how much (cash|money) (do i|do we) have|in (the )?bank)\b/.test(q) && !/\bbalance sheet\b/.test(q)) {
    const acc = /\bcash\b/.test(q) ? ["CASH"] : /\bbank\b/.test(q) ? ["BANK"] : ["CASH", "BANK"];
    return { intent: "balance", range, accounts: acc };
  }
  if (/\b(spen[dt]|spending|expenses?|paid for|pay for|cost)\b/.test(q)) return { intent: "spent", ...base };
  if (/\b(earn(ed)?|income|received|sales|sold|revenue|turnover|made)\b/.test(q)) return { intent: "earned", ...base };
  if (topic) return { intent: topic.accounts[0] === "SALES" || topic.accounts[0] === "SALARY" ? "earned" : "spent", ...base };
  return { intent: "unknown", range };
}

export const EXAMPLES = [
  "How much did I spend on petrol last month?",
  "What did I spend this month?",
  "Biggest expenses this year",
  "Profit this financial year",
  "Cash balance",
  "Who owes me?",
  "What do I owe suppliers?",
  "Overdue payments",
  "GST payable last month",
];

const when = (r: Range) => (r.from === r.to ? `${r.label} (${pretty(r.from)})` : `${r.label} (${pretty(r.from)} – ${pretty(r.to)})`);
const listParties = (ps: PartyBalance[], field: "outstanding_paise" | "overdue_paise") =>
  ps.slice(0, 5).map((p) => `• ${p.name}: ${formatINR(Number(p[field]))}${field === "overdue_paise" && p.oldest_due ? ` (due since ${pretty(p.oldest_due)})` : ""}`);

/** Answers from posted entries only. Returns the lines to show. */
export async function answerQuestion(a: Ask, api: Api, todayIso: string): Promise<string[]> {
  const businessOnly = ["This question is about business books. Open your business accounts and ask there."];
  switch (a.intent) {
    case "unknown":
      return ["I can answer questions like:", ...EXAMPLES.map((e) => `• ${e}`)];
    case "spent":
    case "earned": {
      const ts = await api.totals(a.range.from, a.range.to);
      const type = a.intent === "spent" ? "expense" : "income";
      const pick = ts.filter((t) => (a.accounts ? a.accounts.includes(t.code) : t.type === type));
      if (a.accounts && !pick.length) return [`There is no "${a.topic}" account in these books.`];
      const total = pick.reduce((s, t) => s + balanceOf(t), 0);
      const verb = a.intent === "spent" ? "spent" : a.topic === "sales" ? "sold" : "received";
      return [`You ${verb} ${formatINR(total)}${a.topic ? ` on ${a.topic}` : ""} ${when(a.range)}.`];
    }
    case "profit": {
      const p = profitAndLoss(await api.totals(a.range.from, a.range.to));
      return [`${p.net >= 0 ? "Profit" : "Loss"} ${when(a.range)}: ${formatINR(Math.abs(p.net))}.`,
        `Income ${formatINR(p.totalIncome)} − expenses ${formatINR(p.totalExpenses)}.`];
    }
    case "top_expenses": {
      const ex = profitAndLoss(await api.totals(a.range.from, a.range.to)).expenses.sort((x, y) => y.amount - x.amount).slice(0, 3);
      if (!ex.length) return [`No expenses ${when(a.range)}.`];
      return [`Biggest expenses ${when(a.range)}:`, ...ex.map((e) => `• ${e.name}: ${formatINR(e.amount)}`)];
    }
    case "balance": {
      const ts = await api.totals("2000-01-01", todayIso);
      return (a.accounts ?? []).map((c) => {
        const t = ts.find((x) => x.code === c);
        return `${t?.name ?? c} balance today: ${formatINR(t ? balanceOf(t) : 0)}.`;
      });
    }
    case "receivables":
    case "payables":
    case "overdue": {
      if (!api.parties) return businessOnly;
      const all = await api.parties(todayIso);
      const kind = a.intent === "payables" ? "supplier" : "customer";
      if (a.intent === "overdue") {
        const late = all.filter((p) => Number(p.overdue_paise) > 0);
        if (!late.length) return ["Nothing is overdue today."];
        const sumOf = (k: string) => late.filter((p) => p.kind === k).reduce((s, p) => s + Number(p.overdue_paise), 0);
        return [`Overdue today: customers owe ${formatINR(sumOf("customer"))}, you owe suppliers ${formatINR(sumOf("supplier"))}.`, ...listParties(late, "overdue_paise")];
      }
      const ps = all.filter((p) => p.kind === kind && Number(p.outstanding_paise) > 0);
      const total = ps.reduce((s, p) => s + Number(p.outstanding_paise), 0);
      if (!ps.length) return [kind === "customer" ? "No customer owes you anything today." : "You owe no supplier anything today."];
      return [kind === "customer" ? `Customers owe you ${formatINR(total)} today:` : `You owe suppliers ${formatINR(total)} today:`, ...listParties(ps, "outstanding_paise")];
    }
    case "gst": {
      if (!api.gst) return businessOnly;
      const g = gstNet(await api.gst(a.range.from, a.range.to));
      return [g.payable >= 0 ? `GST to pay ${when(a.range)}: ${formatINR(g.payable)}.` : `No GST to pay ${when(a.range)}; credit carried forward ${formatINR(-g.payable)}.`,
        `Output tax on sales ${formatINR(g.output)} − input credit on purchases ${formatINR(g.input)}.`,
        "From posted invoices only; check with your accountant before filing."];
    }
  }
}
