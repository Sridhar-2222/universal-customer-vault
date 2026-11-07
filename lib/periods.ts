// Date ranges for reports and questions. Dates are local calendar days as YYYY-MM-DD.
export type Range = { from: string; to: string; label: string };
const pad = (x: number) => String(x).padStart(2, "0");
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const pretty = (s: string) => { const [y, m, d] = s.split("-").map(Number); return `${d} ${MON[m! - 1]} ${y}`; };
const day = (y: number, m: number, d: number) => new Date(y, m, d);

export function month(y: number, m: number, label: string): Range {
  return { from: iso(day(y, m, 1)), to: iso(day(y, m + 1, 0)), label };
}
/** Indian financial year (1 April – 31 March) containing the date. */
export function financialYear(d: Date, back = 0): Range {
  const start = (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) - back;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `FY ${start}-${String(start + 1).slice(2)}` };
}
export const thisMonth = (t: Date) => month(t.getFullYear(), t.getMonth(), "this month");

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Finds a period in a question ("last month", "this year", "in October", "last 7 days", "FY"); default this month. */
export function periodFrom(text: string, today: Date): Range {
  const q = text.toLowerCase();
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  if (/\btoday\b/.test(q)) return { from: iso(today), to: iso(today), label: "today" };
  if (/\byesterday\b/.test(q)) { const x = iso(day(y, m, d - 1)); return { from: x, to: x, label: "yesterday" }; }
  const lastN = q.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (lastN) return { from: iso(day(y, m, d - Number(lastN[1]) + 1)), to: iso(today), label: `the last ${lastN[1]} days` };
  const monday = d - ((today.getDay() + 6) % 7);
  if (/\bthis week\b/.test(q)) return { from: iso(day(y, m, monday)), to: iso(today), label: "this week" };
  if (/\blast week\b/.test(q)) return { from: iso(day(y, m, monday - 7)), to: iso(day(y, m, monday - 1)), label: "last week" };
  if (/\b(last|previous) (financial year|fy)\b/.test(q)) return financialYear(today, 1);
  if (/\b(financial year|fy)\b/.test(q)) return financialYear(today);
  if (/\b(last|previous) year\b/.test(q)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `${y - 1}` };
  if (/\bthis year\b|\bso far this year\b/.test(q)) return { from: `${y}-01-01`, to: iso(today), label: "this year" };
  if (/\b(last|previous) month\b/.test(q)) return month(y, m - 1, "last month");
  const mm = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/);
  if (mm && !/\bmay i\b/.test(q)) {
    const mi = MONTHS[mm[1]!]!;
    const yy = mm[2] ? Number(mm[2]) : mi > m ? y - 1 : y; // a later month name means last year's
    return month(yy, mi, `${MON[mi]} ${yy}`);
  }
  return thisMonth(today);
}
