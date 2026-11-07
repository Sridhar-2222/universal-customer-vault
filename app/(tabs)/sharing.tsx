import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, Card, Field, H2, P, Screen } from "@/components/ui";
import { supabase } from "@/lib/supabase";

type Link = { business_id: string; status: string; consent_at: string; businesses: { name: string } | null };
type Share = { id: string; document_id: string; grantee_business: string | null; grantee_user: string | null; expires_at: string | null; revoked_at: string | null; vault_documents: { title: string } | null };

// The customer decides who may send to their vault and who may see which document; everything can be revoked.
export default function Sharing() {
  const [links, setLinks] = useState<Link[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data: u } = await supabase.auth.getUser();
    const [l, s] = await Promise.all([
      supabase.from("customer_links").select("business_id,status,consent_at,businesses(name)").eq("customer_id", u.user?.id ?? ""),
      supabase.from("document_shares").select("id,document_id,grantee_business,grantee_user,expires_at,revoked_at,vault_documents(title)").eq("owner_id", u.user?.id ?? "").is("revoked_at", null),
    ]);
    setLinks((l.data ?? []) as unknown as Link[]); setShares((s.data ?? []) as unknown as Share[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function check() {
    setMsg(null);
    const { data } = await supabase.rpc("preview_business_code", { p_code: code });
    const row = (data as { business_name: string }[] | null)?.[0];
    setPreview(row?.business_name ?? null);
    if (!row) setMsg("No business has that code.");
  }
  async function link() {
    const { error } = await supabase.rpc("link_business", { p_code: code, p_consent: true });
    setMsg(error ? "Could not link. Try again." : "Linked. This business can now send documents to your vault.");
    setCode(""); setPreview(null); void load();
  }
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Card>
          <H2>Let a business send you documents</H2>
          <P muted>Ask the shop or agency for its 8-letter code. It can then send bills and warranties to your vault, but it can never browse your other documents.</P>
          <Field label="Business code" value={code} onChangeText={(v) => { setCode(v.toUpperCase()); setPreview(null); }} autoCapitalize="characters" maxLength={8} />
          {!preview ? <Button title="Check code" onPress={() => void check()} disabled={code.length !== 8} /> : (
            <>
              <P>This code belongs to: {preview}</P>
              <Button title={`I agree: let ${preview} send me documents`} onPress={() => void link()} />
            </>
          )}
          {msg && <P>{msg}</P>}
        </Card>
        <Card>
          <H2>Linked businesses</H2>
          {links.length === 0 ? <P muted>None yet.</P> : links.map((l) => (
            <View key={l.business_id} style={{ gap: 6 }}>
              <P>{l.businesses?.name ?? "Business"} · {l.status === "active" ? "can send" : "stopped"}</P>
              {l.status === "active" && <Button title="Stop" kind="danger" onPress={() => void supabase.rpc("unlink_business", { p_business: l.business_id }).then(load)} />}
            </View>
          ))}
        </Card>
        <Card>
          <H2>Documents you shared</H2>
          {shares.length === 0 ? <P muted>Nothing shared. Open a document's share option to share it.</P> : shares.map((s) => (
            <View key={s.id} style={{ gap: 6 }}>
              <P>{s.vault_documents?.title ?? "Document"} · {s.grantee_business ? "with a business" : "with a person"}{s.expires_at ? ` · until ${s.expires_at.slice(0, 10)}` : ""}</P>
              <Button title="Revoke" kind="danger" onPress={() => void supabase.rpc("revoke_share", { p_share: s.id }).then(load)} />
            </View>
          ))}
        </Card>
      </ScrollView>
    </Screen>
  );
}
