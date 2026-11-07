-- Vault: parts 2, 3 and 4 (accounting, business accounting, bill files) for the Fingertip Supabase project.
-- Paste ALL of this into Supabase > SQL Editor and press Run. It runs as one unit: everything or nothing.
-- It only adds to the vault's own schema (customer_vault) and file folder (customer-vault); Fingertip is not touched.
BEGIN;

-- ===== 0002_ai_accounting.sql =====
-- Universal Customer Vault — 0002: one accounting engine for personal and business books.
-- Rules (from the ChatGPT handover, preserved):
--   * Strict separation: a book is EITHER personal (one owner) OR business (its members); nothing mixes the two.
--   * Double entry in paise (integers, no rounding drift). An entry can be POSTED only if it has at least two lines
--     and total debit = total credit > 0. The database checks this; the app cannot skip it.
--   * Posted entries are never edited or deleted; mistakes are corrected with a reversing entry.
--   * AI never posts. AI suggestions are stored as suggestions; accepting one creates a DRAFT entry that a person
--     must review and post.
--   * Clients get SELECT only (via RLS); every write goes through the checked functions below.

CREATE TABLE customer_vault.books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('personal', 'business')),
  owner_user uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES customer_vault.businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal' AND owner_user IS NOT NULL AND business_id IS NULL)
      OR (kind = 'business' AND business_id IS NOT NULL AND owner_user IS NULL))
);
CREATE UNIQUE INDEX books_one_personal ON customer_vault.books (owner_user) WHERE kind = 'personal';
CREATE UNIQUE INDEX books_one_business ON customer_vault.books (business_id) WHERE kind = 'business';

CREATE TABLE customer_vault.ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES customer_vault.books(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  UNIQUE (book_id, code),
  UNIQUE (id, book_id)
);
CREATE TABLE customer_vault.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES customer_vault.books(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  memo text CHECK (memo IS NULL OR char_length(memo) <= 300),
  party text CHECK (party IS NULL OR char_length(party) <= 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'ocr', 'reversal')),
  source_document uuid REFERENCES customer_vault.vault_documents(id) ON DELETE SET NULL,
  reverses uuid REFERENCES customer_vault.journal_entries(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES auth.users(id),
  posted_at timestamptz,
  UNIQUE (id, book_id)
);
CREATE TABLE customer_vault.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL,
  book_id uuid NOT NULL,
  account_id uuid NOT NULL,
  debit_paise bigint NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise bigint NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  CHECK ((debit_paise > 0) <> (credit_paise > 0)),
  -- A line's account and entry must belong to the same book: no line can join personal and business books.
  FOREIGN KEY (entry_id, book_id) REFERENCES customer_vault.journal_entries(id, book_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, book_id) REFERENCES customer_vault.ledger_accounts(id, book_id)
);
CREATE TABLE customer_vault.ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES customer_vault.books(id) ON DELETE CASCADE,
  document_id uuid REFERENCES customer_vault.vault_documents(id) ON DELETE SET NULL,
  entry_date date NOT NULL,
  memo text CHECK (memo IS NULL OR char_length(memo) <= 300),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 2 AND 40),
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  draft_entry uuid REFERENCES customer_vault.journal_entries(id)
);
CREATE INDEX journal_entries_book_idx ON customer_vault.journal_entries (book_id, entry_date DESC);
CREATE INDEX journal_lines_entry_idx ON customer_vault.journal_lines (entry_id);
CREATE INDEX journal_lines_account_idx ON customer_vault.journal_lines (account_id);
CREATE INDEX ai_suggestions_book_idx ON customer_vault.ai_suggestions (book_id, status);

ALTER TABLE customer_vault.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.ai_suggestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_vault.books, customer_vault.ledger_accounts, customer_vault.journal_entries, customer_vault.journal_lines, customer_vault.ai_suggestions FROM anon, authenticated;
GRANT SELECT ON customer_vault.books, customer_vault.ledger_accounts, customer_vault.journal_entries, customer_vault.journal_lines, customer_vault.ai_suggestions TO authenticated;

CREATE OR REPLACE FUNCTION customer_vault.can_use_book(p_book uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT EXISTS (SELECT 1 FROM customer_vault.books b WHERE b.id = p_book AND (
    (b.kind = 'personal' AND b.owner_user = auth.uid()) OR (b.kind = 'business' AND customer_vault.is_member(b.business_id))));
$$;
CREATE POLICY books_read ON customer_vault.books FOR SELECT TO authenticated USING (customer_vault.can_use_book(id));
CREATE POLICY accounts_read ON customer_vault.ledger_accounts FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));
CREATE POLICY entries_read ON customer_vault.journal_entries FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));
CREATE POLICY lines_read ON customer_vault.journal_lines FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));
CREATE POLICY suggestions_read ON customer_vault.ai_suggestions FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));

-- Lines change only while their entry is a draft; posted entries cannot change at all (except by reversal).
CREATE OR REPLACE FUNCTION customer_vault.guard_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM customer_vault.journal_entries WHERE id = coalesce(NEW.entry_id, OLD.entry_id)) = 'posted' THEN
    RAISE EXCEPTION 'entry_posted';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_vault.journal_lines
  FOR EACH ROW EXECUTE FUNCTION customer_vault.guard_journal_lines();
CREATE OR REPLACE FUNCTION customer_vault.guard_journal_entries() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dr bigint; cr bigint; n int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'insert_as_draft'; END IF;  -- no lines yet, so never balanced
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN RAISE EXCEPTION 'entry_posted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'entry_posted'; END IF;
  IF NEW.status = 'posted' THEN
    SELECT coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0), count(*) INTO dr, cr, n
    FROM customer_vault.journal_lines WHERE entry_id = NEW.id;
    IF n < 2 OR dr <> cr OR dr = 0 THEN RAISE EXCEPTION 'not_balanced'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_vault.journal_entries
  FOR EACH ROW EXECUTE FUNCTION customer_vault.guard_journal_entries();

-- Standard accounts for new books (editable later).
CREATE OR REPLACE FUNCTION customer_vault.seed_accounts(p_book uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
BEGIN
  IF p_kind = 'personal' THEN
    INSERT INTO customer_vault.ledger_accounts(book_id, code, name, type) VALUES
      (p_book, 'CASH', 'Cash', 'asset'), (p_book, 'BANK', 'Bank', 'asset'), (p_book, 'CARD', 'Credit card', 'liability'),
      (p_book, 'SALARY', 'Salary', 'income'), (p_book, 'OTHER_INCOME', 'Other income', 'income'),
      (p_book, 'HOUSEHOLD', 'Household', 'expense'), (p_book, 'BILLS', 'Bills & subscriptions', 'expense'),
      (p_book, 'FOOD', 'Food & groceries', 'expense'), (p_book, 'TRAVEL', 'Travel', 'expense'),
      (p_book, 'HEALTH', 'Medical', 'expense'), (p_book, 'EDUCATION', 'Education', 'expense'),
      (p_book, 'OTHER_EXPENSE', 'Other expenses', 'expense'), (p_book, 'OPENING', 'Opening balance', 'equity');
  ELSE
    INSERT INTO customer_vault.ledger_accounts(book_id, code, name, type) VALUES
      (p_book, 'CASH', 'Cash book', 'asset'), (p_book, 'BANK', 'Bank book', 'asset'),
      (p_book, 'RECEIVABLES', 'Sundry debtors (receivables)', 'asset'), (p_book, 'STOCK', 'Stock', 'asset'),
      (p_book, 'INPUT_CGST', 'Input CGST', 'asset'), (p_book, 'INPUT_SGST', 'Input SGST', 'asset'), (p_book, 'INPUT_IGST', 'Input IGST', 'asset'),
      (p_book, 'PAYABLES', 'Sundry creditors (payables)', 'liability'),
      (p_book, 'OUTPUT_CGST', 'Output CGST', 'liability'), (p_book, 'OUTPUT_SGST', 'Output SGST', 'liability'), (p_book, 'OUTPUT_IGST', 'Output IGST', 'liability'),
      (p_book, 'CAPITAL', 'Capital', 'equity'), (p_book, 'SALES', 'Sales', 'income'), (p_book, 'OTHER_INCOME', 'Other income', 'income'),
      (p_book, 'PURCHASES', 'Purchases', 'expense'), (p_book, 'EXPENSES', 'Expenses', 'expense'), (p_book, 'DISCOUNT', 'Discount allowed', 'expense');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.my_personal_book() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  SELECT id INTO b FROM customer_vault.books WHERE kind = 'personal' AND owner_user = auth.uid();
  IF b IS NULL THEN
    INSERT INTO customer_vault.books(kind, owner_user, name) VALUES ('personal', auth.uid(), 'My accounts') RETURNING id INTO b;
    PERFORM customer_vault.seed_accounts(b, 'personal');
  END IF;
  RETURN b;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.business_book(p_business uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  IF NOT customer_vault.is_member(p_business) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT id INTO b FROM customer_vault.books WHERE kind = 'business' AND business_id = p_business;
  IF b IS NULL THEN
    IF coalesce(customer_vault.member_role(p_business), '') NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
    INSERT INTO customer_vault.books(kind, business_id, name) VALUES ('business', p_business, 'Business accounts') RETURNING id INTO b;
    PERFORM customer_vault.seed_accounts(b, 'business');
  END IF;
  RETURN b;
END $$;

-- Create a DRAFT entry with lines given as [{"account":"CODE","debit":paise,"credit":paise,"note":"…"}].
CREATE OR REPLACE FUNCTION customer_vault.create_draft_entry(p_book uuid, p_date date, p_memo text, p_party text, p_lines jsonb,
  p_source text DEFAULT 'manual', p_document uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE e uuid; l jsonb; acc uuid;
BEGIN
  IF NOT customer_vault.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_source NOT IN ('manual', 'ai', 'ocr') THEN RAISE EXCEPTION 'bad_source'; END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 2 AND 40 THEN RAISE EXCEPTION 'bad_lines'; END IF;
  IF p_document IS NOT NULL AND NOT customer_vault.can_see_document(p_document) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  INSERT INTO customer_vault.journal_entries(book_id, entry_date, memo, party, source, source_document, created_by)
  VALUES (p_book, p_date, nullif(btrim(coalesce(p_memo, '')), ''), nullif(btrim(coalesce(p_party, '')), ''), p_source, p_document, auth.uid())
  RETURNING id INTO e;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT id INTO acc FROM customer_vault.ledger_accounts WHERE book_id = p_book AND code = l->>'account';
    IF acc IS NULL THEN RAISE EXCEPTION 'unknown_account'; END IF;
    INSERT INTO customer_vault.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, note)
    VALUES (e, p_book, acc, coalesce((l->>'debit')::bigint, 0), coalesce((l->>'credit')::bigint, 0), nullif(left(coalesce(l->>'note', ''), 200), ''));
  END LOOP;
  RETURN e;
END $$;

-- A person posts a draft. The trigger refuses unbalanced entries.
CREATE OR REPLACE FUNCTION customer_vault.post_entry(p_entry uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM customer_vault.journal_entries WHERE id = p_entry;
  IF b IS NULL OR NOT customer_vault.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE customer_vault.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = p_entry AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'not_draft'; END IF;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.delete_draft(p_entry uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM customer_vault.journal_entries WHERE id = p_entry AND status = 'draft';
  IF b IS NULL OR NOT customer_vault.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE customer_vault.ai_suggestions SET draft_entry = NULL WHERE draft_entry = p_entry;
  DELETE FROM customer_vault.journal_entries WHERE id = p_entry;
END $$;
-- Correct a posted entry: a new posted entry with debits and credits swapped.
CREATE OR REPLACE FUNCTION customer_vault.reverse_entry(p_entry uuid, p_date date DEFAULT current_date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE o customer_vault.journal_entries; e uuid;
BEGIN
  SELECT * INTO o FROM customer_vault.journal_entries WHERE id = p_entry;
  IF o.id IS NULL OR NOT customer_vault.can_use_book(o.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF o.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;
  IF EXISTS (SELECT 1 FROM customer_vault.journal_entries WHERE reverses = p_entry) THEN RAISE EXCEPTION 'already_reversed'; END IF;
  INSERT INTO customer_vault.journal_entries(book_id, entry_date, memo, party, source, reverses, created_by)
  VALUES (o.book_id, p_date, left('Reversal: ' || coalesce(o.memo, ''), 300), o.party, 'reversal', o.id, auth.uid()) RETURNING id INTO e;
  INSERT INTO customer_vault.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, note)
  SELECT e, book_id, account_id, credit_paise, debit_paise, note FROM customer_vault.journal_lines WHERE entry_id = p_entry;
  UPDATE customer_vault.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = e;
  RETURN e;
END $$;

-- AI (or OCR) proposes; it can never post. Accepting creates a DRAFT for a person to review and post.
CREATE OR REPLACE FUNCTION customer_vault.suggest_entry(p_book uuid, p_date date, p_memo text, p_lines jsonb,
  p_confidence numeric DEFAULT NULL, p_document uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE s uuid;
BEGIN
  IF NOT customer_vault.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_document IS NOT NULL AND NOT customer_vault.can_see_document(p_document) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  INSERT INTO customer_vault.ai_suggestions(book_id, document_id, entry_date, memo, lines, confidence, created_by)
  VALUES (p_book, p_document, p_date, p_memo, p_lines, p_confidence, auth.uid()) RETURNING id INTO s;
  RETURN s;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.accept_suggestion(p_suggestion uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE s customer_vault.ai_suggestions; e uuid;
BEGIN
  SELECT * INTO s FROM customer_vault.ai_suggestions WHERE id = p_suggestion;
  IF s.id IS NULL OR NOT customer_vault.can_use_book(s.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'already_decided'; END IF;
  e := customer_vault.create_draft_entry(s.book_id, s.entry_date, s.memo, NULL, s.lines, 'ai', s.document_id);
  UPDATE customer_vault.ai_suggestions SET status = 'accepted', decided_by = auth.uid(), decided_at = now(), draft_entry = e WHERE id = s.id;
  RETURN e;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.reject_suggestion(p_suggestion uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM customer_vault.ai_suggestions WHERE id = p_suggestion AND status = 'pending';
  IF b IS NULL OR NOT customer_vault.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE customer_vault.ai_suggestions SET status = 'rejected', decided_by = auth.uid(), decided_at = now() WHERE id = p_suggestion;
END $$;

-- Totals per account for posted entries in a date range (P&L, balance sheet and summaries are built from this).
CREATE OR REPLACE FUNCTION customer_vault.account_totals(p_book uuid, p_from date, p_to date)
RETURNS TABLE(account_id uuid, code text, name text, type text, debit_paise bigint, credit_paise bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
BEGIN
  IF NOT customer_vault.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  RETURN QUERY SELECT a.id, a.code, a.name, a.type,
    coalesce(sum(l.debit_paise) FILTER (WHERE e.id IS NOT NULL), 0)::bigint, coalesce(sum(l.credit_paise) FILTER (WHERE e.id IS NOT NULL), 0)::bigint
  FROM customer_vault.ledger_accounts a
  LEFT JOIN customer_vault.journal_lines l ON l.account_id = a.id
  LEFT JOIN customer_vault.journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.entry_date BETWEEN p_from AND p_to
  WHERE a.book_id = p_book GROUP BY a.id, a.code, a.name, a.type ORDER BY a.type, a.code;
END $$;

REVOKE ALL ON FUNCTION customer_vault.can_use_book(uuid), customer_vault.seed_accounts(uuid, text), customer_vault.my_personal_book(), customer_vault.business_book(uuid),
  customer_vault.create_draft_entry(uuid, date, text, text, jsonb, text, uuid), customer_vault.post_entry(uuid), customer_vault.delete_draft(uuid),
  customer_vault.reverse_entry(uuid, date), customer_vault.suggest_entry(uuid, date, text, jsonb, numeric, uuid), customer_vault.accept_suggestion(uuid),
  customer_vault.reject_suggestion(uuid), customer_vault.account_totals(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION customer_vault.seed_accounts(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION customer_vault.can_use_book(uuid), customer_vault.my_personal_book(), customer_vault.business_book(uuid),
  customer_vault.create_draft_entry(uuid, date, text, text, jsonb, text, uuid), customer_vault.post_entry(uuid), customer_vault.delete_draft(uuid),
  customer_vault.reverse_entry(uuid, date), customer_vault.suggest_entry(uuid, date, text, jsonb, numeric, uuid), customer_vault.accept_suggestion(uuid),
  customer_vault.reject_suggestion(uuid), customer_vault.account_totals(uuid, date, date) TO authenticated;

-- ===== 0003_business_accounting.sql =====
-- Universal Customer Vault — 0003: business accounting on the same engine (0002).
-- Adds customers/suppliers, sales and purchase registers with GST checks, payments, party ledgers, GST summary,
-- cash/bank book and receivables/payables with overdue amounts.
-- Rules (preserved from the handover):
--   * An invoice is saved as 'draft' (typed) or 'review' (read by OCR). It reaches the ledger only when an owner or
--     admin posts it, and only when it has no open issues (totals, CGST/SGST, IGST vs state, GSTIN check digit,
--     duplicate number). An OCR invoice also needs an explicit confirmation.
--   * Posting writes one balanced journal entry through the 0002 trigger; posted invoices are locked and are
--     cancelled only by a reversing entry (never edited or deleted).
--   * Money in paise. Clients get SELECT only (RLS); every write goes through the checked functions below.

-- Who may approve (post, reverse, cancel): the owner of a personal book; owner/admin of a business book.
CREATE OR REPLACE FUNCTION customer_vault.can_approve_book(p_book uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT EXISTS (SELECT 1 FROM customer_vault.books b WHERE b.id = p_book AND (
    (b.kind = 'personal' AND b.owner_user = auth.uid())
    OR (b.kind = 'business' AND coalesce(customer_vault.member_role(b.business_id), '') IN ('owner', 'admin'))));
$$;

CREATE OR REPLACE FUNCTION customer_vault.gstin_valid(p text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE chars text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; s text := upper(btrim(coalesce(p, ''))); total int := 0; prod int;
BEGIN
  IF s !~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$' THEN RETURN false; END IF;
  FOR i IN 1..14 LOOP
    prod := (strpos(chars, substr(s, i, 1)) - 1) * CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END;
    total := total + prod / 36 + prod % 36;
  END LOOP;
  RETURN substr(chars, ((36 - total % 36) % 36) + 1, 1) = substr(s, 15, 1);
END $$;

CREATE TABLE customer_vault.parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES customer_vault.books(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('customer', 'supplier')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'),
  phone text CHECK (phone IS NULL OR phone ~ '^[0-9+ -]{6,20}$'),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, book_id)
);
CREATE UNIQUE INDEX parties_gstin_once ON customer_vault.parties (book_id, kind, gstin) WHERE gstin IS NOT NULL;

-- Party on ledger lines (receivables/payables), so customer and supplier ledgers come from the journal itself.
ALTER TABLE customer_vault.journal_lines ADD COLUMN party_id uuid;
ALTER TABLE customer_vault.journal_lines ADD CONSTRAINT journal_lines_party_fk FOREIGN KEY (party_id, book_id) REFERENCES customer_vault.parties(id, book_id);
CREATE INDEX journal_lines_party_idx ON customer_vault.journal_lines (party_id) WHERE party_id IS NOT NULL;

CREATE TABLE customer_vault.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale', 'purchase')),
  number text NOT NULL CHECK (char_length(btrim(number)) BETWEEN 1 AND 40),
  invoice_date date NOT NULL,
  due_date date,
  party_id uuid NOT NULL,
  taxable_paise bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  round_off_paise bigint NOT NULL DEFAULT 0,
  total_paise bigint NOT NULL CHECK (total_paise > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('review', 'draft', 'posted', 'cancelled')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr')),
  document_id uuid REFERENCES customer_vault.vault_documents(id) ON DELETE SET NULL,
  ocr jsonb CHECK (ocr IS NULL OR (jsonb_typeof(ocr) = 'object' AND octet_length(ocr::text) <= 20000)),
  issues text[] NOT NULL DEFAULT '{}',
  entry_id uuid REFERENCES customer_vault.journal_entries(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES auth.users(id),
  posted_at timestamptz,
  CHECK (due_date IS NULL OR due_date >= invoice_date),
  FOREIGN KEY (party_id, book_id) REFERENCES customer_vault.parties(id, book_id),
  FOREIGN KEY (book_id) REFERENCES customer_vault.books(id) ON DELETE CASCADE,
  UNIQUE (id, book_id)
);
-- One posted sale per number per book; one posted purchase per supplier bill number.
CREATE UNIQUE INDEX invoices_sale_number ON customer_vault.invoices (book_id, upper(number)) WHERE kind = 'sale' AND status = 'posted';
CREATE UNIQUE INDEX invoices_purchase_number ON customer_vault.invoices (book_id, party_id, upper(number)) WHERE kind = 'purchase' AND status = 'posted';
CREATE INDEX invoices_book_idx ON customer_vault.invoices (book_id, kind, invoice_date DESC);

CREATE TABLE customer_vault.invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  book_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 200),
  hsn text CHECK (hsn IS NULL OR hsn ~ '^[0-9]{4,8}$'),
  qty numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 12),
  rate_paise bigint NOT NULL CHECK (rate_paise >= 0),
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise bigint NOT NULL CHECK (taxable_paise >= 0),
  gst_rate numeric(5, 2) CHECK (gst_rate IS NULL OR gst_rate IN (0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40)),
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (invoice_id, book_id) REFERENCES customer_vault.invoices(id, book_id) ON DELETE CASCADE
);
CREATE TABLE customer_vault.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  paid_on date NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  mode text NOT NULL CHECK (mode IN ('cash', 'bank')),
  reference text CHECK (reference IS NULL OR char_length(reference) <= 60),
  entry_id uuid NOT NULL REFERENCES customer_vault.journal_entries(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, book_id) REFERENCES customer_vault.invoices(id, book_id)
);
CREATE INDEX payments_invoice_idx ON customer_vault.payments (invoice_id);

ALTER TABLE customer_vault.parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_vault.parties, customer_vault.invoices, customer_vault.invoice_items, customer_vault.payments FROM anon, authenticated;
GRANT SELECT ON customer_vault.parties, customer_vault.invoices, customer_vault.invoice_items, customer_vault.payments TO authenticated;
CREATE POLICY parties_read ON customer_vault.parties FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));
CREATE POLICY invoices_read ON customer_vault.invoices FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));
CREATE POLICY invoice_items_read ON customer_vault.invoice_items FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));
CREATE POLICY payments_read ON customer_vault.payments FOR SELECT TO authenticated USING (customer_vault.can_use_book(book_id));

-- Posted and cancelled invoices are locked (only posted -> cancelled is allowed), and so are their items.
CREATE OR REPLACE FUNCTION customer_vault.guard_invoices() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'review') THEN RAISE EXCEPTION 'insert_as_draft'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'cancelled') THEN RAISE EXCEPTION 'invoice_posted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'invoice_posted'; END IF;
  IF OLD.status = 'posted' AND (NEW.status <> 'cancelled' OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status')) THEN
    RAISE EXCEPTION 'invoice_posted';
  END IF;
  IF NEW.status = 'posted' AND (NEW.entry_id IS NULL OR cardinality(NEW.issues) > 0) THEN RAISE EXCEPTION 'has_issues'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_vault.invoices FOR EACH ROW EXECUTE FUNCTION customer_vault.guard_invoices();
CREATE OR REPLACE FUNCTION customer_vault.guard_invoice_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM customer_vault.invoices WHERE id = coalesce(NEW.invoice_id, OLD.invoice_id)) IN ('posted', 'cancelled') THEN
    RAISE EXCEPTION 'invoice_posted';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_vault.invoice_items FOR EACH ROW EXECUTE FUNCTION customer_vault.guard_invoice_items();

-- New business accounts: round-off; and seed it for books created before this migration.
CREATE OR REPLACE FUNCTION customer_vault.seed_accounts(p_book uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
BEGIN
  IF p_kind = 'personal' THEN
    INSERT INTO customer_vault.ledger_accounts(book_id, code, name, type) VALUES
      (p_book, 'CASH', 'Cash', 'asset'), (p_book, 'BANK', 'Bank', 'asset'), (p_book, 'CARD', 'Credit card', 'liability'),
      (p_book, 'SALARY', 'Salary', 'income'), (p_book, 'OTHER_INCOME', 'Other income', 'income'),
      (p_book, 'HOUSEHOLD', 'Household', 'expense'), (p_book, 'BILLS', 'Bills & subscriptions', 'expense'),
      (p_book, 'FOOD', 'Food & groceries', 'expense'), (p_book, 'TRAVEL', 'Travel', 'expense'),
      (p_book, 'HEALTH', 'Medical', 'expense'), (p_book, 'EDUCATION', 'Education', 'expense'),
      (p_book, 'OTHER_EXPENSE', 'Other expenses', 'expense'), (p_book, 'OPENING', 'Opening balance', 'equity');
  ELSE
    INSERT INTO customer_vault.ledger_accounts(book_id, code, name, type) VALUES
      (p_book, 'CASH', 'Cash book', 'asset'), (p_book, 'BANK', 'Bank book', 'asset'),
      (p_book, 'RECEIVABLES', 'Sundry debtors (receivables)', 'asset'), (p_book, 'STOCK', 'Stock', 'asset'),
      (p_book, 'INPUT_CGST', 'Input CGST', 'asset'), (p_book, 'INPUT_SGST', 'Input SGST', 'asset'), (p_book, 'INPUT_IGST', 'Input IGST', 'asset'),
      (p_book, 'PAYABLES', 'Sundry creditors (payables)', 'liability'),
      (p_book, 'OUTPUT_CGST', 'Output CGST', 'liability'), (p_book, 'OUTPUT_SGST', 'Output SGST', 'liability'), (p_book, 'OUTPUT_IGST', 'Output IGST', 'liability'),
      (p_book, 'CAPITAL', 'Capital', 'equity'), (p_book, 'SALES', 'Sales', 'income'), (p_book, 'OTHER_INCOME', 'Other income', 'income'),
      (p_book, 'PURCHASES', 'Purchases', 'expense'), (p_book, 'EXPENSES', 'Expenses', 'expense'), (p_book, 'DISCOUNT', 'Discount allowed', 'expense'),
      (p_book, 'ROUND_OFF', 'Round off', 'expense');
  END IF;
END $$;
INSERT INTO customer_vault.ledger_accounts(book_id, code, name, type)
SELECT id, 'ROUND_OFF', 'Round off', 'expense' FROM customer_vault.books WHERE kind = 'business' ON CONFLICT (book_id, code) DO NOTHING;

-- Reversals keep the party on each line (replaces the 0002 version; same behaviour otherwise, approvers only).
CREATE OR REPLACE FUNCTION customer_vault.reverse_entry(p_entry uuid, p_date date DEFAULT current_date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE o customer_vault.journal_entries; e uuid;
BEGIN
  SELECT * INTO o FROM customer_vault.journal_entries WHERE id = p_entry;
  IF o.id IS NULL OR NOT customer_vault.can_approve_book(o.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF o.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;
  IF EXISTS (SELECT 1 FROM customer_vault.journal_entries WHERE reverses = p_entry) THEN RAISE EXCEPTION 'already_reversed'; END IF;
  INSERT INTO customer_vault.journal_entries(book_id, entry_date, memo, party, source, reverses, created_by)
  VALUES (o.book_id, p_date, left('Reversal: ' || coalesce(o.memo, ''), 300), o.party, 'reversal', o.id, auth.uid()) RETURNING id INTO e;
  INSERT INTO customer_vault.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, note, party_id)
  SELECT e, book_id, account_id, credit_paise, debit_paise, note, party_id FROM customer_vault.journal_lines WHERE entry_id = p_entry;
  UPDATE customer_vault.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = e;
  RETURN e;
END $$;
-- Posting a journal entry is an approval too (business books: owner/admin; staff prepare drafts).
CREATE OR REPLACE FUNCTION customer_vault.post_entry(p_entry uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM customer_vault.journal_entries WHERE id = p_entry;
  IF b IS NULL OR NOT customer_vault.can_approve_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE customer_vault.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = p_entry AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'not_draft'; END IF;
END $$;

-- Customer or supplier: reuse by GSTIN, then by name; create otherwise.
CREATE OR REPLACE FUNCTION customer_vault.save_party(p_book uuid, p_kind text, p_name text, p_gstin text DEFAULT NULL,
  p_phone text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE pid uuid; g text := nullif(upper(btrim(coalesce(p_gstin, ''))), ''); n text := btrim(coalesce(p_name, ''));
BEGIN
  IF NOT customer_vault.can_use_book(p_book) OR (SELECT kind FROM customer_vault.books WHERE id = p_book) <> 'business' THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_kind NOT IN ('customer', 'supplier') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF n = '' THEN RAISE EXCEPTION 'no_party'; END IF;
  IF g IS NOT NULL AND NOT customer_vault.gstin_valid(g) THEN RAISE EXCEPTION 'bad_gstin'; END IF;
  IF g IS NOT NULL THEN SELECT id INTO pid FROM customer_vault.parties WHERE book_id = p_book AND kind = p_kind AND gstin = g; END IF;
  IF pid IS NULL THEN
    SELECT id INTO pid FROM customer_vault.parties WHERE book_id = p_book AND kind = p_kind AND lower(name) = lower(n)
      AND (gstin IS NULL OR g IS NULL) ORDER BY created_at LIMIT 1;
  END IF;
  IF pid IS NULL THEN
    INSERT INTO customer_vault.parties(book_id, kind, name, gstin, phone, state_code)
    VALUES (p_book, p_kind, n, g, nullif(btrim(coalesce(p_phone, '')), ''), left(g, 2)) RETURNING id INTO pid;
  ELSIF g IS NOT NULL THEN
    UPDATE customer_vault.parties SET gstin = g, state_code = left(g, 2) WHERE id = pid AND gstin IS NULL;
  END IF;
  RETURN pid;
END $$;

-- Every check that must pass before posting. Same rules as lib/invoice.ts (instant feedback in the app).
CREATE OR REPLACE FUNCTION customer_vault.invoice_issues(p_invoice uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE i customer_vault.invoices; p customer_vault.parties; out text[] := '{}'; n int; items bigint; expected bigint; all_rated boolean; my_state text;
BEGIN
  SELECT * INTO i FROM customer_vault.invoices WHERE id = p_invoice;
  SELECT * INTO p FROM customer_vault.parties WHERE id = i.party_id;
  SELECT count(*), coalesce(sum(taxable_paise), 0), bool_and(gst_rate IS NOT NULL),
         coalesce(sum(round(taxable_paise * coalesce(gst_rate, 0) / 100)), 0)::bigint
    INTO n, items, all_rated, expected FROM customer_vault.invoice_items WHERE invoice_id = p_invoice;
  IF n = 0 THEN out := array_append(out, 'no_items'); END IF;
  IF n > 0 AND items <> i.taxable_paise THEN out := array_append(out, 'items_total_mismatch'); END IF;
  IF abs(i.round_off_paise) > 100 THEN out := array_append(out, 'items_total_mismatch'); END IF;
  IF i.cgst_paise <> i.sgst_paise THEN out := array_append(out, 'cgst_sgst_differ'); END IF;
  IF i.igst_paise > 0 AND (i.cgst_paise > 0 OR i.sgst_paise > 0) THEN out := array_append(out, 'igst_with_cgst'); END IF;
  IF n > 0 AND all_rated AND abs(expected - (i.cgst_paise + i.sgst_paise + i.igst_paise)) > 100 THEN out := array_append(out, 'tax_rate_mismatch'); END IF;
  SELECT left(b.gstin, 2) INTO my_state FROM customer_vault.books k JOIN customer_vault.businesses b ON b.id = k.business_id WHERE k.id = i.book_id;
  IF my_state IS NOT NULL AND p.state_code IS NOT NULL THEN
    IF my_state = p.state_code AND i.igst_paise > 0 THEN out := array_append(out, 'wrong_tax_type'); END IF;
    IF my_state <> p.state_code AND (i.cgst_paise > 0 OR i.sgst_paise > 0) THEN out := array_append(out, 'wrong_tax_type'); END IF;
  END IF;
  IF p.gstin IS NOT NULL AND NOT customer_vault.gstin_valid(p.gstin) THEN out := array_append(out, 'bad_gstin'); END IF;
  IF EXISTS (SELECT 1 FROM customer_vault.invoices x WHERE x.book_id = i.book_id AND x.kind = i.kind AND x.status = 'posted' AND x.id <> i.id
             AND upper(x.number) = upper(i.number) AND (i.kind = 'sale' OR x.party_id = i.party_id)) THEN
    out := array_append(out, 'duplicate_number');
  END IF;
  RETURN (SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}') FROM unnest(out) u);
END $$;

-- Save (create or replace) a draft/review invoice. Shape:
-- {"kind":"sale|purchase","number":"","date":"YYYY-MM-DD","due_date":null,"party":{"name":"","gstin":null,"phone":null},
--  "items":[{"description":"","hsn":null,"qty":1,"unit":null,"rate":paise,"discount":paise,"gst_rate":18}],
--  "cgst":paise,"sgst":paise,"igst":paise,"total":paise,"ocr":{...}}  — source 'ocr' saves as status 'review'.
-- Returns the invoice id; the open issues are stored on it (posting is refused until there are none).
CREATE OR REPLACE FUNCTION customer_vault.save_invoice(p_book uuid, p_invoice jsonb, p_source text DEFAULT 'manual',
  p_document uuid DEFAULT NULL, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE inv uuid := p_id; party uuid; it jsonb; k int := 0; taxable bigint := 0; line_taxable bigint; qty numeric; rate bigint; disc bigint;
  c bigint := coalesce((p_invoice->>'cgst')::bigint, 0); s bigint := coalesce((p_invoice->>'sgst')::bigint, 0);
  ig bigint := coalesce((p_invoice->>'igst')::bigint, 0); tot bigint := (p_invoice->>'total')::bigint;
  v_kind text := p_invoice->>'kind';
BEGIN
  IF NOT customer_vault.can_use_book(p_book) OR (SELECT b.kind FROM customer_vault.books b WHERE b.id = p_book) <> 'business' THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('sale', 'purchase') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF p_source NOT IN ('manual', 'ocr') THEN RAISE EXCEPTION 'bad_source'; END IF;
  IF tot IS NULL OR tot <= 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF jsonb_typeof(p_invoice->'items') <> 'array' OR jsonb_array_length(p_invoice->'items') > 200 THEN RAISE EXCEPTION 'bad_items'; END IF;
  IF p_document IS NOT NULL AND NOT customer_vault.can_see_document(p_document) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  party := customer_vault.save_party(p_book, CASE v_kind WHEN 'sale' THEN 'customer' ELSE 'supplier' END,
    p_invoice#>>'{party,name}', p_invoice#>>'{party,gstin}', p_invoice#>>'{party,phone}');
  FOR it IN SELECT * FROM jsonb_array_elements(p_invoice->'items') LOOP
    qty := (it->>'qty')::numeric; rate := (it->>'rate')::bigint; disc := coalesce((it->>'discount')::bigint, 0);
    IF qty IS NULL OR qty <= 0 OR rate IS NULL OR rate < 0 OR disc < 0 THEN RAISE EXCEPTION 'bad_items'; END IF;
    line_taxable := round(qty * rate)::bigint - disc;
    IF line_taxable < 0 THEN RAISE EXCEPTION 'bad_items'; END IF;
    taxable := taxable + line_taxable;
  END LOOP;
  IF inv IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM customer_vault.invoices WHERE id = inv AND book_id = p_book AND status IN ('draft', 'review')) THEN RAISE EXCEPTION 'not_draft'; END IF;
    DELETE FROM customer_vault.invoice_items WHERE invoice_id = inv;
    UPDATE customer_vault.invoices SET kind = v_kind, number = btrim(p_invoice->>'number'), invoice_date = (p_invoice->>'date')::date,
      due_date = nullif(p_invoice->>'due_date', '')::date, party_id = party, taxable_paise = taxable, cgst_paise = c, sgst_paise = s,
      igst_paise = ig, round_off_paise = tot - taxable - c - s - ig, total_paise = tot,
      ocr = coalesce(p_invoice->'ocr', ocr), document_id = coalesce(p_document, document_id) WHERE id = inv;
  ELSE
    INSERT INTO customer_vault.invoices(book_id, kind, number, invoice_date, due_date, party_id, taxable_paise, cgst_paise, sgst_paise, igst_paise,
      round_off_paise, total_paise, status, source, document_id, ocr, created_by)
    VALUES (p_book, v_kind, btrim(p_invoice->>'number'), (p_invoice->>'date')::date, nullif(p_invoice->>'due_date', '')::date, party, taxable,
      c, s, ig, tot - taxable - c - s - ig, tot, CASE p_source WHEN 'ocr' THEN 'review' ELSE 'draft' END, p_source, p_document,
      p_invoice->'ocr', auth.uid())
    RETURNING id INTO inv;
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_invoice->'items') LOOP
    k := k + 1;
    INSERT INTO customer_vault.invoice_items(invoice_id, book_id, line_no, description, hsn, qty, unit, rate_paise, discount_paise, taxable_paise, gst_rate)
    VALUES (inv, p_book, k, btrim(it->>'description'), nullif(btrim(coalesce(it->>'hsn', '')), ''), (it->>'qty')::numeric,
      nullif(btrim(coalesce(it->>'unit', '')), ''), (it->>'rate')::bigint, coalesce((it->>'discount')::bigint, 0),
      round((it->>'qty')::numeric * (it->>'rate')::bigint)::bigint - coalesce((it->>'discount')::bigint, 0),
      nullif(it->>'gst_rate', '')::numeric);
  END LOOP;
  UPDATE customer_vault.invoices SET issues = customer_vault.invoice_issues(inv) WHERE id = inv;
  RETURN inv;
END $$;

-- Approve: an owner/admin posts the invoice as one balanced journal entry. OCR invoices need p_confirm = true.
CREATE OR REPLACE FUNCTION customer_vault.post_invoice(p_invoice uuid, p_confirm boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE i customer_vault.invoices; iss text[]; e uuid; pname text;
BEGIN
  SELECT * INTO i FROM customer_vault.invoices WHERE id = p_invoice FOR UPDATE;
  IF i.id IS NULL OR NOT customer_vault.can_approve_book(i.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF i.status NOT IN ('draft', 'review') THEN RAISE EXCEPTION 'not_draft'; END IF;
  iss := customer_vault.invoice_issues(p_invoice);
  UPDATE customer_vault.invoices SET issues = iss WHERE id = p_invoice;
  IF cardinality(iss) > 0 THEN RAISE EXCEPTION 'has_issues: %', array_to_string(iss, ','); END IF;
  IF i.source = 'ocr' AND NOT coalesce(p_confirm, false) THEN RAISE EXCEPTION 'confirm_required'; END IF;
  SELECT name INTO pname FROM customer_vault.parties WHERE id = i.party_id;
  INSERT INTO customer_vault.journal_entries(book_id, entry_date, memo, party, source, source_document, created_by)
  VALUES (i.book_id, i.invoice_date, left(CASE i.kind WHEN 'sale' THEN 'Sale invoice ' ELSE 'Purchase bill ' END || i.number, 300), pname,
    CASE i.source WHEN 'ocr' THEN 'ocr' ELSE 'manual' END, i.document_id, auth.uid()) RETURNING id INTO e;
  INSERT INTO customer_vault.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, party_id)
  SELECT e, i.book_id, a.id, x.dr, x.cr, x.party FROM (VALUES
      -- sale: Dr receivable (party) / Cr sales, output GST; purchase: Dr purchases, input GST / Cr payable (party)
      (CASE i.kind WHEN 'sale' THEN 'RECEIVABLES' ELSE 'PAYABLES' END, CASE i.kind WHEN 'sale' THEN i.total_paise ELSE 0 END,
        CASE i.kind WHEN 'sale' THEN 0 ELSE i.total_paise END, i.party_id),
      (CASE i.kind WHEN 'sale' THEN 'SALES' ELSE 'PURCHASES' END, CASE i.kind WHEN 'sale' THEN 0 ELSE i.taxable_paise END,
        CASE i.kind WHEN 'sale' THEN i.taxable_paise ELSE 0 END, NULL::uuid),
      (CASE i.kind WHEN 'sale' THEN 'OUTPUT_CGST' ELSE 'INPUT_CGST' END, CASE i.kind WHEN 'sale' THEN 0 ELSE i.cgst_paise END,
        CASE i.kind WHEN 'sale' THEN i.cgst_paise ELSE 0 END, NULL),
      (CASE i.kind WHEN 'sale' THEN 'OUTPUT_SGST' ELSE 'INPUT_SGST' END, CASE i.kind WHEN 'sale' THEN 0 ELSE i.sgst_paise END,
        CASE i.kind WHEN 'sale' THEN i.sgst_paise ELSE 0 END, NULL),
      (CASE i.kind WHEN 'sale' THEN 'OUTPUT_IGST' ELSE 'INPUT_IGST' END, CASE i.kind WHEN 'sale' THEN 0 ELSE i.igst_paise END,
        CASE i.kind WHEN 'sale' THEN i.igst_paise ELSE 0 END, NULL),
      -- round off: whatever makes the stated total; on a sale a positive round-off is a credit, on a purchase a debit
      ('ROUND_OFF',
        CASE WHEN (i.kind = 'sale' AND i.round_off_paise < 0) OR (i.kind = 'purchase' AND i.round_off_paise > 0) THEN abs(i.round_off_paise) ELSE 0 END,
        CASE WHEN (i.kind = 'sale' AND i.round_off_paise > 0) OR (i.kind = 'purchase' AND i.round_off_paise < 0) THEN abs(i.round_off_paise) ELSE 0 END, NULL)
    ) AS x(code, dr, cr, party)
  JOIN customer_vault.ledger_accounts a ON a.book_id = i.book_id AND a.code = x.code
  WHERE x.dr > 0 OR x.cr > 0;
  UPDATE customer_vault.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = e;  -- balance checked here
  UPDATE customer_vault.invoices SET status = 'posted', entry_id = e, posted_by = auth.uid(), posted_at = now() WHERE id = p_invoice;
  RETURN e;
END $$;

-- Draft/review: removed. Posted without payments: cancelled by a reversing entry (the record stays).
CREATE OR REPLACE FUNCTION customer_vault.cancel_invoice(p_invoice uuid, p_date date DEFAULT current_date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE i customer_vault.invoices;
BEGIN
  SELECT * INTO i FROM customer_vault.invoices WHERE id = p_invoice FOR UPDATE;
  IF i.id IS NULL THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF i.status IN ('draft', 'review') THEN
    IF NOT customer_vault.can_use_book(i.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
    DELETE FROM customer_vault.invoices WHERE id = p_invoice;
    RETURN 'deleted';
  END IF;
  IF NOT customer_vault.can_approve_book(i.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF i.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;
  IF EXISTS (SELECT 1 FROM customer_vault.payments WHERE invoice_id = p_invoice) THEN RAISE EXCEPTION 'has_payments'; END IF;
  PERFORM customer_vault.reverse_entry(i.entry_id, p_date);
  UPDATE customer_vault.invoices SET status = 'cancelled' WHERE id = p_invoice;
  RETURN 'cancelled';
END $$;

CREATE OR REPLACE FUNCTION customer_vault.invoice_paid(p_invoice uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT coalesce(sum(amount_paise), 0)::bigint FROM customer_vault.payments WHERE invoice_id = p_invoice;
$$;
-- Money received for a sale / paid for a purchase, against a posted invoice; never more than what is due.
CREATE OR REPLACE FUNCTION customer_vault.record_payment(p_invoice uuid, p_date date, p_amount bigint, p_mode text, p_reference text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE i customer_vault.invoices; e uuid; pay uuid; money uuid; ledger uuid; pname text;
BEGIN
  SELECT * INTO i FROM customer_vault.invoices WHERE id = p_invoice FOR UPDATE;
  IF i.id IS NULL OR NOT customer_vault.can_use_book(i.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF i.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;
  IF p_mode NOT IN ('cash', 'bank') THEN RAISE EXCEPTION 'bad_mode'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF p_amount > i.total_paise - customer_vault.invoice_paid(p_invoice) THEN RAISE EXCEPTION 'more_than_due'; END IF;
  IF p_date < i.invoice_date THEN RAISE EXCEPTION 'before_invoice'; END IF;
  SELECT id INTO money FROM customer_vault.ledger_accounts WHERE book_id = i.book_id AND code = upper(p_mode);
  SELECT id INTO ledger FROM customer_vault.ledger_accounts WHERE book_id = i.book_id AND code = CASE i.kind WHEN 'sale' THEN 'RECEIVABLES' ELSE 'PAYABLES' END;
  SELECT name INTO pname FROM customer_vault.parties WHERE id = i.party_id;
  INSERT INTO customer_vault.journal_entries(book_id, entry_date, memo, party, created_by)
  VALUES (i.book_id, p_date, left(CASE i.kind WHEN 'sale' THEN 'Received for ' ELSE 'Paid for ' END || i.number, 300), pname, auth.uid()) RETURNING id INTO e;
  INSERT INTO customer_vault.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, party_id) VALUES
    (e, i.book_id, CASE i.kind WHEN 'sale' THEN money ELSE ledger END, p_amount, 0, CASE i.kind WHEN 'sale' THEN NULL ELSE i.party_id END),
    (e, i.book_id, CASE i.kind WHEN 'sale' THEN ledger ELSE money END, 0, p_amount, CASE i.kind WHEN 'sale' THEN i.party_id ELSE NULL END);
  UPDATE customer_vault.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = e;
  INSERT INTO customer_vault.payments(book_id, invoice_id, paid_on, amount_paise, mode, reference, entry_id, created_by)
  VALUES (i.book_id, p_invoice, p_date, p_amount, p_mode, nullif(btrim(coalesce(p_reference, '')), ''), e, auth.uid()) RETURNING id INTO pay;
  RETURN pay;
END $$;

-- Receivables (customers) and payables (suppliers) per party, with the overdue part as of a date.
CREATE OR REPLACE FUNCTION customer_vault.party_balances(p_book uuid, p_as_of date DEFAULT current_date)
RETURNS TABLE(party_id uuid, name text, kind text, invoiced_paise bigint, paid_paise bigint, outstanding_paise bigint,
  overdue_paise bigint, oldest_due date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
BEGIN
  IF NOT customer_vault.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  RETURN QUERY
  WITH inv AS (
    SELECT i.party_id, i.total_paise, i.due_date,
      (SELECT coalesce(sum(p.amount_paise), 0) FROM customer_vault.payments p WHERE p.invoice_id = i.id AND p.paid_on <= p_as_of) AS paid
    FROM customer_vault.invoices i WHERE i.book_id = p_book AND i.status = 'posted' AND i.invoice_date <= p_as_of)
  SELECT pa.id, pa.name, pa.kind, sum(inv.total_paise)::bigint, sum(inv.paid)::bigint, sum(inv.total_paise - inv.paid)::bigint,
    coalesce(sum(inv.total_paise - inv.paid) FILTER (WHERE inv.due_date < p_as_of), 0)::bigint,
    min(inv.due_date) FILTER (WHERE inv.total_paise > inv.paid)
  FROM inv JOIN customer_vault.parties pa ON pa.id = inv.party_id
  GROUP BY pa.id, pa.name, pa.kind HAVING sum(inv.total_paise - inv.paid) <> 0
  ORDER BY 7 DESC, 6 DESC;
END $$;

-- GST summary for a period from posted invoices: output tax on sales, input tax credit on purchases.
CREATE OR REPLACE FUNCTION customer_vault.gst_summary(p_book uuid, p_from date, p_to date)
RETURNS TABLE(kind text, invoices bigint, taxable_paise bigint, cgst_paise bigint, sgst_paise bigint, igst_paise bigint, total_paise bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
BEGIN
  IF NOT customer_vault.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  RETURN QUERY SELECT k.kind, count(i.id), coalesce(sum(i.taxable_paise), 0)::bigint, coalesce(sum(i.cgst_paise), 0)::bigint,
    coalesce(sum(i.sgst_paise), 0)::bigint, coalesce(sum(i.igst_paise), 0)::bigint, coalesce(sum(i.total_paise), 0)::bigint
  FROM (VALUES ('sale'), ('purchase')) k(kind)
  LEFT JOIN customer_vault.invoices i ON i.kind = k.kind AND i.book_id = p_book AND i.status = 'posted' AND i.invoice_date BETWEEN p_from AND p_to
  GROUP BY k.kind ORDER BY k.kind DESC;
END $$;

-- One account's ledger (cash book, bank book, any account) with opening balance and running balance.
CREATE OR REPLACE FUNCTION customer_vault.account_ledger(p_book uuid, p_code text, p_from date, p_to date)
RETURNS TABLE(entry_date date, entry_id uuid, memo text, party text, debit_paise bigint, credit_paise bigint, balance_paise bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE acc uuid; opening bigint;
BEGIN
  IF NOT customer_vault.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT id INTO acc FROM customer_vault.ledger_accounts WHERE book_id = p_book AND code = p_code;
  IF acc IS NULL THEN RAISE EXCEPTION 'unknown_account'; END IF;
  SELECT coalesce(sum(l.debit_paise - l.credit_paise), 0) INTO opening FROM customer_vault.journal_lines l
    JOIN customer_vault.journal_entries e ON e.id = l.entry_id WHERE l.account_id = acc AND e.status = 'posted' AND e.entry_date < p_from;
  RETURN QUERY SELECT p_from, NULL::uuid, 'Opening balance'::text, NULL::text, 0::bigint, 0::bigint, opening;
  RETURN QUERY
    SELECT e.entry_date, e.id, e.memo, e.party, l.debit_paise, l.credit_paise,
      (opening + sum(l.debit_paise - l.credit_paise) OVER (ORDER BY e.entry_date, e.posted_at, l.id))::bigint
    FROM customer_vault.journal_lines l JOIN customer_vault.journal_entries e ON e.id = l.entry_id
    WHERE l.account_id = acc AND e.status = 'posted' AND e.entry_date BETWEEN p_from AND p_to
    ORDER BY e.entry_date, e.posted_at, l.id;
END $$;

REVOKE ALL ON FUNCTION customer_vault.can_approve_book(uuid), customer_vault.gstin_valid(text), customer_vault.save_party(uuid, text, text, text, text),
  customer_vault.invoice_issues(uuid), customer_vault.save_invoice(uuid, jsonb, text, uuid, uuid), customer_vault.post_invoice(uuid, boolean),
  customer_vault.cancel_invoice(uuid, date), customer_vault.invoice_paid(uuid), customer_vault.record_payment(uuid, date, bigint, text, text),
  customer_vault.party_balances(uuid, date), customer_vault.gst_summary(uuid, date, date), customer_vault.account_ledger(uuid, text, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION customer_vault.invoice_issues(uuid), customer_vault.invoice_paid(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION customer_vault.can_approve_book(uuid), customer_vault.gstin_valid(text), customer_vault.save_party(uuid, text, text, text, text),
  customer_vault.save_invoice(uuid, jsonb, text, uuid, uuid), customer_vault.post_invoice(uuid, boolean), customer_vault.cancel_invoice(uuid, date),
  customer_vault.record_payment(uuid, date, bigint, text, text), customer_vault.party_balances(uuid, date),
  customer_vault.gst_summary(uuid, date, date), customer_vault.account_ledger(uuid, text, date, date) TO authenticated;

-- ===== 0004_business_files.sql =====
-- Universal Customer Vault — 0004: private business files (photos and PDFs of bills read by OCR).
-- Rules (preserved from the handover):
--   * Files stay in the private bucket "vault", in the business's own folder: b/<business_id>/<uuid>.<ext>.
--     They are opened only with short-lived signed URLs.
--   * Only members of that business can upload into or read its folder. Customers, other businesses and anonymous
--     visitors see nothing.
--   * Bill files are evidence for the books: nobody can delete them through the app (no delete policy), including
--     the owner. Customers' own folders (0001) are unchanged.
--   * A file can be linked to a business invoice only while that invoice is a draft or under review, and only to an
--     invoice of the same business.

-- Is this storage path inside the folder of a business I belong to?
CREATE OR REPLACE FUNCTION customer_vault.business_file_ok(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  WITH f AS (SELECT storage.foldername(p_name) AS parts)
  SELECT coalesce(array_length(parts, 1) = 2 AND parts[1] = 'b' AND parts[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p_name ~* '\.(jpe?g|png|webp|heic|heif|pdf)$' AND customer_vault.is_member(parts[2]::uuid), false) FROM f;
$$;
CREATE POLICY cv_business_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'customer-vault' AND customer_vault.business_file_ok(name));
CREATE POLICY cv_business_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'customer-vault' AND customer_vault.business_file_ok(name));

CREATE TABLE customer_vault.business_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES customer_vault.businesses(id) ON DELETE CASCADE,
  file_path text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill')),
  mime text,
  size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
CREATE INDEX business_files_business_idx ON customer_vault.business_files (business_id, created_at DESC);
ALTER TABLE customer_vault.business_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_vault.business_files FROM anon, authenticated;
GRANT SELECT ON customer_vault.business_files TO authenticated;
CREATE POLICY business_files_read ON customer_vault.business_files FOR SELECT TO authenticated USING (customer_vault.is_member(business_id));

ALTER TABLE customer_vault.invoices ADD COLUMN file_id uuid REFERENCES customer_vault.business_files(id) ON DELETE SET NULL;

-- A member records a file they uploaded into the business folder. Returns the file id.
CREATE OR REPLACE FUNCTION customer_vault.add_business_file(p_business uuid, p_file_path text, p_mime text DEFAULT NULL, p_size integer DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE f uuid;
BEGIN
  IF auth.uid() IS NULL OR p_business IS NULL OR NOT customer_vault.is_member(p_business) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_file_path IS NULL OR p_file_path NOT LIKE 'b/' || p_business::text || '/%' OR NOT customer_vault.business_file_ok(p_file_path)
     OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'customer-vault' AND o.name = p_file_path)
    THEN RAISE EXCEPTION 'bad_file'; END IF;
  INSERT INTO customer_vault.business_files(business_id, file_path, mime, size_bytes, uploaded_by)
  VALUES (p_business, p_file_path, left(p_mime, 100), p_size, auth.uid())
  ON CONFLICT (file_path) DO NOTHING
  RETURNING id INTO f;
  IF f IS NULL THEN SELECT id INTO f FROM customer_vault.business_files WHERE file_path = p_file_path AND business_id = p_business; END IF;
  RETURN f;
END $$;

-- Link a bill file to an invoice of the same business that is still a draft or under review.
CREATE OR REPLACE FUNCTION customer_vault.attach_invoice_file(p_invoice uuid, p_file uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE i customer_vault.invoices; biz uuid;
BEGIN
  SELECT * INTO i FROM customer_vault.invoices WHERE id = p_invoice FOR UPDATE;
  IF i.id IS NULL OR NOT customer_vault.can_use_book(i.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT b.business_id INTO biz FROM customer_vault.books b WHERE b.id = i.book_id;
  IF NOT EXISTS (SELECT 1 FROM customer_vault.business_files f WHERE f.id = p_file AND f.business_id = biz) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF i.status NOT IN ('draft', 'review') THEN RAISE EXCEPTION 'not_draft'; END IF;
  UPDATE customer_vault.invoices SET file_id = p_file WHERE id = p_invoice;
END $$;

REVOKE ALL ON FUNCTION customer_vault.business_file_ok(text), customer_vault.add_business_file(uuid, text, text, integer),
  customer_vault.attach_invoice_file(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION customer_vault.business_file_ok(text), customer_vault.add_business_file(uuid, text, text, integer),
  customer_vault.attach_invoice_file(uuid, uuid) TO authenticated;

COMMIT;
