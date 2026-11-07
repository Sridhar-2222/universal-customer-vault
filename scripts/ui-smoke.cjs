const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
// LOCAL TESTING ONLY. Clicks through the business accounting screens against scripts/local-api.mjs.
// Usage: node scripts/ui-smoke.cjs <web export folder built with EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321> <screenshot folder> [bill folder]
// The optional bill folder holds bill.jpg and truth.json (known answers); it also needs the OCR service on
// EXPO_PUBLIC_OCR_URL (OCR_DEV_NO_AUTH=1, see ocr-service/README.md). Then the photo-reading steps run too.
const DIST = process.argv[2], SHOTS = process.argv[3], BILL = process.argv[4];
const srv = http.createServer((req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".html") ? "text/html" : p.endsWith(".css") ? "text/css" : "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(8099);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
const user = { id: "11111111-1111-1111-1111-111111111111", email: "owner@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} };
const tok = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp })}.test`;
const session = { access_token: tok, token_type: "bearer", expires_in: 86400 * 30, expires_at: exp, refresh_token: "local", user };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript((s) => localStorage.setItem("sb-127-auth-token", JSON.stringify(s)), session);
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
  const step = async (name, fn) => { try { await fn(); console.log("OK  ", name); } catch (e) { console.log("FAIL", name, String(e).split("\n")[0]); await shot("fail-" + name.replace(/\W+/g, "_")); throw e; } };
  try {
    await page.goto("http://127.0.0.1:8099/accounting");
    await step("accounts tab opens", () => page.getByText("Business accounts").waitFor({ timeout: 15000 }));
    await step("create a business", async () => {
      await page.getByRole("button", { name: "+ Add a business" }).click();
      await page.getByLabel("Business name").fill("Sai Electricals");
      await page.getByLabel("GSTIN (optional)").fill("36ABCDE1234F1Z1");
      await page.getByRole("button", { name: "Create business" }).click();
      await page.getByRole("button", { name: "New sale invoice" }).waitFor({ timeout: 15000 }); await page.getByText(/^Sales ₹/).waitFor({ timeout: 10000 });
    });
    await shot("1-business-home");
    await step("new sale invoice with live checks", async () => {
      await page.getByRole("button", { name: "New sale invoice" }).click();
      await page.getByLabel("Customer name").fill("Ravi Traders");
      await page.getByLabel("GSTIN (optional)").fill("36AAACR5055K1Z8");
      await page.getByLabel("Invoice number").fill("INV-101");
      await page.getByLabel("Item 1").fill("LED bulb 9W");
      await page.getByLabel("Qty").fill("10");
      await page.getByLabel("Rate ₹").fill("100");
      await page.getByText("Enter the invoice number.").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
      await page.getByRole("button", { name: "Fill GST from the item rates" }).click();
      await page.getByText("All checks pass.").waitFor({ timeout: 5000 });
    });
    await step("a wrong total is flagged before saving", async () => {
      await page.getByLabel("Grand total ₹").fill("1200");
      await page.getByText(/do not add up/).waitFor({ timeout: 3000 });
      await page.getByLabel("Grand total ₹").fill("1180");
      await page.getByText("All checks pass.").waitFor({ timeout: 3000 });
    });
    await shot("2-invoice-form");
    await step("save as draft, then post", async () => {
      await page.getByRole("button", { name: "Save as draft" }).click();
      await page.getByText(/Saved as a draft/).waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Post to books" }).click();
      await page.getByText("Posted to the books.").waitFor({ timeout: 10000 });
    });
    await step("record part payment", async () => {
      await page.getByLabel("Amount ₹").fill("500");
      await page.getByRole("button", { name: "Record payment" }).click();
      await page.getByText(/Still due ₹680\.00/).waitFor({ timeout: 10000 });
    });
    await shot("3-posted-with-payment");
    await step("ask a question", async () => {
      await page.goBack();
      await page.getByLabel("Your question").last().fill("Who owes me?");
      await page.getByRole("button", { name: "Ask", exact: true }).last().click();
      await page.getByText("Customers owe you ₹680.00 today:").waitFor({ timeout: 10000 });
    });
    await step("sales register lists it", async () => {
      await page.getByRole("button", { name: "Sales register" }).click();
      await page.getByText("INV-101 · Ravi Traders").waitFor({ timeout: 10000 });
      await page.goBack();
    });
    await step("reports: P&L, balance sheet, GST", async () => {
      await page.getByRole("button", { name: /Reports/ }).click();
      await page.getByText("Net profit ₹1,000.00").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Balance sheet" }).click();
      await page.getByText(/Assets = liabilities \+ capital/).waitFor({ timeout: 10000 });
      await shot("4-balance-sheet");
      await page.getByRole("button", { name: "GST", exact: true }).click();
      await page.getByText("GST to pay ₹180.00").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Bank book" }).click();
      await page.getByText(/balance ₹500\.00/).waitFor({ timeout: 10000 });
    });
    if (BILL) await billSteps(page, step, shot);
  } catch {}
  console.log("page errors:", errors.length ? errors.slice(0, 5) : "none");
  await browser.close(); srv.close();
})();

// Read a damaged phone photo of a purchase bill, check every field against the known answers, then approve it.
async function billSteps(page, step, shot) {
  const { truth } = JSON.parse(fs.readFileSync(path.join(BILL, "truth.json"), "utf8"));
  const rs = (p) => (p / 100).toFixed(2).replace(/\.00$/, "");
  const field = (label) => page.getByLabel(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)).last();
  await step("open the bill photo screen", async () => {
    await page.goto("http://127.0.0.1:8099/accounting");
    await page.getByText("Sai Electricals").first().click();
    await page.getByRole("button", { name: "Read a bill photo" }).click();
    await page.getByRole("button", { name: "Choose a photo or PDF" }).waitFor({ timeout: 10000 });
  });
  await step("choose the photo", async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose a photo or PDF" }).click()]);
    await chooser.setFiles(path.join(BILL, "bill.jpg"));
    await page.getByLabel("Chosen bill photo").waitFor({ timeout: 10000 });
  });
  await step("read it with OCR", async () => {
    await page.getByRole("button", { name: "Read this bill" }).click();
    await page.getByText("Read from a photo — please check").waitFor({ timeout: 120000 });
  });
  await step("every field matches the paper", async () => {
    const want = { "Supplier name": truth.party, "GSTIN": truth.gstin, "Invoice number": truth.number, "Date": truth.date,
      "CGST ₹": rs(truth.cgst), "SGST ₹": rs(truth.sgst), "Grand total ₹": rs(truth.total) };
    truth.items.forEach((it, i) => { want[`Item ${i + 1}`] = it.description; });
    const wrong = [];
    for (const [label, v] of Object.entries(want)) { const got = await field(label).inputValue(); if (got !== String(v)) wrong.push(`${label}: got "${got}", want "${v}"`); }
    if (await page.getByLabel(`Item ${truth.items.length + 1}`).count()) wrong.push("an extra item row was read");
    if (wrong.length) throw new Error(wrong.join("; "));
    await page.getByText("All checks pass.").waitFor({ timeout: 3000 });
  });
  await step("the stored photo is shown above the fields", async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Bill photo"] img, img[aria-label="Bill photo"]')].some((i) => i.naturalWidth > 0)
      || [...document.querySelectorAll('[aria-label="Bill photo"]')].some((d) => /url\(/.test(getComputedStyle(d.querySelector("div") ?? d).backgroundImage)), null, { timeout: 15000 });
  });
  await shot("5-bill-review");
  await step("save for review; posting is locked until the paper check is ticked", async () => {
    await page.getByRole("button", { name: "Save for review" }).click();
    await page.getByText(/Saved for review/).waitFor({ timeout: 10000 });
    if (!(await page.getByRole("button", { name: "Post to books" }).isDisabled())) throw new Error("Post was allowed before the paper check");
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Post to books" }).click();
    await page.getByText("Posted to the books.").waitFor({ timeout: 10000 });
  });
  await step("the photo stays with the posted bill", async () => {
    await page.reload();
    await page.getByText(/Purchase bill · posted/).first().waitFor({ timeout: 15000 });
    await page.getByLabel("Bill photo").waitFor({ timeout: 15000 });
  });
}
