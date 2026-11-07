-- Fingertip Vault — 0001: personal document vault, businesses, sending and sharing.
-- The vault is one generic part shared by Fingertrip.biz AI and Rx Fingertip (owner decision, 7 Nov 2026). It lives
-- in the Fingertip Supabase project in its OWN schema, customer_vault, and its own bucket, customer-vault, so it
-- never changes or reads Fingertip's own tables or files. ("vault" is taken by Supabase's built-in secrets store.)
-- Rules (from the ChatGPT handover, preserved):
--   * Each customer OWNS their vault (vault_documents.owner_id). Only the owner browses it.
--   * A business can SEND a document into a customer's vault, but only after that customer linked to it with
--     explicit consent; the business sees only what it sent and what the customer chose to share with it.
--   * The customer controls sharing (to a business or a person), can set an end date and revoke at any time.
--   * Every action is written to vault_activity, which the owner can read and nobody can change.
--   * Health records are kept OUT of this store (domain 'health' is refused); they get a separate store later.
--   * All writes go through checked SECURITY DEFINER functions; clients get SELECT only, via RLS.
-- Files: private bucket "customer-vault" at <owner_id>/<uuid>.<ext> (own uploads) or
-- <owner_id>/<business_id>/<uuid>.<ext> (sent by a business).

CREATE SCHEMA customer_vault;
REVOKE ALL ON SCHEMA customer_vault FROM PUBLIC;
GRANT USAGE ON SCHEMA customer_vault TO anon, authenticated, service_role;

CREATE TABLE customer_vault.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'),
  join_code text UNIQUE CHECK (join_code IS NULL OR join_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_vault.business_members (
  business_id uuid NOT NULL REFERENCES customer_vault.businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  PRIMARY KEY (business_id, user_id)
);
CREATE TABLE customer_vault.customer_links (
  business_id uuid NOT NULL REFERENCES customer_vault.businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  consent_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (business_id, customer_id)
);
CREATE TABLE customer_vault.vault_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain text NOT NULL DEFAULT 'personal' CHECK (domain IN ('personal', 'business')),
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('invoice', 'receipt', 'purchase', 'warranty', 'booking', 'appointment',
    'personal', 'notice', 'contract', 'id', 'other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  doc_date date,
  remind_on date,
  file_path text NOT NULL UNIQUE,
  mime text NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  ocr_text text CHECK (ocr_text IS NULL OR char_length(ocr_text) <= 20000),
  sent_by_business uuid REFERENCES customer_vault.businesses(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_vault.document_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES customer_vault.vault_documents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grantee_business uuid REFERENCES customer_vault.businesses(id) ON DELETE CASCADE,
  grantee_user uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  can_download boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((grantee_business IS NULL) <> (grantee_user IS NULL))
);
CREATE TABLE customer_vault.vault_activity (
  id bigserial PRIMARY KEY,
  owner_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  document_id uuid,
  business_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_documents_owner_idx ON customer_vault.vault_documents (owner_id, created_at DESC);
CREATE INDEX vault_documents_sender_idx ON customer_vault.vault_documents (sent_by_business);
CREATE INDEX document_shares_doc_idx ON customer_vault.document_shares (document_id);
CREATE INDEX document_shares_business_idx ON customer_vault.document_shares (grantee_business);
CREATE INDEX document_shares_user_idx ON customer_vault.document_shares (grantee_user);
CREATE INDEX vault_activity_owner_idx ON customer_vault.vault_activity (owner_id, at DESC);
CREATE INDEX business_members_user_idx ON customer_vault.business_members (user_id);
CREATE INDEX customer_links_customer_idx ON customer_vault.customer_links (customer_id);

ALTER TABLE customer_vault.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.vault_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.document_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_vault.vault_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_vault.businesses, customer_vault.business_members, customer_vault.customer_links, customer_vault.vault_documents,
  customer_vault.document_shares, customer_vault.vault_activity FROM anon, authenticated;
GRANT SELECT ON customer_vault.businesses, customer_vault.business_members, customer_vault.customer_links, customer_vault.vault_documents,
  customer_vault.document_shares, customer_vault.vault_activity TO authenticated;

CREATE OR REPLACE FUNCTION customer_vault.is_member(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT EXISTS (SELECT 1 FROM customer_vault.business_members WHERE business_id = p_business AND user_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION customer_vault.member_role(p_business uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT role FROM customer_vault.business_members WHERE business_id = p_business AND user_id = auth.uid();
$$;
CREATE OR REPLACE FUNCTION customer_vault.share_is_live(s customer_vault.document_shares) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) $$;
CREATE OR REPLACE FUNCTION customer_vault.can_see_document(p_doc uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT EXISTS (SELECT 1 FROM customer_vault.vault_documents d WHERE d.id = p_doc AND (
    d.owner_id = auth.uid()
    OR (d.sent_by_business IS NOT NULL AND customer_vault.is_member(d.sent_by_business))
    OR EXISTS (SELECT 1 FROM customer_vault.document_shares s WHERE s.document_id = d.id AND customer_vault.share_is_live(s)
      AND (s.grantee_user = auth.uid() OR (s.grantee_business IS NOT NULL AND customer_vault.is_member(s.grantee_business))))));
$$;

CREATE POLICY businesses_read ON customer_vault.businesses FOR SELECT TO authenticated
  USING (customer_vault.is_member(id) OR EXISTS (SELECT 1 FROM customer_vault.customer_links l WHERE l.business_id = id AND l.customer_id = (SELECT auth.uid())));
CREATE POLICY members_read ON customer_vault.business_members FOR SELECT TO authenticated USING (customer_vault.is_member(business_id));
CREATE POLICY links_read ON customer_vault.customer_links FOR SELECT TO authenticated
  USING (customer_id = (SELECT auth.uid()) OR customer_vault.is_member(business_id));
CREATE POLICY documents_read ON customer_vault.vault_documents FOR SELECT TO authenticated USING (customer_vault.can_see_document(id));
CREATE POLICY shares_read ON customer_vault.document_shares FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) OR grantee_user = (SELECT auth.uid()) OR (grantee_business IS NOT NULL AND customer_vault.is_member(grantee_business)));
CREATE POLICY activity_read ON customer_vault.vault_activity FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('customer-vault', 'customer-vault', false, 20971520, ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])
ON CONFLICT (id) DO NOTHING;

-- Upload: the owner into their own folder, or a member of a linked business into <customer>/<business>/.
CREATE OR REPLACE FUNCTION customer_vault.vault_upload_ok(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  WITH f AS (SELECT storage.foldername(p_name) AS parts)
  SELECT CASE
    WHEN array_length(parts, 1) = 1 THEN parts[1] = auth.uid()::text
    WHEN array_length(parts, 1) = 2 THEN parts[1] ~ '^[0-9a-f-]{36}$' AND parts[2] ~ '^[0-9a-f-]{36}$'
      AND customer_vault.is_member(parts[2]::uuid)
      AND EXISTS (SELECT 1 FROM customer_vault.customer_links l WHERE l.business_id = parts[2]::uuid
        AND l.customer_id = parts[1]::uuid AND l.status = 'active')
    ELSE false END FROM f;
$$;
CREATE POLICY cv_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'customer-vault' AND customer_vault.vault_upload_ok(name));
CREATE POLICY cv_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'customer-vault' AND (
    EXISTS (SELECT 1 FROM customer_vault.vault_documents d WHERE d.file_path = storage.objects.name AND customer_vault.can_see_document(d.id))
    OR (owner = (SELECT auth.uid()) AND customer_vault.vault_upload_ok(name))));
CREATE POLICY cv_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'customer-vault' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

CREATE OR REPLACE FUNCTION customer_vault.log_activity(p_owner uuid, p_action text, p_doc uuid, p_business uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = customer_vault AS $$
  INSERT INTO customer_vault.vault_activity(owner_id, actor_id, action, document_id, business_id) VALUES (p_owner, auth.uid(), p_action, p_doc, p_business);
$$;

-- Owner: record a file they uploaded to their own folder.
CREATE OR REPLACE FUNCTION customer_vault.add_my_document(p_title text, p_kind text, p_domain text, p_file_path text, p_mime text,
  p_size integer, p_doc_date date DEFAULT NULL, p_remind_on date DEFAULT NULL, p_ocr_text text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE d uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF p_domain = 'health' THEN RAISE EXCEPTION 'health_kept_separately'; END IF;
  IF p_file_path IS NULL OR p_file_path NOT LIKE auth.uid()::text || '/%' OR array_length(storage.foldername(p_file_path), 1) <> 1
     OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'customer-vault' AND o.name = p_file_path)
    THEN RAISE EXCEPTION 'bad_file'; END IF;
  INSERT INTO customer_vault.vault_documents(owner_id, domain, kind, title, doc_date, remind_on, file_path, mime, size_bytes, ocr_text, created_by)
  VALUES (auth.uid(), coalesce(p_domain, 'personal'), coalesce(p_kind, 'other'), btrim(p_title), p_doc_date, p_remind_on, p_file_path,
    p_mime, p_size, nullif(left(btrim(coalesce(p_ocr_text, '')), 20000), ''), auth.uid())
  RETURNING id INTO d;
  PERFORM customer_vault.log_activity(auth.uid(), 'added', d, NULL);
  RETURN d;
END $$;

-- Owner: delete one of their documents (the app then removes the stored file).
CREATE OR REPLACE FUNCTION customer_vault.delete_my_document(p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE f text;
BEGIN
  DELETE FROM customer_vault.vault_documents WHERE id = p_id AND owner_id = auth.uid() RETURNING file_path INTO f;
  IF f IS NULL THEN RAISE EXCEPTION 'not_allowed'; END IF;
  PERFORM customer_vault.log_activity(auth.uid(), 'deleted', p_id, NULL);
  RETURN f;
END $$;

-- Business setup.
CREATE OR REPLACE FUNCTION customer_vault.uv_new_code() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') FROM generate_series(1, 8);
$$;
CREATE OR REPLACE FUNCTION customer_vault.create_business(p_name text, p_gstin text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  INSERT INTO customer_vault.businesses(name, gstin, created_by) VALUES (btrim(p_name), nullif(upper(btrim(coalesce(p_gstin, ''))), ''), auth.uid()) RETURNING id INTO b;
  INSERT INTO customer_vault.business_members(business_id, user_id, role) VALUES (b, auth.uid(), 'owner');
  RETURN b;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.add_business_member(p_business uuid, p_email text, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE me text := customer_vault.member_role(p_business); u uuid;
BEGIN
  IF me IS NULL OR me NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_role NOT IN ('admin', 'staff') OR (p_role = 'admin' AND me <> 'owner') THEN RAISE EXCEPTION 'bad_role'; END IF;
  SELECT id INTO u FROM auth.users WHERE lower(email) = lower(btrim(p_email));
  IF u IS NULL THEN RAISE EXCEPTION 'user_not_found'; END IF;
  INSERT INTO customer_vault.business_members(business_id, user_id, role) VALUES (p_business, u, p_role) ON CONFLICT DO NOTHING;
  RETURN 'ok';
END $$;
CREATE OR REPLACE FUNCTION customer_vault.business_join_code(p_business uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE v text;
BEGIN
  IF coalesce(customer_vault.member_role(p_business), '') NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT join_code INTO v FROM customer_vault.businesses WHERE id = p_business;
  WHILE v IS NULL LOOP
    BEGIN UPDATE customer_vault.businesses SET join_code = customer_vault.uv_new_code() WHERE id = p_business RETURNING join_code INTO v;
    EXCEPTION WHEN unique_violation THEN v := NULL; END;
  END LOOP;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.preview_business_code(p_code text) RETURNS TABLE(business_id uuid, business_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT id, name FROM customer_vault.businesses WHERE join_code = upper(btrim(p_code));
$$;

-- Customer: allow a business to send documents into my vault (explicit consent), or stop it.
CREATE OR REPLACE FUNCTION customer_vault.link_business(p_code text, p_consent boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF p_consent IS NOT TRUE THEN RAISE EXCEPTION 'consent_required'; END IF;
  SELECT id INTO b FROM customer_vault.businesses WHERE join_code = upper(btrim(p_code));
  IF b IS NULL THEN RAISE EXCEPTION 'bad_code'; END IF;
  INSERT INTO customer_vault.customer_links(business_id, customer_id, status, consent_at) VALUES (b, auth.uid(), 'active', now())
  ON CONFLICT (business_id, customer_id) DO UPDATE SET status = 'active', consent_at = now(), revoked_at = NULL;
  PERFORM customer_vault.log_activity(auth.uid(), 'business_linked', NULL, b);
  RETURN b;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.unlink_business(p_business uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
BEGIN
  UPDATE customer_vault.customer_links SET status = 'revoked', revoked_at = now() WHERE business_id = p_business AND customer_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'not_linked'; END IF;
  PERFORM customer_vault.log_activity(auth.uid(), 'business_unlinked', NULL, p_business);
END $$;

-- Business member: send a document into a linked customer's vault (stored at <customer>/<business>/<file>).
CREATE OR REPLACE FUNCTION customer_vault.send_document(p_business uuid, p_customer uuid, p_title text, p_kind text, p_file_path text,
  p_mime text, p_size integer, p_doc_date date DEFAULT NULL, p_ocr_text text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE d uuid;
BEGIN
  IF NOT customer_vault.is_member(p_business) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_vault.customer_links WHERE business_id = p_business AND customer_id = p_customer AND status = 'active')
    THEN RAISE EXCEPTION 'customer_not_linked'; END IF;
  IF p_file_path NOT LIKE p_customer::text || '/' || p_business::text || '/%'
     OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'customer-vault' AND o.name = p_file_path)
    THEN RAISE EXCEPTION 'bad_file'; END IF;
  INSERT INTO customer_vault.vault_documents(owner_id, domain, kind, title, doc_date, file_path, mime, size_bytes, ocr_text, sent_by_business, created_by)
  VALUES (p_customer, 'personal', coalesce(p_kind, 'other'), btrim(p_title), p_doc_date, p_file_path, p_mime, p_size,
    nullif(left(btrim(coalesce(p_ocr_text, '')), 20000), ''), p_business, auth.uid())
  RETURNING id INTO d;
  PERFORM customer_vault.log_activity(p_customer, 'received_from_business', d, p_business);
  RETURN d;
END $$;

-- Owner: share one document with a business they linked to, or with a person by email; optional end date.
CREATE OR REPLACE FUNCTION customer_vault.share_document(p_doc uuid, p_business uuid DEFAULT NULL, p_email text DEFAULT NULL,
  p_days integer DEFAULT NULL, p_can_download boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE s uuid; u uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_vault.vault_documents WHERE id = p_doc AND owner_id = auth.uid()) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF (p_business IS NULL) = (p_email IS NULL) THEN RAISE EXCEPTION 'one_recipient'; END IF;
  IF p_days IS NOT NULL AND (p_days < 1 OR p_days > 3650) THEN RAISE EXCEPTION 'bad_days'; END IF;
  IF p_business IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_vault.customer_links WHERE business_id = p_business AND customer_id = auth.uid() AND status = 'active')
    THEN RAISE EXCEPTION 'business_not_linked'; END IF;
  IF p_email IS NOT NULL THEN
    SELECT id INTO u FROM auth.users WHERE lower(email) = lower(btrim(p_email));
    IF u IS NULL THEN RAISE EXCEPTION 'user_not_found'; END IF;
    IF u = auth.uid() THEN RAISE EXCEPTION 'one_recipient'; END IF;
  END IF;
  INSERT INTO customer_vault.document_shares(document_id, owner_id, grantee_business, grantee_user, can_download, expires_at)
  VALUES (p_doc, auth.uid(), p_business, u, coalesce(p_can_download, true), CASE WHEN p_days IS NOT NULL THEN now() + make_interval(days => p_days) END)
  RETURNING id INTO s;
  PERFORM customer_vault.log_activity(auth.uid(), 'shared', p_doc, p_business);
  RETURN s;
END $$;
CREATE OR REPLACE FUNCTION customer_vault.revoke_share(p_share uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE d uuid;
BEGIN
  UPDATE customer_vault.document_shares SET revoked_at = now() WHERE id = p_share AND owner_id = auth.uid() AND revoked_at IS NULL RETURNING document_id INTO d;
  IF d IS NULL THEN RAISE EXCEPTION 'not_allowed'; END IF;
  PERFORM customer_vault.log_activity(auth.uid(), 'share_revoked', d, NULL);
END $$;

REVOKE ALL ON FUNCTION customer_vault.is_member(uuid), customer_vault.member_role(uuid), customer_vault.can_see_document(uuid), customer_vault.vault_upload_ok(text),
  customer_vault.log_activity(uuid, text, uuid, uuid), customer_vault.add_my_document(text, text, text, text, text, integer, date, date, text),
  customer_vault.delete_my_document(uuid), customer_vault.uv_new_code(), customer_vault.create_business(text, text), customer_vault.add_business_member(uuid, text, text),
  customer_vault.business_join_code(uuid), customer_vault.preview_business_code(text), customer_vault.link_business(text, boolean), customer_vault.unlink_business(uuid),
  customer_vault.send_document(uuid, uuid, text, text, text, text, integer, date, text), customer_vault.share_document(uuid, uuid, text, integer, boolean),
  customer_vault.revoke_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION customer_vault.is_member(uuid), customer_vault.member_role(uuid), customer_vault.can_see_document(uuid), customer_vault.vault_upload_ok(text),
  customer_vault.add_my_document(text, text, text, text, text, integer, date, date, text), customer_vault.delete_my_document(uuid),
  customer_vault.create_business(text, text), customer_vault.add_business_member(uuid, text, text), customer_vault.business_join_code(uuid),
  customer_vault.preview_business_code(text), customer_vault.link_business(text, boolean), customer_vault.unlink_business(uuid),
  customer_vault.send_document(uuid, uuid, text, text, text, text, integer, date, text), customer_vault.share_document(uuid, uuid, text, integer, boolean),
  customer_vault.revoke_share(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION customer_vault.preview_business_code(text) TO anon;
