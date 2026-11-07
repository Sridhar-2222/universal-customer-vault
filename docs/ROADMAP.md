# Roadmap and honest status

Order agreed in the handover. ✅ done and verified · 🟡 partly done · ⬜ not started. "Verified" says how.

| # | Stage | Status | Notes |
|---|---|---|---|
| 1 | Recover and inspect the existing source | 🟡 | The 23 KB ZIP could not be found (not in Drive, Gmail or GitHub; the Drive copy is an empty placeholder). The starter was **regenerated** from the handover on 7 Nov 2026. |
| 2 | Make the project installable and buildable | ✅ | `npm install`, type check and `expo export --platform web` pass; web page opens (setup screen). Android build not yet run (needs EAS, stage 8). |
| 3 | Connect Supabase and configure authentication | 🟡 | Owner decision (7 Nov 2026): the vault goes into the existing **Fingertip** Supabase project, in its own schema `customer_vault` and bucket `customer-vault`, shared later by Fingertrip.biz AI and Rx Fingertip. Read-only checks of the live project: no name clashes; all 22 of Fingertip's file rules are limited to their own buckets. Database files reworked and tested locally with Fingertip lookalikes (87 checks). **Not applied to the live project yet** (waiting for the owner's OK). Email one-time-code sign-in is written. |
| 4 | Test vault ownership and sharing permissions | 🟡 | 23 database checks pass on a local test database (ownership, consent before sending, business sees only what it sent, share/revoke, unrelated parties see nothing, activity history). To repeat on the live project. |
| 5 | Complete the accounting engine | ✅ | Sales/purchase invoices with GST checks, approval, payments, sales and purchase registers, party ledgers, receivables/payables with overdue, cash and bank books, GST summary, P&L, balance sheet, plain-language questions. Tested: database checks (`npm run test:db`), logic tests (`npm test`) and a browser run of every screen against a local test server (`scripts/ui-smoke.cjs`). Not yet on a live Supabase project (stage 3). |
| 6 | Implement strong OCR | 🟡 | `ocr-service/`: PaddleOCR PP-OCR models first, Tesseract fallback, PDF text, rotation/tilt/lighting fixes, blur/dark/handwriting warnings; `lib/ocr-extract.ts` reads GST invoice fields with a confidence per field. Tested on 27 synthetic damaged bills: amounts, taxes, totals, GSTIN, dates 100%; 89% fully correct (blurred photos lose spaces between words). **Real photos not tested yet; handwriting is only flagged, not read.** Service not deployed yet. |
| 7 | Accounting review and approval workflows | ✅ | "Read a bill photo": the photo is kept in the business's private folder (`b/<business>/`, members only, cannot be deleted), read by OCR, shown above the fields read for checking, saved for review, and posted only by an owner/admin after ticking "I checked these details against the paper bill". Tested: 12 database checks for the bill folder (84 in all) and a browser run with a damaged phone photo (every field right, posting locked until the box is ticked, photo still shown after posting). Android not tested (stage 8). |
| 8 | Test Android and web | ⬜ | Web build opens; nothing tested on a phone yet. |
| 9 | Deployment instructions | 🟡 | Browser-only outline in README; to be tested end to end. |
| 10 | Finished source and a simple download route | 🟡 | Source is in this private GitHub repository (Code → Download ZIP works in any browser). |

## Not built yet (do not claim)

Reading handwriting (only flagged); OCR on real photos (only synthetic bills tested); backups and recovery procedure; reminders/notifications; separate health store; a business screen for sending documents into customers' vaults (the database side exists).
