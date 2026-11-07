import { useCallback, useEffect, useState, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Card, Chips, H2, P, Screen } from "@/components/ui";
import { formatINR } from "@/lib/accounting";
import { getGst, getLedger, getParties, getTotals, type LedgerRow } from "@/lib/books";
import { financialYear, iso, month, pretty, thisMonth, type Range } from "@/lib/periods";
import { balanceSheet, gstNet, profitAndLoss, type Row } from "@/lib/reports";
import type { PartyBalance } from "@/lib/ask";

type Period = "month" | "last" | "fy";
type Tab = "pl" | "bs" | "gst" | "cash" | "bank" | "parties";
const rangeOf = (p: Period, t = new Date()): Range => (p === "month" ? thisMonth(t) : p === "last" ? month(t.getFullYear(), t.getMonth() - 1, "last month") : financialYear(t));

// Profit and loss, balance sheet, GST summary, cash book, bank book, customer and supplier balances.
export default function Reports() {
  const { book } = useLocalSearchParams<{ book: string }>();
  const [period, setPeriod] = useState<Period>("month");
  const [tab, setTab] = useState<Tab>("pl");
  const [lines, setLines] = useState<ReactElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const r = rangeOf(period);
  const load = useCallback(async () => {
    setErr(null); setLines(null);
    try {
      const today = iso(new Date());
      if (tab === "pl") {
        const p = profitAndLoss(await getTotals(book, r.from, r.to));
        setLines(<>{section("Income", p.income, p.totalIncome)}{section("Expenses", p.expenses, p.totalExpenses)}
          <P ok={p.net >= 0} danger={p.net < 0}>{p.net >= 0 ? "Net profit" : "Net loss"} {formatINR(Math.abs(p.net))}</P></>);
      } else if (tab === "bs") {
        const asOf = r.to < today ? r.to : today;
        const b = balanceSheet(await getTotals(book, "2000-01-01", asOf));
        setLines(<><P muted>As of {pretty(asOf)}</P>{section("Assets", b.assets, b.totalAssets)}{section("Liabilities", b.liabilities, b.totalLiabilities)}
          {section("Capital and profit", [...b.equity, { code: "PL", name: "Profit to date", amount: b.earnings }], b.totalEquity)}
          <P ok={b.balanced} danger={!b.balanced}>{b.balanced ? "Assets = liabilities + capital ✓" : "Does not balance — please report this."}</P></>);
      } else if (tab === "gst") {
        const rows = await getGst(book, r.from, r.to); const g = gstNet(rows);
        setLines(<>{rows.map((x) => (
          <View key={x.kind} style={{ gap: 2 }}>
            <H2>{x.kind === "sale" ? "Sales (output tax)" : "Purchases (input credit)"}</H2>
            <P>{x.invoices} invoices · taxable {formatINR(Number(x.taxable_paise))}</P>
            <P>CGST {formatINR(Number(x.cgst_paise))} · SGST {formatINR(Number(x.sgst_paise))} · IGST {formatINR(Number(x.igst_paise))}</P>
          </View>))}
          <P ok={g.payable <= 0}>{g.payable >= 0 ? `GST to pay ${formatINR(g.payable)}` : `Credit carried forward ${formatINR(-g.payable)}`}</P>
          <P muted>From posted invoices only. Check with your accountant before filing returns.</P></>);
      } else if (tab === "cash" || tab === "bank") {
        const rows = await getLedger(book, tab === "cash" ? "CASH" : "BANK", r.from, r.to);
        setLines(<>{rows.map((x: LedgerRow, i) => (
          <P key={i}>{x.entry_date} · {x.memo ?? "—"}{x.party ? ` · ${x.party}` : ""}{Number(x.debit_paise) ? ` · in ${formatINR(Number(x.debit_paise))}` : ""}{Number(x.credit_paise) ? ` · out ${formatINR(Number(x.credit_paise))}` : ""} · balance {formatINR(Number(x.balance_paise))}</P>))}</>);
      } else {
        const ps = await getParties(book, today);
        const part = (k: string, t: string) => { const l = ps.filter((p: PartyBalance) => p.kind === k); return (
          <View style={{ gap: 4 }}><H2>{t}</H2>{l.length ? l.map((p) => <P key={p.name} danger={Number(p.overdue_paise) > 0}>{p.name}: {formatINR(Number(p.outstanding_paise))}{Number(p.overdue_paise) > 0 ? ` (overdue ${formatINR(Number(p.overdue_paise))})` : ""}</P>) : <P muted>Nothing due.</P>}</View>); };
        setLines(<><P muted>As of today</P>{part("customer", "Customers owe you")}{part("supplier", "You owe suppliers")}</>);
      }
    } catch { setErr("Could not load this report. Try again."); }
  }, [book, tab, r.from, r.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return (
    <Screen>
      <Stack.Screen options={{ title: "Reports" }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Chips value={tab} onChange={setTab} options={[{ value: "pl", label: "Profit & loss" }, { value: "bs", label: "Balance sheet" }, { value: "gst", label: "GST" },
          { value: "cash", label: "Cash book" }, { value: "bank", label: "Bank book" }, { value: "parties", label: "Receivable / payable" }]} />
        {tab !== "parties" && <Chips value={period} onChange={setPeriod} options={[{ value: "month", label: "This month" }, { value: "last", label: "Last month" }, { value: "fy", label: financialYear(new Date()).label }]} />}
        <Card>
          {tab !== "parties" && tab !== "bs" && <P muted>{pretty(r.from)} – {pretty(r.to)}</P>}
          {err ? <P danger>{err}</P> : lines ?? <P muted>Loading…</P>}
        </Card>
      </ScrollView>
    </Screen>
  );
}

function section(title: string, rows: Row[], total: number) {
  return (
    <View style={{ gap: 2 }}>
      <H2>{title}</H2>
      {rows.length ? rows.map((x) => <P key={x.code}>{x.name}: {formatINR(x.amount)}</P>) : <P muted>None.</P>}
      <P>Total {formatINR(total)}</P>
    </View>
  );
}
