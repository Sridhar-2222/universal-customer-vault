# Fingertip ↔ Vault integration foundation

Status: integration design, **not deployed**. This change deliberately does not change production schema, authentication, or storage.

## Verified inventory (13 November 2026)
- Fingertip repository: `Sridhar-2222/rx-at-your-fingertips` (TanStack Start / Vite).
- Vault repository: `Sridhar-2222/universal-customer-vault` (Expo Router for Android/web).
- Accessible Supabase project: `fsftbvchnifshndssowe` (project display name is generic). It contains Fingertip tables such as `businesses`, `business_members`, `bills`, `orders`, `patient_records`, and `patient_record_shares`. Confirm app configuration before assuming this is the production project.
- Vault's README explicitly says live Supabase setup and Android testing are pending. Its `lib/supabase.ts` reads `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`; it does not hardcode a production connection.
- Vault README excludes health records from its general-purpose vault. Preserve that boundary.

## User experience
1. Keep Fingertip's role-specific landing pages and add one clearly named **My Vault** action.
2. Vault keeps its own home screen with **My Fingertip** as an optional connected service.
3. Reuse a single Supabase Auth identity **only after** confirming both apps use the same project and consented account-linking. Never pass session tokens through URL parameters.
4. An invoice captured in Fingertip should appear as a *reference* in Vault search, not a duplicate uploaded file.
5. Customer-visible business documents require an explicit business-customer relationship and document-level permission.
6. Patient medical records remain in Fingertip's protected patient records area; Vault may display a navigation link or a consented reference, but must not copy medical contents into general Vault storage.

## Data model proposal (requires review before SQL)
- `vault_documents`: owner_uid, business_id (nullable), kind, title, captured_at, storage_path, source_system, source_table, source_id, extraction_status. Source references are nullable for standalone uploads.
- `vault_document_grants`: document_id, grantee_uid or verified business membership, granted_by_uid, expires_at, revoked_at.
- `vault_document_events`: append-only upload, view, share, revoke and extraction events.
- `vault_extractions`: extracted fields, source version, confidence, reviewer decision; OCR suggestions never silently post accounting entries.
- `vault_accounting_links`: references to existing `bills` / `orders` with deduplication by source identifier.
Names are provisional: inspect existing Vault SQL migrations before selecting final names to avoid conflicts.

## Security and deployment gates
- Confirm production project IDs and current auth flows for both applications.
- Inspect existing Vault migrations and Fingertip storage policies; do not run Vault migrations blindly against Fingertip.
- RLS on all exposed tables: ownership and membership checks, no access merely because role is `authenticated`.
- Private storage, signed URLs, consent/revocation, and tenant-isolation tests.
- Never expose service-role keys or move session tokens into deep links.
- Separate medical records from generic bills, warranties and accounting.
- Verify sign-in, upload, search, share, revoke, accounting calculations and Android/web navigation.
- Deploy only after tests and production configuration are confirmed.

## First implementation slice
1. Map Vault migration tables to Fingertip's existing schema.
2. Add a safe, opt-in Fingertip link tile in Vault and a Vault tile in Fingertip.
3. Wire cross-app identity/permissions; prove with two separate test accounts that customer A cannot read customer B's documents.
4. Add invoice references and search, then expand to accounting and reminders.
