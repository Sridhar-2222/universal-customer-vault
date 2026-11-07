# Roadmap and honest status

Order agreed in the handover. ✅ done and verified · 🟡 partly done · ⬜ not started. "Verified" says how.

| # | Stage | Status | Notes |
|---|---|---|---|
| 1 | Recover and inspect the existing source | 🟡 | The 23 KB ZIP could not be found (not in Drive, Gmail or GitHub; the Drive copy is an empty placeholder). The starter was **regenerated** from the handover on 7 Nov 2026. |
| 2 | Make the project installable and buildable | ✅ | `npm install`, type check and `expo export --platform web` pass; web page opens (setup screen). Android build not yet run (needs EAS, stage 8). |
| 3 | Connect Supabase and configure authentication | ⬜ | Needs a Supabase project (owner decision: new free project). Email one-time-code sign-in is written. |
| 4 | Test vault ownership and sharing permissions | 🟡 | 23 database checks pass on a local test database (ownership, consent before sending, business sees only what it sent, share/revoke, unrelated parties see nothing, activity history). To repeat on the live project. |
| 5 | Complete the accounting engine | 🟡 | Engine and rules done (19 database checks: balance enforced at posting, posted entries locked, reversal, AI drafts only, personal/business separation, GST sale). Still to build: sales/purchase registers, party ledgers, receivables/payables and overdue alerts, cashbook/bankbook views, GST summary, P&L and balance sheet screens, natural-language questions. |
| 6 | Implement strong OCR | ⬜ | **Required, not optional.** Plan: PaddleOCR primary (server), Tesseract fallback, document-intelligence layer for layout/tables/GST fields, confidence scores and human review. Validation helpers already exist (`checkInvoice`, `gstinValid`). |
| 7 | Accounting review and approval workflows | 🟡 | Database side done (suggest → accept as draft → person posts). Review screen for OCR-extracted invoices still to build. |
| 8 | Test Android and web | ⬜ | Web build opens; nothing tested on a phone yet. |
| 9 | Deployment instructions | 🟡 | Browser-only outline in README; to be tested end to end. |
| 10 | Finished source and a simple download route | 🟡 | Source is in this private GitHub repository (Code → Download ZIP works in any browser). |

## Not built yet (do not claim)

Strong OCR; scanned/multi-page PDFs; handwriting; natural-language accounting questions; GST reports; backups and
recovery procedure; reminders/notifications; separate health store; business screens (sending documents, business
books).
