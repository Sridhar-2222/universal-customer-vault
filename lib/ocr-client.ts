// Sends a bill photo or PDF to the OCR service (ocr-service/) with the person's sign-in token, and returns the
// text lines with positions and confidence. The service keeps nothing. The address is public configuration:
// EXPO_PUBLIC_OCR_URL (see .env.example). Turning lines into invoice fields happens in lib/ocr-extract.ts.
import { Platform } from "react-native";
import type { OcrResult } from "./ocr-extract";
import { supabase } from "./supabase";

const OCR_URL = (process.env.EXPO_PUBLIC_OCR_URL ?? "").replace(/\/+$/, "");
/** https only, except a test service on this machine. */
export const ocrConfigured = /^(https:\/\/.+|http:\/\/(127\.0\.0\.1|localhost):\d+)$/.test(OCR_URL);
export const OCR_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const OCR_MAX_BYTES = 15 * 1024 * 1024;

export type PickedFile = { uri: string; name: string; mime: string; bytes: ArrayBuffer };

const reasons: Record<string, string> = {
  sign_in_required: "Please sign in again, then retry.",
  too_big: "The file is over 15 MB. Take the photo again at a lower size.",
  bad_type: "Only JPG, PNG, WEBP photos or PDF files can be read.",
  could_not_read: "The bill could not be read. Try a sharper, well-lit photo, flat and straight.",
  not_configured: "The reading service is not set up yet.",
};

export async function readBill(f: PickedFile, signal?: AbortSignal): Promise<OcrResult> {
  if (!ocrConfigured) throw new Error(reasons.not_configured);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error(reasons.sign_in_required);
  const form = new FormData();
  if (Platform.OS === "web") form.append("file", new Blob([f.bytes], { type: f.mime }), f.name);
  else form.append("file", { uri: f.uri, name: f.name, type: f.mime } as unknown as Blob);
  let r: Response;
  try {
    r = await fetch(`${OCR_URL}/read`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form, signal });
  } catch {
    throw new Error("Could not reach the reading service. Check the internet connection and try again.");
  }
  if (!r.ok) {
    const detail = await r.json().then((j: { detail?: string }) => j.detail ?? "", () => "");
    throw new Error(reasons[detail] ?? "The reading service had a problem. Try again in a minute.");
  }
  return (await r.json()) as OcrResult;
}
