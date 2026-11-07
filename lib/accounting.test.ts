import { expect, test } from "bun:test";
import { checkInvoice, formatINR, gstinValid, isBalanced, salesEntry, simpleEntry, toPaise } from "./accounting";

test("amounts are kept in paise", () => {
  expect(toPaise("1,250.50")).toBe(125050);
  expect(toPaise("₹ 99")).toBe(9900);
  expect(toPaise("0.5")).toBe(50);
  for (const bad of ["", "abc", "1.234", "-5", "0"]) expect(toPaise(bad)).toBeNull();
  expect(formatINR(12345678)).toBe("₹1,23,456.78");
  expect(formatINR(50)).toBe("₹0.50");
});
test("the balance rule matches the database", () => {
  expect(isBalanced(simpleEntry("expense", 125000, "CASH", "FOOD"))).toBe(true);
  expect(isBalanced(simpleEntry("income", 5000000, "BANK", "SALARY"))).toBe(true);
  expect(isBalanced([{ account: "A", debit: 100, credit: 0 }, { account: "B", debit: 0, credit: 90 }])).toBe(false);
  expect(isBalanced([{ account: "A", debit: 100, credit: 100 }, { account: "B", debit: 0, credit: 0 }])).toBe(false);
  expect(isBalanced([{ account: "A", debit: 100, credit: 0 }])).toBe(false);
  expect(isBalanced(salesEntry(100000, 9000, 9000, 0))).toBe(true);
});
test("GSTIN check digit", () => {
  expect(gstinValid("27AAPFU0939F1ZV")).toBe(true);
  expect(gstinValid("27AAPFU0939F1ZX")).toBe(false);
  expect(gstinValid("27AAPFU0939F1Z")).toBe(false);
});
test("invoice totals and taxes are checked before posting", () => {
  const ok = { items: [{ qty: 2, ratePaise: 50000 }], cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, grandTotalPaise: 118000, gstin: "27AAPFU0939F1ZV" };
  expect(checkInvoice(ok)).toEqual([]);
  expect(checkInvoice({ ...ok, grandTotalPaise: 120000 })).toEqual(["items_total_mismatch"]);
  expect(checkInvoice({ ...ok, sgstPaise: 8000, grandTotalPaise: 117000 })).toEqual(["cgst_sgst_differ"]);
  expect(checkInvoice({ ...ok, igstPaise: 18000, cgstPaise: 0, sgstPaise: 0 })).toEqual([]);
  expect(checkInvoice({ ...ok, gstin: "27AAPFU0939F1ZX" })).toEqual(["bad_gstin"]);
  expect(checkInvoice({ ...ok, items: [] })).toContain("no_items");
});
