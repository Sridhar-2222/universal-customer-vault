// Scores lib/ocr-extract.ts on the benchmark output (bench/out/*.json). Usage: bun ocr-service/bench/score.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractInvoice } from "../../lib/ocr-extract";
import { invoiceIssues } from "../../lib/invoice";

const dir = process.env.BENCH_OUT ?? join(import.meta.dir, "out");
const fields = ["party", "gstin", "number", "date", "items", "taxes", "total", "checks_pass", "all_correct"] as const;
const byHow: Record<string, Record<string, number> & { n: number }> = {};
const verbose = process.argv.includes("-v");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const { truth, my_gstin, how, ocr } = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const x = extractInvoice(ocr, { myGstin: my_gstin });
  const d = x.draft;
  const amounts = d.items.map((i) => Math.round(i.qty * i.ratePaise) - (i.discountPaise ?? 0));
  const ok: Record<string, boolean> = {
    party: d.party.name.trim().toUpperCase() === truth.party,
    gstin: d.party.gstin === truth.gstin,
    number: d.number === truth.number,
    date: d.date === truth.date,
    items: amounts.length === truth.items.length && amounts.every((a, k) => a === truth.items[k].amount),
    taxes: d.cgstPaise === truth.cgst && d.sgstPaise === truth.sgst && d.igstPaise === truth.igst,
    total: d.totalPaise === truth.total,
    checks_pass: invoiceIssues(d, my_gstin).length === 0,
  };
  ok.all_correct = Object.values(ok).every(Boolean);
  const b = (byHow[how] ??= { n: 0 } as never);
  b.n++;
  for (const k of fields) b[k] = (b[k] ?? 0) + (ok[k] ? 1 : 0);
  if (verbose && !ok.all_correct) console.log(f, Object.entries(ok).filter(([, v]) => !v).map(([k]) => k).join(","), JSON.stringify({ party: d.party, number: d.number, date: d.date, items: amounts, truthItems: truth.items.map((i: { amount: number }) => i.amount), tax: [d.cgstPaise, d.sgstPaise, d.igstPaise], truthTax: [truth.cgst, truth.sgst, truth.igst], total: d.totalPaise, truthTotal: truth.total }));
}
const pct = (a: number, n: number) => `${Math.round((a / n) * 100)}%`.padStart(5);
console.log("condition".padEnd(20) + fields.map((f) => f.padStart(12)).join(""));
const all = { n: 0 } as Record<string, number> & { n: number };
for (const [how, b] of Object.entries(byHow)) {
  console.log(how.padEnd(20) + fields.map((f) => pct(b[f] ?? 0, b.n).padStart(12)).join(""));
  all.n += b.n; for (const f of fields) all[f] = (all[f] ?? 0) + (b[f] ?? 0);
}
console.log("ALL".padEnd(20) + fields.map((f) => pct(all[f] ?? 0, all.n).padStart(12)).join("") + `   (${all.n} bills)`);
