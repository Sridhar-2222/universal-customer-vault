import { describe, expect, test } from "bun:test";
import { amountsIn, datesIn, extractInvoice, repairGstin, type OcrResult } from "./ocr-extract";
import { invoiceIssues } from "./invoice";

// Builds an OCR result from rows of [x, text] segments (as an engine would return boxes), 40px apart.
function page(rows: ([number, string] | [number, string, number])[][], conf = 0.95, big: number[] = []): OcrResult["pages"][number] {
  const lines = rows.flatMap((segs, i) => segs.map(([x, text, c]) => {
    const h = big.includes(i) ? 36 : 22, y = 30 + i * 40;
    return { text, conf: c ?? conf, box: [x, y, x + text.length * 11, y + h] as [number, number, number, number] };
  }));
  return { width: 1000, height: 30 + rows.length * 40, lines };
}
const MY = "36ABCDE1234F1Z1";
const purchaseRows: ([number, string] | [number, string, number])[][] = [
  [[300, "UDAYA FITTINGS"]],
  [[250, "Plot 12, Balanagar, Hyderabad 500037  Ph: 9876543210"]],
  [[300, "GSTIN: 36AAPFU0939F1ZW"]],
  [[380, "TAX INVOICE"]],
  [[40, "Invoice No: UF/2026/889"], [600, "Date: 15/10/2026"]],
  [[40, "Bill To: Sai Electricals"], [600, "Due Date: 25/10/2026"]],
  [[40, "GSTIN: 36ABCDE1234F1Z1"]],
  [[40, "S.No"], [110, "Description"], [420, "HSN"], [520, "Qty"], [620, "Rate"], [800, "Amount"]],
  [[40, "1"], [110, "LED bulb 9W"], [420, "8539"], [520, "100"], [620, "60.00"], [800, "6,000.00"]],
  [[40, "2"], [110, "Wire 90m"], [420, "8544"], [520, "2"], [620, "500.00"], [800, "1,000.00"]],
  [[560, "Sub Total"], [800, "7,000.00"]],
  [[560, "CGST @ 9%"], [800, "630.00"]],
  [[560, "SGST @ 9%"], [800, "630.00"]],
  [[560, "Grand Total"], [800, "8,260.00"]],
  [[40, "Rupees Eight Thousand Two Hundred Sixty Only"]],
];

describe("pieces", () => {
  test("amounts: Indian grouping, ₹/Rs, percentages and dates skipped, O→0 fixed", () => {
    expect(amountsIn("Grand Total ₹ 1,23,456.50")).toEqual([12345650]);
    expect(amountsIn("CGST @ 9% 630.00")).toEqual([63000]);
    expect(amountsIn("Total Rs.8,26O.00/-")).toEqual([826000]);
    expect(amountsIn("Date 15/10/2026")).toEqual([]);
    expect(amountsIn("CGST @ 14% 17.161.90")).toEqual([1716190]); // blurred comma read as a dot
    expect(amountsIn("Taxable 84.125.00 and 1,22.585.00")).toEqual([8412500, 12258500]);
    expect(amountsIn("Rate 2.50")).toEqual([250]);
  });
  test("dates: day first, several styles", () => {
    expect(datesIn("Date: 15/10/2026")).toEqual(["2026-10-15"]);
    expect(datesIn("Dated 5-Nov-26")).toEqual(["2026-11-05"]);
    expect(datesIn("15.10.2026")).toEqual(["2026-10-15"]);
    expect(datesIn("31/02/2026")).toEqual([]);
  });
  test("GSTIN: OCR look-alikes repaired only when the check digit then passes", () => {
    expect(repairGstin("36AAPFUO939F1ZW")).toEqual({ gstin: "36AAPFU0939F1ZW", repaired: true });
    expect(repairGstin("36AAPFU0939F1ZW")).toEqual({ gstin: "36AAPFU0939F1ZW", repaired: false });
    expect(repairGstin("36AAPFU0939F1ZX")).toBeNull();
  });
});

describe("extractInvoice", () => {
  test("a clean purchase bill: every field, and all checks pass", () => {
    const x = extractInvoice({ pages: [page(purchaseRows, 0.95, [0])] }, { myGstin: MY });
    expect(x.draft.kind).toBe("purchase");
    expect(x.draft.party).toEqual({ name: "UDAYA FITTINGS", gstin: "36AAPFU0939F1ZW" });
    expect(x.draft.number).toBe("UF/2026/889");
    expect(x.draft.date).toBe("2026-10-15");
    expect(x.draft.dueDate).toBe("2026-10-25");
    expect(x.draft.items.map((i) => [i.description, i.hsn, i.qty, i.ratePaise, i.gstRate])).toEqual([["LED bulb 9W", "8539", 100, 6000, 18], ["Wire 90m", "8544", 2, 50000, 18]]);
    expect([x.draft.cgstPaise, x.draft.sgstPaise, x.draft.igstPaise, x.draft.totalPaise]).toEqual([63000, 63000, 0, 826000]);
    expect(invoiceIssues(x.draft, MY)).toEqual([]);
    expect(x.warnings).toEqual([]);
    expect(x.confidence.total).toBeGreaterThanOrEqual(0.9);
  });
  test("OCR mistakes (O for 0, low confidence) are repaired and flagged with lower confidence", () => {
    const rows = purchaseRows.map((r) => r.map(([x, t]) => [x, t.replace("36AAPFU0939F1ZW", "36AAPFUO939F1ZW").replace("8,260.00", "8,26O.00")] as [number, string]));
    rows[4] = [[40, "Invoice No: UF/2026/889", 0.55], [600, "Date: 15/10/2026"]];
    const x = extractInvoice({ pages: [page(rows, 0.95, [0])] }, { myGstin: MY });
    expect(x.draft.party.gstin).toBe("36AAPFU0939F1ZW");
    expect(x.draft.totalPaise).toBe(826000);
    expect(x.confidence.gstin).toBeLessThan(0.8);
    expect(x.confidence.number).toBeLessThan(0.8);
    expect(invoiceIssues(x.draft, MY)).toEqual([]);
  });
  test("our own sale invoice to another state: kind sale, party is the buyer, IGST", () => {
    const x = extractInvoice({ pages: [page([
      [[300, "SAI ELECTRICALS"]], [[300, "GSTIN 36ABCDE1234F1Z1"]], [[380, "TAX INVOICE"]],
      [[40, "Invoice # SE-0457"], [600, "Invoice Date 02-Nov-2026"]],
      [[40, "Buyer:"], [200, "Shah & Co"]], [[40, "GSTIN: 27AAACS1234F1ZS"]],
      [[110, "Particulars"], [520, "Qty"], [620, "Rate"], [800, "Amount"]],
      [[110, "Switch board 6M"], [520, "5 Nos"], [620, "400.00"], [800, "2,000.00"]],
      [[560, "Taxable Value"], [800, "2,000.00"]], [[560, "IGST 18%"], [800, "360.00"]], [[560, "Total Amount"], [800, "2,360.00"]],
    ], 0.93, [0])] }, { myGstin: MY });
    expect(x.draft.kind).toBe("sale");
    expect(x.draft.party).toEqual({ name: "Shah & Co", gstin: "27AAACS1234F1ZS" });
    expect([x.draft.number, x.draft.date, x.draft.igstPaise, x.draft.totalPaise]).toEqual(["SE-0457", "2026-11-02", 36000, 236000]);
    expect(x.draft.items[0]).toMatchObject({ qty: 5, ratePaise: 40000, gstRate: 18 });
    expect(invoiceIssues(x.draft, MY)).toEqual([]);
  });
  test("no readable table: one clearly flagged line with the taxable value, never a silent guess", () => {
    const x = extractInvoice({ pages: [page([
      [[300, "RAMA HARDWARE"]], [[300, "GSTIN: 36AAACR5055K1Z8"]], [[40, "Bill No. 4471"], [600, "Date 03/11/2026"]],
      [[40, "~~ smudged ~~"]], [[560, "Taxable Value"], [800, "1,000.00"]], [[560, "CGST 9%"], [800, "90.00"]], [[560, "SGST 9%"], [800, "90.00"]], [[560, "Total"], [800, "1,180.00"]],
    ], 0.9, [0])] }, { myGstin: MY });
    expect(x.draft.items).toEqual([{ description: "As per bill (items not read)", qty: 1, ratePaise: 100000, discountPaise: 0, gstRate: 18 }]);
    expect(x.confidence.item0).toBeLessThan(0.8);
    expect(x.warnings.join(" ")).toContain("could not be read");
    expect(x.draft.party.name).toBe("RAMA HARDWARE");
  });
  test("a two-page bill: table on page 1, totals on page 2", () => {
    const p1 = page(purchaseRows.slice(0, 10), 0.95, [0]);
    const p2 = page(purchaseRows.slice(10), 0.95);
    const x = extractInvoice({ pages: [p1, p2] }, { myGstin: MY });
    expect(x.draft.items.length).toBe(2);
    expect(x.draft.totalPaise).toBe(826000);
    expect(invoiceIssues(x.draft, MY)).toEqual([]);
  });
  test("a faint or handwritten bill gets a clear warning", () => {
    const x = extractInvoice({ pages: [page(purchaseRows, 0.5, [0])] }, { myGstin: MY });
    expect(x.warnings.join(" ")).toContain("hard to read");
  });
});

describe("OCR letter slips in labels", () => {
  test('"lnvoice No" (a small L read for the capital I) still gives the invoice number', () => {
    const rows = purchaseRows.map((r) => r.map(([x, t, c]) => [x, t.replace("Invoice No:", "lnvoice No:"), c] as [number, string, number | undefined]));
    const x = extractInvoice({ pages: [page(rows as ([number, string] | [number, string, number])[][], 0.95, [0])] }, { myGstin: MY });
    expect(x.draft.number).toBe("UF/2026/889");
    expect(x.confidence.number).toBeGreaterThan(0.8);
  });
});
