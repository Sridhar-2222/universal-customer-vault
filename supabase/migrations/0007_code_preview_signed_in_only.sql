-- Fingertip Vault — 0007: only signed-in people may look up a business join code (Supabase advisor:
-- anon_security_definer_function_executable). The app checks a code only after sign-in, so visitors lose nothing,
-- and nobody can probe codes or read business names without an account.
REVOKE EXECUTE ON FUNCTION customer_vault.preview_business_code(text) FROM anon;
