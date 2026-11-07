import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Card, colors, Field, P, Screen } from "@/components/ui";
import { formatINR } from "@/lib/accounting";
import { textMatches } from "@/lib/vault-core";
import { supabase } from "@/lib/supabase";

type Row = { id: string; kind: string; number: string; invoice_date: string; due_date: string | null; total_paise: number; status: string; source: string; issues: string[]; parties: { name: string; gstin: string | null } | null };
const STATUS: Record<string, string> = { review: "to review (photo)", draft: "draft", posted: "posted", cancelled: "cancelled" };

// Sales register, purchase register, or everything waiting for review.
export default function Register() {
  const { book, biz, kind } = useLocalSearchParams<{ book: string; biz: string; kind: "sale" | "purchase" | "pending" }>();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    let query = supabase.from("invoices").select("id,kind,number,invoice_date,due_date,total_paise,status,source,issues,parties(name,gstin)").eq("book_id", book)
      .order("invoice_date", { ascending: false }).limit(500);
    query = kind === "pending" ? query.in("status", ["draft", "review"]) : query.eq("kind", kind);
    const { data, error } = await query;
    setErr(error ? "Could not load. Try again." : null);
    setRows((data ?? []) as unknown as Row[]);
  }, [book, kind]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const shown = rows.filter((r) => textMatches(q, r.number, r.parties?.name, r.parties?.gstin));
  const posted = shown.filter((r) => r.status === "posted").reduce((s, r) => s + Number(r.total_paise), 0);
  const title = kind === "pending" ? "Waiting for review" : kind === "sale" ? "Sales register" : "Purchase register";
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        <Field label="Search number, name or GSTIN" value={q} onChangeText={setQ} />
        {err && <P danger>{err}</P>}
        {kind !== "pending" && <P muted>{shown.length} invoices · posted total {formatINR(posted)} (latest 500)</P>}
        {shown.length === 0 && !err && <P muted>Nothing here yet.</P>}
        {shown.map((r) => (
          <Pressable key={r.id} accessibilityRole="button" onPress={() => router.push({ pathname: "/business/invoice", params: { book, biz, id: r.id } })}>
            <Card>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ fontWeight: "700", fontSize: 16, color: colors.text, flex: 1 }}>{r.number} · {r.parties?.name ?? "—"}</Text>
                <Text style={{ fontWeight: "700", fontSize: 16, color: colors.text }}>{formatINR(Number(r.total_paise))}</Text>
              </View>
              <P muted>{r.invoice_date}{r.due_date ? ` · due ${r.due_date}` : ""} · {kind === "pending" ? `${r.kind} · ` : ""}{STATUS[r.status] ?? r.status}</P>
              {r.status !== "posted" && r.issues.length > 0 && <P danger>{r.issues.length} problem{r.issues.length > 1 ? "s" : ""} to fix</P>}
            </Card>
          </Pressable>
        ))}
      </ScrollView>
    </Screen>
  );
}
