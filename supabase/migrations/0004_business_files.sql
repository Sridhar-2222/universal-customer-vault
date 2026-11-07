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
CREATE OR REPLACE FUNCTION public.business_file_ok(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH f AS (SELECT storage.foldername(p_name) AS parts)
  SELECT coalesce(array_length(parts, 1) = 2 AND parts[1] = 'b' AND parts[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p_name ~* '\.(jpe?g|png|webp|heic|heif|pdf)$' AND public.is_member(parts[2]::uuid), false) FROM f;
$$;
CREATE POLICY vault_business_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vault' AND public.business_file_ok(name));
CREATE POLICY vault_business_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'vault' AND public.business_file_ok(name));

CREATE TABLE public.business_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  file_path text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill')),
  mime text,
  size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
CREATE INDEX business_files_business_idx ON public.business_files (business_id, created_at DESC);
ALTER TABLE public.business_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_files FROM anon, authenticated;
GRANT SELECT ON public.business_files TO authenticated;
CREATE POLICY business_files_read ON public.business_files FOR SELECT TO authenticated USING (public.is_member(business_id));

ALTER TABLE public.invoices ADD COLUMN file_id uuid REFERENCES public.business_files(id) ON DELETE SET NULL;

-- A member records a file they uploaded into the business folder. Returns the file id.
CREATE OR REPLACE FUNCTION public.add_business_file(p_business uuid, p_file_path text, p_mime text DEFAULT NULL, p_size integer DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f uuid;
BEGIN
  IF auth.uid() IS NULL OR p_business IS NULL OR NOT public.is_member(p_business) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_file_path IS NULL OR p_file_path NOT LIKE 'b/' || p_business::text || '/%' OR NOT public.business_file_ok(p_file_path)
     OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'vault' AND o.name = p_file_path)
    THEN RAISE EXCEPTION 'bad_file'; END IF;
  INSERT INTO public.business_files(business_id, file_path, mime, size_bytes, uploaded_by)
  VALUES (p_business, p_file_path, left(p_mime, 100), p_size, auth.uid())
  ON CONFLICT (file_path) DO NOTHING
  RETURNING id INTO f;
  IF f IS NULL THEN SELECT id INTO f FROM public.business_files WHERE file_path = p_file_path AND business_id = p_business; END IF;
  RETURN f;
END $$;

-- Link a bill file to an invoice of the same business that is still a draft or under review.
CREATE OR REPLACE FUNCTION public.attach_invoice_file(p_invoice uuid, p_file uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.invoices; biz uuid;
BEGIN
  SELECT * INTO i FROM public.invoices WHERE id = p_invoice FOR UPDATE;
  IF i.id IS NULL OR NOT public.can_use_book(i.book_id) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT b.business_id INTO biz FROM public.books b WHERE b.id = i.book_id;
  IF NOT EXISTS (SELECT 1 FROM public.business_files f WHERE f.id = p_file AND f.business_id = biz) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF i.status NOT IN ('draft', 'review') THEN RAISE EXCEPTION 'not_draft'; END IF;
  UPDATE public.invoices SET file_id = p_file WHERE id = p_invoice;
END $$;

REVOKE ALL ON FUNCTION public.business_file_ok(text), public.add_business_file(uuid, text, text, integer),
  public.attach_invoice_file(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.business_file_ok(text), public.add_business_file(uuid, text, text, integer),
  public.attach_invoice_file(uuid, uuid) TO authenticated;
