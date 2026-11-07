import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, Card, Chips, Field, H2, P, Screen } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { router } from "expo-router";
import { AskBox } from "@/components/ask-box";
import { bookApi } from "@/lib/books";
import { formatINR, PERSONAL_EXPENSES, PERSONAL_INCOME, simpleEntry, toPaise, type MoneyAccount } from "@/lib/accounting";

type Total = { code: string; name: string; type: string; debit_paise: number; credit_paise: number };
type Entry = { id: string; entry_date: string; memo: string | null; status: string; source: string };
type Suggestion = { id: string; entry_date: string; memo: string | null; confidence: number | null; lines: { account: string; debit?: number; credit?: number }[] };
const monthRange = (d = new Date()) => {
  const y = d.getFullYear(), m = d.getMonth();
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
};

// Personal accounts (one engine; business books use the same functions with business_book()).
// Nothing is posted without the person's tap: AI suggestions become drafts that must be reviewed and posted.
export default function Accounting() {
  const [book, setBook] = useState<string | null>(null);
  const [totals, setTotals] = useState<Total[]>([]);
  const [drafts, setDrafts] = useState<Entry[]>([]);
  const [recent, setRecent] = useState<Entry[]>([]);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    const b = await supabase.rpc("my_personal_book");
    if (b.error || !b.data) { setErr("Could not open your accounts."); return; }
    const id = b.data as string; setBook(id);
    const { from, to } = monthRange();
    const [t, e, s] = await Promise.all([
      supabase.rpc("account_totals", { p_book: id, p_from: from, p_to: to }),
      supabase.from("journal_entries").select("id,entry_date,memo,status,source").eq("book_id", id).order("created_at", { ascending: false }).limit(50),
      supabase.from("ai_suggestions").select("id,entry_date,memo,confidence,lines").eq("book_id", id).eq("status", "pending").limit(20),
    ]);
    setTotals((t.data ?? []) as Total[]);
    const es = (e.data ?? []) as Entry[];
    setDrafts(es.filter((x) => x.status === "draft")); setRecent(es.filter((x) => x.status === "posted").slice(0, 15));
    setSugs((s.data ?? []) as Suggestion[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const income = totals.filter((x) => x.type === "income").reduce((s, x) => s + x.credit_paise - x.debit_paise, 0);
  const expense = totals.filter((x) => x.type === "expense").reduce((s, x) => s + x.debit_paise - x.credit_paise, 0);
  const call = async (fn: string, args: Record<string, unknown>) => { const { error } = await supabase.rpc(fn, args); if (error) setErr(error.message.includes("not_balanced") ? "That entry does not balance, so it was not posted." : "Could not save. Try again."); void load(); };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Card>
          <H2>This month</H2>
          <P>Income: {formatINR(income)}</P>
          <P>Spent: {formatINR(expense)}</P>
          <P ok={income - expense >= 0} danger={income - expense < 0}>Balance: {formatINR(income - expense)}</P>
        </Card>
        {book && <QuickEntry book={book} onDone={load} />}
        {book && <AskBox api={bookApi(book, false)} />}
        <MyBusinesses />
        {err && <P danger>{err}</P>}
        {sugs.length > 0 && (
          <Card>
            <H2>Suggestions to review</H2>
            <P muted>Read from your documents. Accepting makes a draft; nothing is posted until you post it.</P>
            {sugs.map((s) => (
              <View key={s.id} style={{ gap: 6 }}>
                <P>{s.entry_date} · {s.memo ?? "—"}{s.confidence != null ? ` · ${Math.round(s.confidence * 100)}% sure` : ""}</P>
                <P muted>{s.lines.map((l) => `${l.account} ${l.debit ? "Dr " + formatINR(l.debit) : "Cr " + formatINR(l.credit ?? 0)}`).join(" · ")}</P>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}><Button title="Accept as draft" onPress={() => void call("accept_suggestion", { p_suggestion: s.id })} /></View>
                  <View style={{ flex: 1 }}><Button title="Reject" kind="outline" onPress={() => void call("reject_suggestion", { p_suggestion: s.id })} /></View>
                </View>
              </View>
            ))}
          </Card>
        )}
        {drafts.length > 0 && (
          <Card>
            <H2>Drafts (not posted)</H2>
            {drafts.map((d) => (
              <View key={d.id} style={{ gap: 6 }}>
                <P>{d.entry_date} · {d.memo ?? "—"} · {d.source}</P>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}><Button title="Post" onPress={() => void call("post_entry", { p_entry: d.id })} /></View>
                  <View style={{ flex: 1 }}><Button title="Discard" kind="danger" onPress={() => void call("delete_draft", { p_entry: d.id })} /></View>
                </View>
              </View>
            ))}
          </Card>
        )}
        <Card>
          <H2>Recent</H2>
          {recent.length === 0 ? <P muted>No entries yet.</P> : recent.map((r) => <P key={r.id}>{r.entry_date} · {r.memo ?? "—"}</P>)}
        </Card>
      </ScrollView>
    </Screen>
  );
}

function QuickEntry({ book, onDone }: { book: string; onDone: () => void }) {
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [money, setMoney] = useState<MoneyAccount>("CASH");
  const [cat, setCat] = useState<string>("FOOD");
  const [busy, setBusy] = useState(false);
  const paise = toPaise(amount);
  const cats = kind === "expense" ? PERSONAL_EXPENSES : PERSONAL_INCOME;
  async function save() {
    if (!paise) return;
    setBusy(true);
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const d = await supabase.rpc("create_draft_entry", { p_book: book, p_date: date, p_memo: memo.trim() || cat, p_party: null, p_lines: simpleEntry(kind, paise, money, cat), p_source: "manual", p_document: null });
    if (!d.error && d.data) await supabase.rpc("post_entry", { p_entry: d.data });
    setBusy(false); setAmount(""); setMemo(""); onDone();
  }
  return (
    <Card>
      <H2>Add income or expense</H2>
      <Chips value={kind} onChange={(k) => { setKind(k); setCat(k === "expense" ? "FOOD" : "SALARY"); }} options={[{ value: "expense", label: "Expense" }, { value: "income", label: "Income" }]} />
      <Field label="Amount (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <Field label="What for? (optional)" value={memo} onChangeText={setMemo} maxLength={300} />
      <Chips value={cat} onChange={setCat} options={cats.map((c) => ({ value: c, label: c.replace("_", " ").toLowerCase() }))} />
      <Chips value={money} onChange={setMoney} options={[{ value: "CASH", label: "Cash" }, { value: "BANK", label: "Bank" }, { value: "CARD", label: "Card" }]} />
      <Button title="Save" onPress={() => void save()} busy={busy} disabled={!paise} />
    </Card>
  );
}

type Biz = { business_id: string; role: string; businesses: { name: string; gstin: string | null } | null };
// Business books are separate from personal ones; each opens on its own screen.
function MyBusinesses() {
  const [list, setList] = useState<Biz[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [gstin, setGstin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data: u } = await supabase.auth.getUser();
    const { data } = await supabase.from("business_members").select("business_id,role,businesses(name,gstin)").eq("user_id", u.user?.id ?? "");
    setList((data ?? []) as unknown as Biz[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function create() {
    setErr(null);
    const { data, error } = await supabase.rpc("create_business", { p_name: name, p_gstin: gstin || null });
    if (error || !data) { setErr("Could not create. Check the name and GSTIN (15 characters)."); return; }
    setAdding(false); setName(""); setGstin(""); void load();
    router.push({ pathname: "/business/[id]", params: { id: data as string } });
  }
  return (
    <Card>
      <H2>Business accounts</H2>
      <P muted>Kept completely separate from your personal accounts.</P>
      {list.map((b) => (
        <Button key={b.business_id} kind="outline" title={`${b.businesses?.name ?? "Business"} · ${b.role}`}
          onPress={() => router.push({ pathname: "/business/[id]", params: { id: b.business_id } })} />
      ))}
      {adding ? (
        <>
          <Field label="Business name" value={name} onChangeText={setName} maxLength={120} />
          <Field label="GSTIN (optional)" value={gstin} onChangeText={(v) => setGstin(v.toUpperCase())} autoCapitalize="characters" maxLength={15} />
          {err && <P danger>{err}</P>}
          <Button title="Create business" onPress={() => void create()} disabled={name.trim().length < 2} />
        </>
      ) : <Button title="+ Add a business" kind="outline" onPress={() => setAdding(true)} />}
    </Card>
  );
}
