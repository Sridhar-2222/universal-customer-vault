import * as DocumentPicker from "expo-document-picker";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Card, Chips, colors, Field, H2, P, Screen } from "@/components/ui";
import { BUCKET, supabase } from "@/lib/supabase";
import { snippet, textMatches } from "@/lib/vault-core";

type Doc = { id: string; title: string; kind: string; doc_date: string | null; remind_on: string | null; file_path: string; ocr_text: string | null; sent_by_business: string | null; created_at: string; owner_id: string };
const KINDS = ["invoice", "receipt", "purchase", "warranty", "booking", "appointment", "personal", "contract", "id", "other"] as const;
type Kind = (typeof KINDS)[number];
const MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };

// The customer's own vault: their documents plus what linked businesses sent them. Search covers titles and any
// text read from the document (OCR is the next stage; see docs/ROADMAP.md).
export default function Vault() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [uid, setUid] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    const { data: u } = await supabase.auth.getUser();
    setUid(u.user?.id ?? null);
    const { data, error } = await supabase.from("vault_documents").select("id,title,kind,doc_date,remind_on,file_path,ocr_text,sent_by_business,created_at,owner_id").order("created_at", { ascending: false }).limit(500);
    if (error) setErr("Could not load your vault. Check the internet and try again.");
    else setDocs((data ?? []) as Doc[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mine = (docs ?? []).filter((d) => d.owner_id === uid);
  const shown = mine.filter((d) => textMatches(q, d.title, d.kind, d.ocr_text));

  async function open(path: string) {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
    if (data?.signedUrl) await Linking.openURL(data.signedUrl);
  }
  async function remove(id: string) {
    const { data: path, error } = await supabase.rpc("delete_my_document", { p_id: id });
    if (!error && path) await supabase.storage.from(BUCKET).remove([path as string]);
    void load();
  }
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <AddDocument onDone={load} />
        <Field label="Search your vault" value={q} onChangeText={setQ} placeholder="Title, type or words inside" />
        {err && <P danger>{err}</P>}
        {docs && shown.length === 0 && <P muted>{q ? "Nothing matches." : "Your vault is empty. Add your first bill or warranty above."}</P>}
        {shown.map((d) => (
          <Card key={d.id}>
            <H2>{d.title}</H2>
            <P muted>{d.kind}{d.doc_date ? ` · ${d.doc_date}` : ""}{d.remind_on ? ` · reminder ${d.remind_on}` : ""}{d.sent_by_business ? " · sent by a business" : ""}</P>
            {q.length >= 3 && d.ocr_text && textMatches(q, d.ocr_text) && <P muted>{snippet(d.ocr_text, q)}</P>}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}><Button title="Open" onPress={() => void open(d.file_path)} /></View>
              <View style={{ flex: 1 }}><Button title="Delete" kind="danger" onPress={() => void remove(d.id)} /></View>
            </View>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}

function AddDocument({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Kind>("invoice");
  const [docDate, setDocDate] = useState("");
  const [remind, setRemind] = useState("");
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dateOk = (v: string) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v);

  async function pick() {
    const r = await DocumentPicker.getDocumentAsync({ type: MIMES, copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    if (!a.mimeType || !MIMES.includes(a.mimeType)) { setMsg("Only photos (JPG, PNG, WEBP, HEIC) or PDF."); return; }
    if ((a.size ?? 0) > 20 * 1024 * 1024) { setMsg("The file is over 20 MB."); return; }
    setFile(a); setMsg(null);
    if (!title.trim()) setTitle(a.name.replace(/\.[^.]+$/, "").slice(0, 120));
  }
  async function save() {
    if (!file || !file.mimeType) return;
    setBusy(true); setMsg(null);
    try {
      const { data: u } = await supabase.auth.getUser();
      const path = `${u.user!.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${EXT[file.mimeType]}`;
      const body = await (await fetch(file.uri)).arrayBuffer();
      const up = await supabase.storage.from(BUCKET).upload(path, body, { contentType: file.mimeType, upsert: false });
      if (up.error) throw up.error;
      const { error } = await supabase.rpc("add_my_document", {
        p_title: title.trim(), p_kind: kind, p_domain: "personal", p_file_path: path, p_mime: file.mimeType,
        p_size: file.size ?? body.byteLength, p_doc_date: docDate || null, p_remind_on: remind || null, p_ocr_text: null,
      });
      if (error) { await supabase.storage.from(BUCKET).remove([path]); throw error; }
      setOpen(false); setTitle(""); setFile(null); setDocDate(""); setRemind(""); onDone();
    } catch {
      setMsg("Could not save. Check the internet and try again.");
    } finally { setBusy(false); }
  }
  if (!open) return <Button title="＋ Add a document" onPress={() => setOpen(true)} />;
  return (
    <Card>
      <H2>Add a document</H2>
      <Button title={file ? `Chosen: ${file.name}` : "Choose photo or PDF"} kind="outline" onPress={() => void pick()} />
      <Field label="What is it?" value={title} onChangeText={setTitle} maxLength={120} placeholder="e.g. Fridge warranty" />
      <Text style={{ fontWeight: "600", color: colors.text }}>Type</Text>
      <Chips value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: k }))} />
      <Field label="Date on the paper (YYYY-MM-DD, optional)" value={docDate} onChangeText={setDocDate} maxLength={10} />
      <Field label="Remind me on (YYYY-MM-DD, optional)" value={remind} onChangeText={setRemind} maxLength={10} />
      {msg && <P danger>{msg}</P>}
      <Button title="Save to vault" onPress={() => void save()} busy={busy} disabled={!file || !title.trim() || !dateOk(docDate) || !dateOk(remind)} />
      <Pressable onPress={() => setOpen(false)}><P muted>Cancel</P></Pressable>
    </Card>
  );
}
