import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Image, ScrollView } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button, Card, H2, P, Screen } from "@/components/ui";
import { OCR_MAX_BYTES, OCR_TYPES, ocrConfigured, readBill, type PickedFile } from "@/lib/ocr-client";
import { extractInvoice } from "@/lib/ocr-extract";
import { iso } from "@/lib/periods";
import { putScan } from "@/lib/scan-handoff";
import { BUCKET, supabase } from "@/lib/supabase";
import { useBusiness } from "@/lib/use-business";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

// Read a bill from a photo or PDF: keep the file in the business's private folder, read it with the OCR service,
// then open the invoice screen with the photo and the fields read, for a person to check and save for review.
// Nothing reaches the books until an owner or admin posts it after ticking that they checked the paper.
export default function ScanBill() {
  const { book, biz } = useLocalSearchParams<{ book: string; biz: string }>();
  const { info } = useBusiness(biz);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [stored, setStored] = useState<{ id: string; path: string } | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function take(uri: string, name: string, mime: string | undefined, size: number | undefined) {
    setErr(null); setStored(null);
    const type = mime === "image/jpg" ? "image/jpeg" : mime ?? "";
    if (!(OCR_TYPES as readonly string[]).includes(type)) { setErr("Only JPG, PNG, WEBP photos or PDF files can be read."); return; }
    if ((size ?? 0) > OCR_MAX_BYTES) { setErr("The file is over 15 MB. Take the photo again at a lower size."); return; }
    const bytes = await (await fetch(uri)).arrayBuffer();
    if (bytes.byteLength > OCR_MAX_BYTES) { setErr("The file is over 15 MB. Take the photo again at a lower size."); return; }
    setFile({ uri, name: name || `bill.${EXT[type]}`, mime: type, bytes });
  }
  async function camera() {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) { setErr("Allow the camera in the phone settings, or choose a photo instead."); return; }
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9, exif: false });
    const a = r.canceled ? null : r.assets[0];
    if (a) await take(a.uri, a.fileName ?? "", a.mimeType ?? "image/jpeg", a.fileSize);
  }
  async function choose() {
    const r = await DocumentPicker.getDocumentAsync({ type: [...OCR_TYPES], copyToCacheDirectory: true });
    const a = r.canceled ? null : r.assets[0];
    if (a) await take(a.uri, a.name, a.mimeType, a.size);
  }

  async function read() {
    if (!file || !info) return;
    setErr(null);
    try {
      let s = stored;
      if (!s) { // store once; a retry after a reading error reuses the stored file
        setStep("Saving the photo privately…");
        const path = `b/${info.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${EXT[file.mime]}`;
        const up = await supabase.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.mime, upsert: false });
        if (up.error) throw new Error("Could not save the photo. Check the internet and try again.");
        const { data, error } = await supabase.rpc("add_business_file", { p_business: info.id, p_file_path: path, p_mime: file.mime, p_size: file.bytes.byteLength });
        if (error || !data) throw new Error("Could not save the photo. Check the internet and try again.");
        s = { id: data as string, path }; setStored(s);
      }
      setStep("Reading the bill… (this can take up to a minute)");
      const ocr = await readBill(file);
      const x = extractInvoice(ocr, { myGstin: info.gstin, today: iso(new Date()) });
      const key = putScan({ draft: x.draft, fileId: s.id, filePath: s.path, mime: file.mime,
        ocr: { engine: ocr.engine, ms: ocr.ms, warnings: x.warnings, confidence: x.confidence } });
      setStep(null);
      router.replace({ pathname: "/business/invoice", params: { book, biz, scan: key } });
    } catch (e) {
      setStep(null);
      setErr(e instanceof Error ? e.message : "Something went wrong. Try again.");
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "Read a bill photo" }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {!ocrConfigured && <Card><P danger>The bill reading service is not set up yet (EXPO_PUBLIC_OCR_URL). You can still type bills in.</P></Card>}
        <Card>
          <H2>1. Photo or PDF of the bill</H2>
          <P muted>Lay the bill flat in good light and fill the frame. Blurry, dark or handwritten bills are flagged for extra checking.</P>
          <Button title="Take a photo" onPress={() => void camera()} disabled={!!step} />
          <Button title="Choose a photo or PDF" kind="outline" onPress={() => void choose()} disabled={!!step} />
          {file && (file.mime === "application/pdf" ? <P>PDF chosen: {file.name}</P>
            : <Image source={{ uri: file.uri }} accessibilityLabel="Chosen bill photo" resizeMode="contain" style={{ width: "100%", height: 360, backgroundColor: "#eef1f5", borderRadius: 8 }} />)}
        </Card>
        {file && (
          <Card>
            <H2>2. Read it</H2>
            <P muted>The photo is kept in this business's private folder. You will check every field against the paper before it is saved.</P>
            {step && <P>{step}</P>}
            {err && <P danger>{err}</P>}
            <Button title={err ? "Try reading again" : "Read this bill"} onPress={() => void read()} busy={!!step} disabled={!ocrConfigured || !info} />
          </Card>
        )}
        {!file && err && <P danger>{err}</P>}
      </ScrollView>
    </Screen>
  );
}
