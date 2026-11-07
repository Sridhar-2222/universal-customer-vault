// Passes what was read from a bill photo to the invoice screen without putting it in the address bar.
// Kept in memory only: if the page is reloaded the reading is gone (the stored photo stays in the business folder).
import type { InvoiceDraft } from "./invoice";

export type ScanMeta = { engine?: string; ms?: number; warnings: string[]; confidence: Record<string, number> };
export type Scan = { draft: InvoiceDraft; ocr: ScanMeta; fileId: string; filePath: string; mime: string };

const store = new Map<string, Scan>();
export function putScan(s: Scan): string {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  store.set(key, s);
  return key;
}
export const getScan = (key: string | undefined): Scan | null => (key ? store.get(key) ?? null : null);
export const dropScan = (key: string) => store.delete(key);
