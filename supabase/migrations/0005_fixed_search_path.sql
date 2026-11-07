-- Fingertip Vault — 0005: fix the search_path of the 7 helper functions that had none (Supabase security
-- advisor: function_search_path_mutable). They already use fully qualified names; this only pins them.
ALTER FUNCTION customer_vault.share_is_live(customer_vault.document_shares) SET search_path = customer_vault;
ALTER FUNCTION customer_vault.uv_new_code() SET search_path = customer_vault;
ALTER FUNCTION customer_vault.guard_journal_lines() SET search_path = customer_vault;
ALTER FUNCTION customer_vault.guard_journal_entries() SET search_path = customer_vault;
ALTER FUNCTION customer_vault.gstin_valid(text) SET search_path = customer_vault;
ALTER FUNCTION customer_vault.guard_invoices() SET search_path = customer_vault;
ALTER FUNCTION customer_vault.guard_invoice_items() SET search_path = customer_vault;
