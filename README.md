# Vault (Fingertip)

A private document vault and accounting part for **Android and Web**, shared by **Fingertrip.biz AI** and
**Rx Fingertip**: individuals and families keep bills, warranties, bookings and records in one place; businesses can
send documents to customers who agree, read bills from photos, and keep GST books. Core features are free to use (no
subscriptions, per-user or per-invoice charges); hosting, storage and messaging providers may still cost money.

> Status (7 Nov 2026): accounting, bill-photo reading (OCR) and review screens built and tested locally (87 database
> checks, 42 logic tests, a 16-step browser run). Its database goes into the Fingertip Supabase project in its own
> schema `customer_vault`; **not applied to the live project yet**. Not tested on an Android phone. See
> [docs/ROADMAP.md](docs/ROADMAP.md) for exactly what is done.

## What is inside

| Part | Where |
|---|---|
| App screens (Expo Router): sign-in, Vault, Accounts, Sharing, Settings | `app/` |
| Supabase client (public keys only), session, UI | `lib/supabase.ts`, `lib/session.ts`, `components/ui.tsx` |
| Accounting helpers: paise money, balance rule, GST invoice checks, GSTIN check digit | `lib/accounting.ts` |
| Smart filing: document kind, date, title, search inside text | `lib/vault-core.ts`, `lib/filing.ts`, `lib/rules.ts` |
| Database: vault, businesses, sending, sharing, activity history | `supabase/migrations/0001_vault_schema.sql` |
| Database: accounting engine (books, accounts, journal, AI suggestions) | `supabase/migrations/0002_ai_accounting.sql` |
| Database tests (42 checks) | `supabase/tests/`, `scripts/test-db.sh` |
| ChatGPT's original handover (kept word for word) | `docs/HANDOVER-FROM-CHATGPT.md` |

## Rules the database enforces (not just the app)

- Each customer owns their vault; only they can browse it.
- A business can **send** a document only to a customer who linked to it with explicit consent, and it sees only
  what it sent or what the customer shared with it.
- The customer shares a document with a business or a person, optionally until a date, and can revoke at any time.
- Every action goes into an activity history the owner can read and nobody can change.
- Health records are refused here; they will get a separate store.
- Accounting: personal and business books never mix; an entry can be posted only if debits equal credits; posted
  entries cannot be edited (only reversed); AI suggestions can only create **drafts** that a person posts.
- The app uses only the public Supabase URL and anon key. The service-role key never goes in the app.

## Set it up (browser only, no Terminal)

1. **Supabase project (free):** supabase.com → New project. In **SQL Editor**, paste and run
   `supabase/migrations/0001_vault_schema.sql`, then `0002_ai_accounting.sql`.
2. **Sign-in by email code:** Authentication → Email Templates → "Magic Link" and "Confirm signup": add
   `Your code: {{ .Token }}`.
3. **Keys:** Project settings → API → copy the Project URL and the anon/publishable key.
4. **Web version:** import this GitHub repository into a free static host (for example Netlify or Vercel) with
   build command `npx expo export --platform web`, output folder `dist`, and the two keys as environment
   variables `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
5. **Android:** expo.dev → connect this repository → EAS Build → Android (APK for testing, AAB for Play Store),
   with the same two environment variables.

Steps 4–5 are being prepared and tested; see the roadmap.

## For developers

```bash
npm install
npm run typecheck
npm test                      # pure logic (bun)
npm run build:web             # web export to dist/
PGURL=postgres://postgres@localhost:5432/postgres npm run test:db   # local throwaway Postgres only
```
