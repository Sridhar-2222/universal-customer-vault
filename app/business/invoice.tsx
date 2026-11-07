import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button, Card, Chips, colors, Field, H2, P, Screen } from "@/components/ui";
import { formatINR } from "@/lib/accounting";
import { plainError } from "@/lib/books";
import { emptyInvoice, GST_RATES, invoiceIssues, issueText, roundOff, suggestTaxes, taxableTotal, toPayload, type InvoiceDraft, type InvoiceKind, type ItemDraft } from "@/lib/invoice";
import { iso } from "@/lib/periods";
import { dropScan, getScan } from "@/lib/scan-handoff";
import { BUCKET, supabase } from "@/lib/supabase";
import { useBusiness } from "@/lib/use-business";

type Saved = { id: string; status: string; source: string; total_paise: number; issues: string[]; ocr: { confidence?: Record<string, number>; engine?: string; warnings?: string[] } | null };
type BillFile = { path: string; mime: string | null };
type Payment = { id: string; paid_on: string; amount_paise: number; mode: string; reference: string | null };

// Money typed as text; empty means 0. Returns NaN for anything that is not an amount.
const money = (t: string) => { const s = t.replace(/[₹,\s]/g, ""); if (!s) return 0; return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN; };
const rupees = (p: number) => (p ? (p / 100).toFixed(2).replace(/\.00$/, "") : "");

// One screen for typing an invoice, reviewing one read from a photo, approving (posting) it, and payments.
export default function InvoiceScreen() {
  const params = useLocalSearchParams<{ book: string; biz: string; kind?: string; id?: string; scan?: string }>();
  const { info, canApprove } = useBusiness(params.biz);
  // A bill just read from a photo (scan.tsx): not saved yet; saving stores it for review with the photo linked.
  const [scan] = useState(() => getScan(params.scan));
  const [file, setFile] = useState<BillFile | null>(() => (scan ? { path: scan.filePath, mime: scan.mime } : null));
  const [d, setD] = useState<InvoiceDraft>(() => scan?.draft ?? emptyInvoice((params.kind as InvoiceKind) ?? "sale", iso(new Date())));
  const [text, setText] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Saved | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async (id: string) => {
    const { data } = await supabase.from("invoices")
      .select("id,kind,number,invoice_date,due_date,cgst_paise,sgst_paise,igst_paise,total_paise,status,source,issues,ocr,parties(name,gstin,phone),business_files(file_path,mime),invoice_items(line_no,description,hsn,qty,unit,rate_paise,discount_paise,gst_rate)")
      .eq("id", id).maybeSingle();
    if (!data) return;
    const r = data as unknown as {
      id: string; kind: InvoiceKind; number: string; invoice_date: string; due_date: string | null; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number;
      status: string; source: string; issues: string[]; ocr: Saved["ocr"]; parties: { name: string; gstin: string | null; phone: string | null } | null;
      business_files: { file_path: string; mime: string | null } | null;
      invoice_items: { line_no: number; description: string; hsn: string | null; qty: number; unit: string | null; rate_paise: number; discount_paise: number; gst_rate: number | null }[];
    };
    const items = [...r.invoice_items].sort((a, b) => a.line_no - b.line_no).map((i) => ({ description: i.description, hsn: i.hsn ?? "", qty: Number(i.qty), unit: i.unit ?? "",
      ratePaise: Number(i.rate_paise), discountPaise: Number(i.discount_paise), gstRate: i.gst_rate == null ? null : Number(i.gst_rate) }));
    const draft: InvoiceDraft = { kind: r.kind, number: r.number, date: r.invoice_date, dueDate: r.due_date, party: { name: r.parties?.name ?? "", gstin: r.parties?.gstin ?? "", phone: r.parties?.phone ?? "" },
      items, cgstPaise: Number(r.cgst_paise), sgstPaise: Number(r.sgst_paise), igstPaise: Number(r.igst_paise), totalPaise: Number(r.total_paise) };
    setD(draft); setText(textFrom(draft));
    if (r.business_files) setFile({ path: r.business_files.file_path, mime: r.business_files.mime });
    setSaved({ id: r.id, status: r.status, source: r.source, total_paise: Number(r.total_paise), issues: r.issues, ocr: r.ocr });
    const p = await supabase.from("payments").select("id,paid_on,amount_paise,mode,reference").eq("invoice_id", id).order("paid_on");
    setPayments((p.data ?? []) as Payment[]);
  }, []);
  useEffect(() => { if (params.id) void load(params.id); else setText(textFrom(d)); }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = saved?.status === "posted" || saved?.status === "cancelled";
  const issues = useMemo(() => invoiceIssues(d, info?.gstin), [d, info?.gstin]);
  const badMoney = Object.entries(text).some(([k, v]) => /rate|disc|cgst|sgst|igst|total/.test(k) && Number.isNaN(money(v)));
  const fromPhoto = saved ? saved.source === "ocr" : !!scan;
  const ocrInfo = saved?.ocr ?? scan?.ocr ?? null;
  const conf = ocrInfo?.confidence ?? {};
  const unsure = (field: string) => conf[field] != null && conf[field]! < 0.8;

  function setField(key: string, value: string) {
    const t = { ...text, [key]: value };
    setText(t); setD(draftFrom(d, t));
  }
  function setItems(items: ItemDraft[]) { const nd = { ...d, items }; setD(nd); setText({ ...textFrom(nd), ...headText(text) }); }
  function fillTax() {
    const s = suggestTaxes(d, info?.gstin);
    if (!s) { setMsg({ text: "Set a GST rate on every item first.", bad: true }); return; }
    const t: Record<string, string> = { ...text, cgst: rupees(s.cgst), sgst: rupees(s.sgst), igst: rupees(s.igst) };
    if (!money(t.total ?? "")) t.total = rupees(taxableTotal(d) + s.cgst + s.sgst + s.igst);
    setText(t); setD(draftFrom(d, t));
  }

  async function save() {
    setBusy(true); setMsg(null);
    const first = !saved && scan;
    const { data, error } = await supabase.rpc("save_invoice", { p_book: params.book, p_invoice: toPayload(d, first ? scan.ocr : undefined),
      p_source: saved?.source ?? (scan ? "ocr" : "manual"), p_document: null, p_id: saved?.id ?? null });
    if (error || !data) { setBusy(false); setMsg({ text: plainError(error?.message ?? ""), bad: true }); return; }
    if (first) {
      const a = await supabase.rpc("attach_invoice_file", { p_invoice: data as string, p_file: scan.fileId });
      if (a.error) { setBusy(false); setMsg({ text: "Saved, but the photo could not be linked. Try saving again.", bad: true }); await load(data as string); return; }
      dropScan(params.scan!);
    }
    setBusy(false);
    // Keep the saved invoice in the address, so reopening or reloading the page shows it (not a blank form).
    if (!saved) router.setParams({ id: data as string, scan: undefined });
    await load(data as string);
    setMsg({ text: scan ? "Saved for review. It is not in the books until it is posted." : "Saved as a draft. It is not in the books until it is posted." });
  }
  async function post() {
    if (!saved) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc("post_invoice", { p_invoice: saved.id, p_confirm: confirm });
    setBusy(false);
    if (error) { setMsg({ text: plainError(error.message), bad: true }); await load(saved.id); return; }
    await load(saved.id); setMsg({ text: "Posted to the books." });
  }
  async function cancel() {
    if (!saved) return;
    const { data, error } = await supabase.rpc("cancel_invoice", { p_invoice: saved.id });
    if (error) { setMsg({ text: plainError(error.message), bad: true }); return; }
    if (data === "deleted") router.back(); else await load(saved.id);
  }

  const title = `${d.kind === "sale" ? "Sale invoice" : "Purchase bill"}${saved ? ` · ${saved.status === "review" ? "to review" : saved.status}` : ""}`;
  const paid = payments.reduce((s, p) => s + Number(p.amount_paise), 0);
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        {fromPhoto && !locked && (
          <Card>
            <H2>Read from a photo — please check</H2>
            <P muted>Compare every field with the paper bill. Fields marked "check" were read with low confidence. Nothing goes into the books until it is posted.</P>
            {ocrInfo?.warnings?.map((w, i) => <P key={i} danger>{w}</P>)}
          </Card>
        )}
        {file && <BillPhoto file={file} />}
        <Card>
          {!saved && <Chips value={d.kind} onChange={(k) => setD({ ...d, kind: k })} options={[{ value: "sale", label: "Sale" }, { value: "purchase", label: "Purchase" }]} />}
          <Field label={`${d.kind === "sale" ? "Customer" : "Supplier"} name${unsure("party") ? " — check" : ""}`} value={text.party ?? ""} onChangeText={(v) => setField("party", v)} editable={!locked} maxLength={120} />
          <Field label={`GSTIN (optional)${unsure("gstin") ? " — check" : ""}`} value={text.gstin ?? ""} onChangeText={(v) => setField("gstin", v.toUpperCase())} editable={!locked} autoCapitalize="characters" maxLength={15} />
          <Field label={`Invoice number${unsure("number") ? " — check" : ""}`} value={text.number ?? ""} onChangeText={(v) => setField("number", v)} editable={!locked} maxLength={40} />
          <Field label={`Date (YYYY-MM-DD)${unsure("date") ? " — check" : ""}`} value={text.date ?? ""} onChangeText={(v) => setField("date", v)} editable={!locked} maxLength={10} />
          <Field label="Due date (optional)" value={text.due ?? ""} onChangeText={(v) => setField("due", v)} editable={!locked} maxLength={10} />
        </Card>
        <Card>
          <H2>Items</H2>
          {d.items.map((it, i) => (
            <View key={i} style={{ gap: 8, borderTopWidth: i ? 1 : 0, borderColor: colors.line, paddingTop: i ? 10 : 0 }}>
              <Field label={`Item ${i + 1}${unsure(`item${i}`) ? " — check" : ""}`} value={text[`desc${i}`] ?? ""} onChangeText={(v) => setField(`desc${i}`, v)} editable={!locked} maxLength={200} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}><Field label="Qty" value={text[`qty${i}`] ?? ""} onChangeText={(v) => setField(`qty${i}`, v)} keyboardType="decimal-pad" editable={!locked} /></View>
                <View style={{ flex: 1 }}><Field label="Rate ₹" value={text[`rate${i}`] ?? ""} onChangeText={(v) => setField(`rate${i}`, v)} keyboardType="decimal-pad" editable={!locked} /></View>
                <View style={{ flex: 1 }}><Field label="Disc ₹" value={text[`disc${i}`] ?? ""} onChangeText={(v) => setField(`disc${i}`, v)} keyboardType="decimal-pad" editable={!locked} /></View>
              </View>
              <Field label="HSN/SAC (optional)" value={text[`hsn${i}`] ?? ""} onChangeText={(v) => setField(`hsn${i}`, v.replace(/\D/g, ""))} keyboardType="number-pad" editable={!locked} maxLength={8} />
              {!locked && <Chips value={String(it.gstRate ?? "none")} onChange={(v) => setItems(d.items.map((x, j) => (j === i ? { ...x, gstRate: v === "none" ? null : Number(v) } : x)))}
                options={[...[0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` })), ...(it.gstRate != null && ![0, 5, 12, 18, 28].includes(it.gstRate) && (GST_RATES as readonly number[]).includes(it.gstRate) ? [{ value: String(it.gstRate), label: `${it.gstRate}%` }] : []), { value: "none", label: "No rate" }]} />}
              {locked && <P muted>GST {it.gstRate ?? "—"}%</P>}
              <P muted>Taxable {formatINR(Math.max(0, Math.round(it.qty * it.ratePaise) - (it.discountPaise ?? 0)))}</P>
              {!locked && d.items.length > 1 && <Button title="Remove item" kind="danger" onPress={() => setItems(d.items.filter((_, j) => j !== i))} />}
            </View>
          ))}
          {!locked && <Button title="+ Add item" kind="outline" onPress={() => setItems([...d.items, { description: "", qty: 1, ratePaise: 0, gstRate: d.items.at(-1)?.gstRate ?? 18 }])} />}
        </Card>
        <Card>
          <H2>GST and total</H2>
          <P>Taxable value {formatINR(taxableTotal(d))}</P>
          {!locked && <Button title="Fill GST from the item rates" kind="outline" onPress={fillTax} />}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}><Field label={`CGST ₹${unsure("cgst") ? " — check" : ""}`} value={text.cgst ?? ""} onChangeText={(v) => setField("cgst", v)} keyboardType="decimal-pad" editable={!locked} /></View>
            <View style={{ flex: 1 }}><Field label={`SGST ₹${unsure("sgst") ? " — check" : ""}`} value={text.sgst ?? ""} onChangeText={(v) => setField("sgst", v)} keyboardType="decimal-pad" editable={!locked} /></View>
            <View style={{ flex: 1 }}><Field label={`IGST ₹${unsure("igst") ? " — check" : ""}`} value={text.igst ?? ""} onChangeText={(v) => setField("igst", v)} keyboardType="decimal-pad" editable={!locked} /></View>
          </View>
          <Field label={`Grand total ₹${unsure("total") ? " — check" : ""}`} value={text.total ?? ""} onChangeText={(v) => setField("total", v)} keyboardType="decimal-pad" editable={!locked} />
          <P muted>Round off {formatINR(roundOff(d))} (up to ₹1 allowed)</P>
          {!locked && (badMoney ? <P danger>Amounts must be numbers like 1250 or 1250.50.</P>
            : issues.length ? issues.map((x) => <P key={x} danger>• {issueText[x]}</P>) : <P ok>All checks pass.</P>)}
          {!locked && saved?.issues.includes("duplicate_number") && <P danger>• {issueText.duplicate_number}</P>}
        </Card>

        {msg && <P danger={msg.bad} ok={!msg.bad}>{msg.text}</P>}
        {!locked && <Button title={saved ? "Save changes" : scan ? "Save for review" : "Save as draft"} onPress={() => void save()} busy={busy} disabled={badMoney} />}
        {saved && !locked && (canApprove ? (
          <Card>
            <H2>Approve</H2>
            {saved.source === "ocr" && (
              <Pressable onPress={() => setConfirm(!confirm)} accessibilityRole="checkbox" accessibilityState={{ checked: confirm }} style={{ flexDirection: "row", gap: 10, alignItems: "center", minHeight: 44 }}>
                <Text style={{ fontSize: 22 }}>{confirm ? "☑" : "☐"}</Text>
                <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>I checked these details against the paper bill.</Text>
              </Pressable>
            )}
            <P muted>Posting puts this into the books. Afterwards it can only be cancelled by a reversing entry, not edited.</P>
            <Button title="Post to books" onPress={() => void post()} busy={busy} disabled={issues.length > 0 || badMoney || (saved.source === "ocr" && !confirm)} />
          </Card>
        ) : <P muted>Saved. The owner or an admin will check and post it.</P>)}
        {saved && saved.status === "posted" && (
          <PaymentsCard invoice={saved.id} kind={d.kind} due={saved.total_paise - paid} payments={payments} onDone={() => void load(saved.id)} />
        )}
        {saved && saved.status !== "cancelled" && (saved.status !== "posted" || canApprove) && (
          <Button title={saved.status === "posted" ? "Cancel invoice (reversing entry)" : "Delete draft"} kind="danger" onPress={() => void cancel()} />
        )}
        {saved?.status === "cancelled" && <P muted>Cancelled. A reversing entry removed it from the books; the record is kept.</P>}
      </ScrollView>
    </Screen>
  );
}

// The stored bill, opened with a short-lived private link (the folder is private to the business's members).
function BillPhoto({ file }: { file: BillFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void supabase.storage.from(BUCKET).createSignedUrl(file.path, 600).then(({ data }) => {
      if (!live) return;
      if (data?.signedUrl) setUrl(data.signedUrl); else setFailed(true);
    });
    return () => { live = false; };
  }, [file.path]);
  const pdf = file.mime === "application/pdf" || file.path.endsWith(".pdf");
  return (
    <Card>
      <H2>The bill</H2>
      {failed ? <P danger>Could not open the stored bill. Check the internet and reopen this screen.</P>
        : !url ? <P muted>Loading the bill…</P>
        : pdf ? <Button title="Open the PDF" kind="outline" onPress={() => void Linking.openURL(url)} />
        : <Image source={{ uri: url }} accessibilityLabel="Bill photo" resizeMode="contain" onError={() => setFailed(true)}
            style={{ width: "100%", height: 420, backgroundColor: "#eef1f5", borderRadius: 8 }} />}
    </Card>
  );
}

function PaymentsCard({ invoice, kind, due, payments, onDone }: { invoice: string; kind: InvoiceKind; due: number; payments: Payment[]; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"cash" | "bank">("bank");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const p = money(amount);
  async function add() {
    setErr(null);
    const { error } = await supabase.rpc("record_payment", { p_invoice: invoice, p_date: iso(new Date()), p_amount: p, p_mode: mode, p_reference: ref || null });
    if (error) { setErr(plainError(error.message)); return; }
    setAmount(""); setRef(""); onDone();
  }
  return (
    <Card>
      <H2>{kind === "sale" ? "Money received" : "Money paid"}</H2>
      {payments.map((x) => <P key={x.id}>{x.paid_on} · {formatINR(Number(x.amount_paise))} · {x.mode}{x.reference ? ` · ${x.reference}` : ""}</P>)}
      <P ok={due === 0}>{due === 0 ? "Fully settled." : `Still due ${formatINR(due)}`}</P>
      {due > 0 && (
        <>
          <Field label="Amount ₹" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={rupees(due)} />
          <Chips value={mode} onChange={setMode} options={[{ value: "bank", label: "Bank / UPI" }, { value: "cash", label: "Cash" }]} />
          <Field label="Reference (optional)" value={ref} onChangeText={setRef} maxLength={60} />
          {err && <P danger>{err}</P>}
          <Button title="Record payment" onPress={() => void add()} disabled={!(p > 0)} />
        </>
      )}
    </Card>
  );
}

function headText(t: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const k of ["party", "gstin", "number", "date", "due", "cgst", "sgst", "igst", "total"]) if (t[k] != null) out[k] = t[k]!;
  return out;
}
function textFrom(d: InvoiceDraft): Record<string, string> {
  const t: Record<string, string> = { party: d.party.name, gstin: d.party.gstin ?? "", number: d.number, date: d.date, due: d.dueDate ?? "",
    cgst: rupees(d.cgstPaise), sgst: rupees(d.sgstPaise), igst: rupees(d.igstPaise), total: rupees(d.totalPaise) };
  d.items.forEach((i, n) => { t[`desc${n}`] = i.description; t[`qty${n}`] = String(i.qty); t[`rate${n}`] = rupees(i.ratePaise); t[`disc${n}`] = rupees(i.discountPaise ?? 0); t[`hsn${n}`] = i.hsn ?? ""; });
  return t;
}
function draftFrom(d: InvoiceDraft, t: Record<string, string>): InvoiceDraft {
  const num = (v: string | undefined) => { const x = money(v ?? ""); return Number.isNaN(x) ? 0 : x; };
  return {
    ...d, number: t.number ?? "", date: t.date ?? "", dueDate: t.due || null, party: { name: t.party ?? "", gstin: t.gstin || null },
    items: d.items.map((i, n) => ({ ...i, description: t[`desc${n}`] ?? "", hsn: t[`hsn${n}`] ?? "", qty: Number(t[`qty${n}`] || 0), ratePaise: num(t[`rate${n}`]), discountPaise: num(t[`disc${n}`]) })),
    cgstPaise: num(t.cgst), sgstPaise: num(t.sgst), igstPaise: num(t.igst), totalPaise: num(t.total),
  };
}
