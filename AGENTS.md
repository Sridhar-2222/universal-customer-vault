# Rules for anyone (person or AI) working on this repository

- This is **Universal Customer Vault** — a separate product. It is not Rx Fingertip, and it does not share code or
  a database with Rx Fingertip.
- This repository is the single source of truth. It stays **private** unless the owner explicitly approves
  making it public.
- Requirements come from `docs/HANDOVER-FROM-CHATGPT.md`. Do not drop or simplify any of them without the owner's
  approval. Status lives in `docs/ROADMAP.md`. Never mark something done until it has been tested, and say how it
  was tested.
- Security:
  - The app uses only `EXPO_PUBLIC_SUPABASE_URL` and the anon/publishable key. Never put a service-role key or
    any other secret in app code, `.env.example`, or the repository.
  - Every business record carries `business_id`. Access is decided by RLS together with `is_member`, never by an
    ID the browser sends.
  - All writes go through checked `security definer` functions that record activity. Tables are select-only to
    users.
  - Files go in the private bucket `vault`. Open them only with short-lived signed URLs.
- Accounting: money is stored in paise (bigint). Entries are always inserted as drafts. Posting requires debits
  to equal credits (enforced by a database trigger). Posted entries are immutable and can only be reversed. AI or
  OCR output may only create suggestions or drafts that a person posts. Personal and business books never mix.
- Health records are refused in this vault (`health_kept_separately`) until a separate store exists.
- Database changes:
  - Add new numbered migrations; never edit applied ones.
  - Nothing destructive, no data deletion, and no credential changes without the owner's explicit approval.
  - Run `scripts/test-db.sh` against a throwaway local Postgres before applying anything to a live project.
- Tests: `npm test` (pure logic, bun), `npm run typecheck`, `npm run build:web`, `npm run test:db`.
- The owner works from a phone or browser: give one step at a time, in simple words, with no Terminal steps.
