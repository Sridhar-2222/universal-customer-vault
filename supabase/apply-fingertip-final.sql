-- Vault: FINAL piece for the Fingertip Supabase project (everything else is already in).
-- Locks down who can run each vault function, and adds the 3 functions that remove unposted drafts.
-- Only touches the vault's own schema customer_vault. Runs as one unit. Last line must be COMMIT;
BEGIN;
REVOKE ALL ON customer_vault.books, customer_vault.ledger_accounts, customer_vault.journal_entries, customer_vault.journal_lines, customer_vault.ai_suggestions FROM anon, authenticated;
GRANT SELECT ON customer_vault.books, customer_vault.ledger_accounts, customer_vault.journal_entries, customer_vault.journal_lines, customer_vault.ai_suggestions TO authenticated;
CREATE OR REPLACE FUNCTION customer_vault.delete_draft(p_entry uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  SELECT book_id INTO b FROM customer_vault.journal_entries WHERE id = p_entry AND status = 'draft';
  IF b IS NULL OR NOT customer_vault.can_use_book(b) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  UPDATE customer_vault.ai_suggestions SET draft_entry = NULL WHERE draft_entry = p_entry;
  DELETE FROM customer_vault.journal_entries WHERE id = p_entry;
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
REVOKE ALL ON customer_vault.parties, customer_vault.invoices, customer_vault.invoice_items, customer_vault.payments FROM anon, authenticated;
GRANT SELECT ON customer_vault.parties, customer_vault.invoices, customer_vault.invoice_items, customer_vault.payments TO authenticated;
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
REVOKE ALL ON FUNCTION customer_vault.can_approve_book(uuid), customer_vault.gstin_valid(text), customer_vault.save_party(uuid, text, text, text, text),
  customer_vault.invoice_issues(uuid), customer_vault.save_invoice(uuid, jsonb, text, uuid, uuid), customer_vault.post_invoice(uuid, boolean),
  customer_vault.cancel_invoice(uuid, date), customer_vault.invoice_paid(uuid), customer_vault.record_payment(uuid, date, bigint, text, text),
  customer_vault.party_balances(uuid, date), customer_vault.gst_summary(uuid, date, date), customer_vault.account_ledger(uuid, text, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION customer_vault.invoice_issues(uuid), customer_vault.invoice_paid(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION customer_vault.can_approve_book(uuid), customer_vault.gstin_valid(text), customer_vault.save_party(uuid, text, text, text, text),
  customer_vault.save_invoice(uuid, jsonb, text, uuid, uuid), customer_vault.post_invoice(uuid, boolean), customer_vault.cancel_invoice(uuid, date),
  customer_vault.record_payment(uuid, date, bigint, text, text), customer_vault.party_balances(uuid, date),
  customer_vault.gst_summary(uuid, date, date), customer_vault.account_ledger(uuid, text, date, date) TO authenticated;
REVOKE ALL ON customer_vault.business_files FROM anon, authenticated;
GRANT SELECT ON customer_vault.business_files TO authenticated;
REVOKE ALL ON FUNCTION customer_vault.business_file_ok(text), customer_vault.add_business_file(uuid, text, text, integer),
  customer_vault.attach_invoice_file(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION customer_vault.business_file_ok(text), customer_vault.add_business_file(uuid, text, text, integer),
  customer_vault.attach_invoice_file(uuid, uuid) TO authenticated;
COMMIT;
