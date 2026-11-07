import { expect, test } from "bun:test";
import { fileFromText } from "./filing";
import { textMatches } from "./vault-core";

const today = new Date("2026-11-07T10:00:00Z");
test("documents are filed from their text", () => {
  expect(fileFromText("TAX INVOICE GSTIN 27AAPFU0939F1ZV Invoice No 42 Date 05/11/2026 Grand Total 1,180", { today })).toMatchObject({ kind: "invoice", docDate: "2026-11-05" });
  expect(fileFromText("Payment received with thanks. UPI Ref 9988. 03-11-26", { today }).kind).toBe("receipt");
  expect(textMatches("1180 invoice", "Invoice total 1180")).toBe(true);
});
