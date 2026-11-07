<!-- ChatGPT's handover, received 7 Nov 2026, kept word for word. Do not edit; record changes in ROADMAP.md. -->

Certainly. The best way is to give Claude a complete technical handover explaining what we designed, what source code was prepared, what remains unfinished, and what capabilities Claude must preserve.

Copy the following message and forward it to Claude.

# UNIVERSAL CUSTOMER VAULT
## Technical Handover from ChatGPT to Claude

Claude, please take over the development and delivery of Universal Customer Vault. The following describes the work already planned and the capabilities that must be preserved. Do not discard existing decisions or simplify the requirements without approval.

### 1. Product identity

**Product name:** Universal Customer Vault

**Platforms:** Android and Web.

**Target users:**
- Individuals and families
- Small businesses
- Retailers
- Distributors
- Medical agencies
- Other commercial organisations

The core features should be free to users. Avoid mandatory monthly subscriptions, per-user charges or per-invoice charges. Hosting, storage, backups, messaging and third-party infrastructure may still incur costs.

### 2. Personal document vault

Each customer owns their own vault.

It should hold:
- Invoices and receipts
- Purchase records
- Warranties and guarantees
- Bookings and orders
- Appointments and reminders
- Personal documents
- Notifications and records received from businesses

A business should be able to send a document to a customer's vault, but must not be able to browse unrelated customer records.

The customer controls sharing permissions and can revoke access. Maintain an activity history.

Keep future health records separate from general personal and business records.

### 3. AI Accounting — one engine, multiple interfaces

Build one accounting engine with role-based interfaces.

**Personal accounting**
- Income and expenditure
- Household expenses
- Bills and subscriptions
- Financial documents
- Daily, monthly and yearly summaries

**Business accounting**
- Sales and purchase registers
- Customer and supplier ledgers
- Receivables and payables
- GST summaries
- Cashbook and bankbook
- Profit and loss
- Balance sheet
- Payment tracking and overdue alerts

Users should be able to ask questions in natural language.

AI suggestions must always be reviewable. Never silently change or post entries to the accounting ledger.

Maintain strict separation between personal and business data.

### 4. Strong OCR — essential feature

This is a major requirement and must not be treated as an optional enhancement.

Use a multi-engine architecture:

1. PaddleOCR as the primary OCR engine.
2. Tesseract as a fallback.
3. A document intelligence layer for layout, tables and financial field extraction.
4. Confidence scoring and human review.

Support:
- Printed invoices
- Receipts and bills
- Scanned PDFs
- Photographs
- Rotated and blurry documents
- Multi-page documents
- Handwritten entries, with appropriate confidence warnings

Financial extraction should identify:
- Invoice number and date
- Supplier and customer
- GSTIN
- Item descriptions
- HSN/SAC
- Quantities and rates
- Discounts
- CGST, SGST and IGST
- Grand total

Validate extracted totals and taxes. Require user approval before posting anything to accounting.

**Important:** Strong OCR was agreed as a requirement, but it has NOT yet been implemented in the available starter source code.

### 5. Technology and architecture already selected

The prepared starter project uses:

- Expo
- React Native
- TypeScript
- Expo Router
- Supabase Authentication
- Supabase PostgreSQL
- Supabase private Storage
- Row Level Security (RLS)

The original source structure includes:
- `supabase/migrations/0001_vault_schema.sql`
- `supabase/migrations/0002_ai_accounting.sql`
- `app/(tabs)/accounting.tsx`
- `app/(tabs)/_layout.tsx`
- Other vault, sharing, settings and authentication screens
- `.env.example`
- README

The accounting migration includes transaction, ledger account, journal entry and journal line structures, with owner-level security policies.

### 6. Security requirements

Implement:
- Secure authentication
- Encrypted data transmission and storage
- Private document storage
- Row-level security
- Explicit sharing permissions
- Revocation of access
- Audit history
- Backup and recovery
- Strict personal/business data separation

Ensure journal entries are balanced before posting. Add database-level validation for debit/credit balance.

Never expose service-role keys or secrets in the client application.

### 7. Existing source ZIP

Previously generated source package:

`universal-customer-vault-accounting-source.zip`

It is approximately 23 KB.

It is a starter source package, not a fully built or deployed application. Dependency installation and build testing were not successfully completed. It is not connected to a live Supabase project.

Please inspect or regenerate it rather than assuming it is production-ready.

### 8. Current GitHub situation

The user has:
- Opened GitHub in Chrome.
- Signed in.
- Created a repository called `universal-customer-vault`.
- Selected PRIVATE visibility.
- Reached the Quick setup page.
- Opened the option to upload an existing file.

The user cannot locate the ZIP in Android Files.

Please help recover or regenerate the source and get it into GitHub using a browser-based process. Do not require Terminal or command-line operations.

Explain that a public repository makes source code publicly visible; retain private visibility unless the user explicitly approves publishing it.

### 9. Required next development stages

Please work in this order:

1. Recover and inspect the existing source.
2. Make the project installable and buildable.
3. Connect Supabase and configure authentication.
4. Test vault ownership and sharing permissions.
5. Complete the accounting engine.
6. Implement strong OCR.
7. Add accounting review and approval workflows.
8. Test Android and web.
9. Provide deployment instructions.
10. Deliver the finished source code and a simple browser-accessible download route.

### 10. Working instructions

The user prefers:
- One step at a time.
- Simple instructions.
- No Terminal.
- No unnecessary code-writing tasks.
- Direct execution by the AI wherever tools permit.
- Honest reporting of completed, pending and untested work.

Do not confuse this project with the user's separate Fingertip healthcare notification project.

**Final objective:** A secure, practical, free-core Universal Customer Vault with strong OCR and AI Accounting, available on Android and Web.

Please preserve all these requirements throughout development.

### One important recommendation

Claude and I can both help develop this project, but the most important thing is to maintain one GitHub repository as the single source of truth. That prevents different versions of the application from becoming mixed up.

Also, the current starter code is not yet a complete working application. Claude should inspect and test it before claiming completion.


Chat GPT input 