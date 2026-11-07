-- Universal Customer Vault — 0002: one accounting engine for personal and business books.
-- Rules (from the ChatGPT handover, preserved):
--   * Strict separation: a book is EITHER personal (one owner) OR business (its members); nothing mixes the two.
--   * Double entry in paise (integers, no rounding drift). An entry can be POSTED only if it has at least two lines
--     and total debit = total credit > 0. The database checks this; the app cannot skip it.
--   * Posted entries are never edited or deleted; mistakes are corrected with a reversing entry.
--   * AI never posts. AI suggestions are stored as suggestions; accepting one creates a DRAFT entry that a person
--     must review and post.
--   * Clients get SELECT only (via RLS); every write goes through the checked functions below.

CREATE TABLE public.books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('personal', 'business')),
  owner_user uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal' AND owner_user IS NOT NULL AND business_id IS NULL)
      OR (kind = 'business' AND business_id IS NOT NULL AND owner_user IS NULL))
);
CREATE UNIQUE INDEX books_one_personal ON public.books (owner_user) WHERE kind = 'personal';
CREATE UNIQUE INDEX books_one_business ON public.books (business_id) WHERE kind = 'business';

CREATE TABLE public.ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  UNIQUE (book_id, code),
  UNIQUE (id, book_id)
);
CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  memo text CHECK (memo IS NULL OR char_length(memo) <= 300),
  party text CHECK (party IS NULL OR char_length(party) <= 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'ocr', 'reversal')),
  source_document uuid REFERENCES public.vault_documents(id) ON DELETE SET NULL,
  reverses uuid REFERENCES public.journal_entries(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES auth.users(id),
  posted_at timestamptz,
  UNIQUE (id, book_id)
);
CREATE TABLE public.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL,
  book_id uuid NOT NULL,
  account_id uuid NOT NULL,
  debit_paise bigint NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise bigint NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  CHECK ((debit_paise > 0) <> (credit_paise > 0)),
  -- A line's account and entry must belong to the same book: no line can join personal and business books.
  FOREIGN KEY (entry_id, book_id) REFERENCES public.journal_entries(id, book_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, book_id) REFERENCES public.ledger_accounts(id, book_id)
);
CREATE TABLE public.ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  document_id uuid REFERENCES public.vault_documents(id) ON DELETE SET NULL,
  entry_date date NOT NULL,
  memo text CHECK (memo IS NULL OR char_length(memo) <= 300),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 2 AND 40),
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  draft_entry uuid REFERENCES public.journal_entries(id)
);
CREATE INDEX journal_entries_book_idx ON public.journal_entries (book_id, entry_date DESC);
CREATE INDEX journal_lines_entry_idx ON public.journal_lines (entry_id);
CREATE INDEX journal_lines_account_idx ON public.journal_lines (account_id);
CREATE INDEX ai_suggestions_book_idx ON public.ai_suggestions (book_id, status);

ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.books, public.ledger_accounts, public.journal_entries, public.journal_lines, public.ai_suggestions FROM anon, authenticated;
GRANT SELECT ON public.books, public.ledger_accounts, public.journal_entries, public.journal_lines, public.ai_suggestions TO authenticated;

CREATE OR REPLACE FUNCTION public.can_use_book(p_book uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.books b WHERE b.id = p_book AND (
    (b.kind = 'personal' AND b.owner_user = auth.uid()) OR (b.kind = 'business' AND public.is_member(b.business_id))));
$$;
CREATE POLICY books_read ON public.books FOR SELECT TO authenticated USING (public.can_use_book(id));
CREATE POLICY accounts_read ON public.ledger_accounts FOR SELECT TO authenticated USING (public.can_use_book(book_id));
CREATE POLICY entries_read ON public.journal_entries FOR SELECT TO authenticated USING (public.can_use_book(book_id));
CREATE POLICY lines_read ON public.journal_lines FOR SELECT TO authenticated USING (public.can_use_book(book_id));
CREATE POLICY suggestions_read ON public.ai_suggestions FOR SELECT TO authenticated USING (public.can_use_book(book_id));

-- Lines change only while their entry is a draft; posted entries cannot change at all (except by reversal).
CREATE OR REPLACE FUNCTION public.guard_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM public.journal_entries WHERE id = coalesce(NEW.entry_id, OLD.entry_id)) = 'posted' THEN
    RAISE EXCEPTION 'entry_posted';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_journal_lines();
CREATE OR REPLACE FUNCTION public.guard_journal_entries() RETURNS trigger LANGUAGE plpgsql AS $$
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
    FROM public.journal_lines WHERE entry_id = NEW.id;
    IF n < 2 OR dr <> cr OR dr = 0 THEN RAISE EXCEPTION 'not_balanced'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_journal_entries();

-- Standard accounts for new books (editable later).
CREATE OR REPLACE FUNCTION public.seed_accounts(p_book uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_kind = 'personal' THEN
    INSERT INTO public.ledger_accounts(book_id, code, name, type) VALUES
      (p_book, 'CASH', 'Cash', 'asset'), (p_book, 'BANK', 'Bank', 'asset'), (p_book, 'CARD', 'Credit card', 'liability'),
      (p_book, 'SALARY', 'Salary', 'income'), (p_book, 'OTHER_INCOME', 'Other income', 'income'),
      (p_book, 'HOUSEHOLD', 'Household', 'expense'), (p_book, 'BILLS', 'Bills & subscriptions', 'expense'),
      (p_book, 'FOOD', 'Food & groceries', 'expense'), (p_book, 'TRAVEL', 'Travel', 'expense'),
      (p_book, 'HEALTH', 'Medical', 'expense'), (p_book, 'EDUCATION', 'Education', 'expense'),
      (p_book, 'OTHER_EXPENSE', 'Other expenses', 'expense'), (p_book, 'OPENING', 'Opening balance', 'equity');
  ELSE
    INSERT INTO public.ledger_accounts(book_id, code, name, type) VALUES
      (p_book, 'CASH', 'Cash book', 'asset'), (p_book, 'BANK', 'Bank book', 'asset'),
      (p_book, 'RECEIVABLES', 'Sundry debtors (receivables)', 'asset'), (p_book, 'STOCK', 'Stock', 'asset'),
      (p_book, 'INPUT_CGST', 'Input CGST', 'asset'), (p_book, 'INPUT_SGST', 'Input SGST', 'asset'), (p_book, 'INPUT_IGST', 'Input IGST', 'asset'),
      (p_book, 'PAYABLES', 'Sundry creditors (payables)', 'liability'),
      (p_book, 'OUTPUT_CGST', 'Output CGST', 'liability'), (p_book, 'OUTPUT_SGST', 'Output SGST', 'liability'), (p_book, 'OUTPUT_IGST', 'Output IGST', 'liability'),
      (p_book, 'CAPITAL', 'Capital', 'equity'), (p_book, 'SALES', 'Sales', 'income'), (p_book, 'OTHER_INCOME', 'Other income', 'income'),
      (p_book, 'PURCHASES', 'Purchases', 'expense'), (p_book, 'EXPENSES', 'Expenses', 'expense'), (p_book, 'DISCOUNT', 'Discount allowed', 'expense');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.my_personal_book() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  SELECT id INTO b FROM public.books WHERE kind = 'personal' AND owner_user = auth.uid();
  IF b IS NULL THEN
    INSERT INTO public.books(kind, owner_user, name) VALUES ('personal', auth.uid(), 'My accounts') RETURNING id INTO b;
    PERFORM public.seed_accounts(b, 'personal');
  END IF;
  RETURN b;
END $$;
CREATE OR REPLACE FUNCTION public.business_book(p_business uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  IF NOT public.is_member(p_business) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT id INTO b FROM public.books WHERE kind = 'business' AND business_id = p_business;
  IF b IS NULL THEN
    IF coalesce(public.member_role(p_business), '') NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
    INSERT INTO public.books(kind, business_id, name) VALUES ('business', p_business, 'Business accounts') RETURNING id INTO b;
    PERFORM public.seed_accounts(b, 'business');
  END IF;
  RETURN b;
END $$;

-- Create a DRAFT entry with lines given as [{"account":"CODE","debit":paise,"credit":paise,"note":"…"}].
CREATE OR REPLACE FUNCTION public.create_draft_entry(p_book uuid, p_date date, p_memo text, p_party text, p_lines jsonb,
  p_source text DEFAULT 'manual', p_document uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e uuid; l jsonb; acc uuid;
BEGIN
  IF NOT public.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_source NOT IN ('manual', 'ai', 'ocr') THEN RAISE EXCEPTION 'bad_source'; END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 2 AND 40 THEN RAISE EXCEPTION 'bad_lines'; END IF;
  IF p_document IS NOT NULL AND NOT public.can_see_document(p_document) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  INSERT INTO public.journal_entries(book_id, entry_date, memo, party, source, source_document, created_by)
  VALUES (p_book, p_date, nullif(btrim(coalesce(p_memo, '')), ''), nullif(btrim(coalesce(p_party, '')), ''), p_source, p_document, auth.uid())
  RETURNING id INTO e;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT id INTO acc FROM public.ledger_accounts WHERE book_id = p_book AND code = l->>'account';
    IF acc IS NULL THEN RAISE EXCEPTION 'unknown_account'; END IF;
    INSERT INTO public.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, note)
    VALUES (e, p_book, acc, coalesce((l->>'debit')::bigint, 0), coalesce((l->>'credit')::bigint, 0), nullif(left(coalesce(l->>'note', ''), 200), ''));
  END LOOP;
  RETURN e;
END $$;

-- A person posts a draft. The trigger refuses unbalanced entries.
CREATE OR REPLACE FUNCTION public.post_entry(p_entry uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM public.journal_entries WHERE id = p_entry;
  IF b IS NULL OR NOT public.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE public.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = p_entry AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'not_draft'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.delete_draft(p_entry uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM public.journal_entries WHERE id = p_entry AND status = 'draft';
  IF b IS NULL OR NOT public.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE public.ai_suggestions SET draft_entry = NULL WHERE draft_entry = p_entry;
  DELETE FROM public.journal_entries WHERE id = p_entry;
END $$;
-- Correct a posted entry: a new posted entry with debits and credits swapped.
CREATE OR REPLACE FUNCTION public.reverse_entry(p_entry uuid, p_date date DEFAULT current_date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.journal_entries; e uuid;
BEGIN
  SELECT * INTO o FROM public.journal_entries WHERE id = p_entry;
  IF o.id IS NULL OR NOT public.can_use_book(o.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF o.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE reverses = p_entry) THEN RAISE EXCEPTION 'already_reversed'; END IF;
  INSERT INTO public.journal_entries(book_id, entry_date, memo, party, source, reverses, created_by)
  VALUES (o.book_id, p_date, left('Reversal: ' || coalesce(o.memo, ''), 300), o.party, 'reversal', o.id, auth.uid()) RETURNING id INTO e;
  INSERT INTO public.journal_lines(entry_id, book_id, account_id, debit_paise, credit_paise, note)
  SELECT e, book_id, account_id, credit_paise, debit_paise, note FROM public.journal_lines WHERE entry_id = p_entry;
  UPDATE public.journal_entries SET status = 'posted', posted_by = auth.uid(), posted_at = now() WHERE id = e;
  RETURN e;
END $$;

-- AI (or OCR) proposes; it can never post. Accepting creates a DRAFT for a person to review and post.
CREATE OR REPLACE FUNCTION public.suggest_entry(p_book uuid, p_date date, p_memo text, p_lines jsonb,
  p_confidence numeric DEFAULT NULL, p_document uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s uuid;
BEGIN
  IF NOT public.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_document IS NOT NULL AND NOT public.can_see_document(p_document) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  INSERT INTO public.ai_suggestions(book_id, document_id, entry_date, memo, lines, confidence, created_by)
  VALUES (p_book, p_document, p_date, p_memo, p_lines, p_confidence, auth.uid()) RETURNING id INTO s;
  RETURN s;
END $$;
CREATE OR REPLACE FUNCTION public.accept_suggestion(p_suggestion uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.ai_suggestions; e uuid;
BEGIN
  SELECT * INTO s FROM public.ai_suggestions WHERE id = p_suggestion;
  IF s.id IS NULL OR NOT public.can_use_book(s.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'already_decided'; END IF;
  e := public.create_draft_entry(s.book_id, s.entry_date, s.memo, NULL, s.lines, 'ai', s.document_id);
  UPDATE public.ai_suggestions SET status = 'accepted', decided_by = auth.uid(), decided_at = now(), draft_entry = e WHERE id = s.id;
  RETURN e;
END $$;
CREATE OR REPLACE FUNCTION public.reject_suggestion(p_suggestion uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM public.ai_suggestions WHERE id = p_suggestion AND status = 'pending';
  IF b IS NULL OR NOT public.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE public.ai_suggestions SET status = 'rejected', decided_by = auth.uid(), decided_at = now() WHERE id = p_suggestion;
END $$;

-- Totals per account for posted entries in a date range (P&L, balance sheet and summaries are built from this).
CREATE OR REPLACE FUNCTION public.account_totals(p_book uuid, p_from date, p_to date)
RETURNS TABLE(account_id uuid, code text, name text, type text, debit_paise bigint, credit_paise bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_use_book(p_book) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  RETURN QUERY SELECT a.id, a.code, a.name, a.type,
    coalesce(sum(l.debit_paise) FILTER (WHERE e.id IS NOT NULL), 0)::bigint, coalesce(sum(l.credit_paise) FILTER (WHERE e.id IS NOT NULL), 0)::bigint
  FROM public.ledger_accounts a
  LEFT JOIN public.journal_lines l ON l.account_id = a.id
  LEFT JOIN public.journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.entry_date BETWEEN p_from AND p_to
  WHERE a.book_id = p_book GROUP BY a.id, a.code, a.name, a.type ORDER BY a.type, a.code;
END $$;

REVOKE ALL ON FUNCTION public.can_use_book(uuid), public.seed_accounts(uuid, text), public.my_personal_book(), public.business_book(uuid),
  public.create_draft_entry(uuid, date, text, text, jsonb, text, uuid), public.post_entry(uuid), public.delete_draft(uuid),
  public.reverse_entry(uuid, date), public.suggest_entry(uuid, date, text, jsonb, numeric, uuid), public.accept_suggestion(uuid),
  public.reject_suggestion(uuid), public.account_totals(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seed_accounts(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_book(uuid), public.my_personal_book(), public.business_book(uuid),
  public.create_draft_entry(uuid, date, text, text, jsonb, text, uuid), public.post_entry(uuid), public.delete_draft(uuid),
  public.reverse_entry(uuid, date), public.suggest_entry(uuid, date, text, jsonb, numeric, uuid), public.accept_suggestion(uuid),
  public.reject_suggestion(uuid), public.account_totals(uuid, date, date) TO authenticated;
