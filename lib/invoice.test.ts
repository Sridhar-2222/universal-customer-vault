import { expect, test } from "bun:test";
import { invoiceIssues, roundOff, suggestTaxes, taxableTotal, toPayload, type InvoiceDraft } from "./invoice";

const base: InvoiceDraft = {
  kind: "sale", number: "INV-101", date: "2026-10-20", party: { name: "Ravi Traders", gstin: "36AAACR5055K1Z8" },
  items: [{ description: "LED bulb", qty: 10, ratePaise: 10000, gstRate: 18 }, { description: "Wire", qty: 1, ratePaise: 200000, discountPaise: 20000, gstRate: 18 }],
  cgstPaise: 25200, sgstPaise: 25200, igstPaise: 0, totalPaise: 330400,
};
const MY = "36ABCDE1234F1Z1";

test("same checks as the database", () => {
  expect(taxableTotal(base)).toBe(280000);
  expect(invoiceIssues(base, MY)).toEqual([]);
  expect(invoiceIssues({ ...base, totalPaise: 330900 }, MY)).toEqual(["items_total_mismatch"]);
  expect(invoiceIssues({ ...base, cgstPaise: 0, sgstPaise: 0, igstPaise: 50400 }, MY)).toEqual(["wrong_tax_type"]);
  expect(invoiceIssues({ ...base, party: { name: "Shah", gstin: "27AAACS1234F1ZS" } }, MY)).toEqual(["wrong_tax_type"]);
  expect(invoiceIssues({ ...base, party: { name: "x", gstin: "36AAACR5055K1Z9" } }, MY)).toContain("bad_gstin");
  expect(invoiceIssues({ ...base, cgstPaise: 10000, sgstPaise: 10000, totalPaise: 300000 }, MY)).toEqual(["tax_rate_mismatch"]);
  expect(invoiceIssues({ ...base, number: " ", items: [] }, MY)).toEqual(["no_items", "no_number"]);
});
test("round-off and suggested taxes", () => {
  const ro: InvoiceDraft = { ...base, party: { name: "Walk-in" }, items: [{ description: "Switch", qty: 3, ratePaise: 3390, gstRate: 18 }], cgstPaise: 900, sgstPaise: 900, totalPaise: 12000 };
  expect(roundOff(ro)).toBe(30);
  expect(invoiceIssues(ro, MY)).toEqual([]);
  expect(suggestTaxes(base, MY)).toEqual({ cgst: 25200, sgst: 25200, igst: 0 });
  expect(suggestTaxes({ ...base, party: { name: "Shah", gstin: "27AAACS1234F1ZS" } }, MY)).toEqual({ cgst: 0, sgst: 0, igst: 50400 });
});
test("payload matches save_invoice", () => {
  const p = toPayload(base);
  expect(p.items[1]).toEqual({ description: "Wire", hsn: null, qty: 1, unit: null, rate: 200000, discount: 20000, gst_rate: 18 });
  expect(p.total).toBe(330400);
});
