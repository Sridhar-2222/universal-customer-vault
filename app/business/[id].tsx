import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button, Card, H2, P, Screen } from "@/components/ui";
import { AskBox } from "@/components/ask-box";
import { bookApi, getGst, getParties, getTotals } from "@/lib/books";
import { formatINR } from "@/lib/accounting";
import { iso, thisMonth } from "@/lib/periods";
import { gstNet, profitAndLoss } from "@/lib/reports";
import { supabase } from "@/lib/supabase";
import { useBusiness } from "@/lib/use-business";

type Summary = { sales: number; purchases: number; profit: number; gst: number; receivable: number; payable: number; overdue: number; toReview: number };

// Business home: this month at a glance, what needs review, and the registers and reports.
export default function BusinessHome() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { info, canApprove } = useBusiness(id);
  const [sum, setSum] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const book = info?.book ?? null;
  const load = useCallback(async () => {
    if (!book) return;
    try {
      const m = thisMonth(new Date()), today = iso(new Date());
      const [t, g, p, r] = await Promise.all([getTotals(book, m.from, m.to), getGst(book, m.from, m.to), getParties(book, today),
        supabase.from("invoices").select("id", { count: "exact", head: true }).eq("book_id", book).in("status", ["draft", "review"])]);
      const pl = profitAndLoss(t);
      const amt = (code: string) => pl.income.concat(pl.expenses).find((x) => x.code === code)?.amount ?? 0;
      const tot = (k: string, f: "outstanding_paise" | "overdue_paise") => p.filter((x) => x.kind === k).reduce((s, x) => s + Number(x[f]), 0);
      setSum({ sales: amt("SALES"), purchases: amt("PURCHASES"), profit: pl.net, gst: gstNet(g).payable, receivable: tot("customer", "outstanding_paise"),
        payable: tot("supplier", "outstanding_paise"), overdue: tot("customer", "overdue_paise") + tot("supplier", "overdue_paise"), toReview: r.count ?? 0 });
    } catch { setErr("Could not load the summary. Try again."); }
  }, [book]);
  useEffect(() => { void load(); }, [load]);
  const go = (pathname: string, params: Record<string, string>) => router.push({ pathname: pathname as never, params });

  return (
    <Screen>
      <Stack.Screen options={{ title: info?.name ?? "Business" }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {!info && <P muted>Loading…</P>}
        {info?.error && <P danger>{info.error}</P>}
        {book && (
          <>
            <Card>
              <H2>This month</H2>
              {err && <P danger>{err}</P>}
              {sum ? (
                <>
                  <P>Sales {formatINR(sum.sales)} · Purchases {formatINR(sum.purchases)}</P>
                  <P ok={sum.profit >= 0} danger={sum.profit < 0}>{sum.profit >= 0 ? "Profit" : "Loss"} {formatINR(Math.abs(sum.profit))}</P>
                  <P>{sum.gst >= 0 ? `GST to pay ${formatINR(sum.gst)}` : `GST credit ${formatINR(-sum.gst)}`}</P>
                  <P>To collect {formatINR(sum.receivable)} · To pay {formatINR(sum.payable)}</P>
                  {sum.overdue > 0 && <P danger>Overdue {formatINR(sum.overdue)}</P>}
                </>
              ) : !err && <P muted>Loading…</P>}
            </Card>
            {sum && sum.toReview > 0 && (
              <Card>
                <H2>Waiting for review: {sum.toReview}</H2>
                <P muted>Drafts and bills read from photos stay out of the books until {canApprove ? "you post them" : "the owner or an admin posts them"}.</P>
                <Button title="Open the list" onPress={() => go("/business/register", { book, biz: info!.id, kind: "pending" })} />
              </Card>
            )}
            <Card>
              <H2>Add</H2>
              <View style={{ gap: 8 }}>
                <Button title="New sale invoice" onPress={() => go("/business/invoice", { book, biz: info!.id, kind: "sale" })} />
                <Button title="New purchase bill" onPress={() => go("/business/invoice", { book, biz: info!.id, kind: "purchase" })} />
              </View>
            </Card>
            <Card>
              <H2>Books</H2>
              <View style={{ gap: 8 }}>
                <Button title="Sales register" kind="outline" onPress={() => go("/business/register", { book, biz: info!.id, kind: "sale" })} />
                <Button title="Purchase register" kind="outline" onPress={() => go("/business/register", { book, biz: info!.id, kind: "purchase" })} />
                <Button title="Reports: P&L, balance sheet, GST, cash & bank" kind="outline" onPress={() => go("/business/reports", { book, biz: info!.id })} />
              </View>
            </Card>
            <AskBox api={bookApi(book, true)} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
