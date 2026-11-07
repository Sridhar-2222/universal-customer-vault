// Business-neutral document kinds for the generic vault. Replace or extend for a specific trade (Rx Fingertip uses
// pharmacy rules in its own src/lib/customer-vault.ts).
import type { KindRule } from "./vault-core";

export const GENERIC_KINDS = ["invoice", "receipt", "report", "contract", "id", "prescription", "letter", "other"] as const;
export type GenericKind = (typeof GENERIC_KINDS)[number];

export const GENERIC_RULES: readonly KindRule[] = [
  { kind: "invoice", words: [/\b(invoice|tax invoice|gstin|gst|hsn|amount due|due date|bill to|grand total|cgst|sgst|igst)\b/i] },
  { kind: "receipt", words: [/\b(receipt|received with thanks|paid|payment received|cash memo|txn id|upi ref)\b/i] },
  { kind: "report", words: [/\b(report|result|reference range|findings|assessment|laborator|specimen|observation)\b/i] },
  { kind: "contract", words: [/\b(agreement|contract|terms and conditions|hereinafter|party of the first part|witness|lease|tenure)\b/i] },
  { kind: "id", words: [/\b(aadhaar|pan card|passport|voter id|driving licen[cs]e|date of birth|dob|government of india)\b/i] },
  { kind: "prescription", words: [/\b(rx|dr|tab|cap|syrup|mg|once daily|twice daily|after food|before food)\b/i] },
  { kind: "letter", words: [/\b(dear|sincerely|regards|subject:|to whomsoever)\b/i] },
];
