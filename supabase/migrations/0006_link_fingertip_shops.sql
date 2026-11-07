-- Fingertip Vault — 0006: a Fingertip shop IS its Vault business (owner decision "Link them", 8 Nov 2026).
-- Requires the Fingertip tables public.businesses (id, legal_name) and public.business_members (business_id, user_id,
-- role owner|admin|staff). The Vault only READS them; it never writes to Fingertip's tables.
--   * A Vault business may be linked to exactly one Fingertip shop (fingertip_business_id, unique).
--   * For a linked business, Fingertip's staff list is the only staff list: membership and role come from
--     public.business_members, so adding or removing someone in Fingertip changes Vault access at once.
--     add_business_member refuses linked businesses (manage staff in Fingertip).
--   * The shop's Vault business is created the first time an owner/admin opens it (open_fingertip_business);
--     any member gets the same business afterwards. Unlinked Vault businesses (other apps) work as before.

ALTER TABLE customer_vault.businesses ADD COLUMN fingertip_business_id uuid UNIQUE;

-- Membership and role: the Vault's own members, or the linked Fingertip shop's members.
CREATE OR REPLACE FUNCTION customer_vault.member_role(p_business uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT coalesce(
    (SELECT m.role FROM customer_vault.business_members m WHERE m.business_id = p_business AND m.user_id = auth.uid()),
    (SELECT fm.role FROM customer_vault.businesses b
       JOIN public.business_members fm ON fm.business_id = b.fingertip_business_id
      WHERE b.id = p_business AND fm.user_id = auth.uid() AND fm.role IN ('owner', 'admin', 'staff')));
$$;
CREATE OR REPLACE FUNCTION customer_vault.is_member(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = customer_vault AS $$
  SELECT customer_vault.member_role(p_business) IS NOT NULL;
$$;

-- Open (and on first use create) the Vault business of a Fingertip shop the caller belongs to.
CREATE OR REPLACE FUNCTION customer_vault.open_fingertip_business(p_fingertip uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE b uuid; r text; nm text;
BEGIN
  IF auth.uid() IS NULL OR p_fingertip IS NULL THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT fm.role INTO r FROM public.business_members fm WHERE fm.business_id = p_fingertip AND fm.user_id = auth.uid();
  IF r IS NULL OR r NOT IN ('owner', 'admin', 'staff') THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT id INTO b FROM customer_vault.businesses WHERE fingertip_business_id = p_fingertip;
  IF b IS NOT NULL THEN RETURN b; END IF;
  IF r NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'owner_must_open_first'; END IF;
  SELECT left(btrim(legal_name), 120) INTO nm FROM public.businesses WHERE id = p_fingertip;
  IF nm IS NULL OR char_length(nm) < 2 THEN nm := 'My business'; END IF;
  INSERT INTO customer_vault.businesses(name, created_by, fingertip_business_id) VALUES (nm, auth.uid(), p_fingertip)
  ON CONFLICT (fingertip_business_id) DO NOTHING RETURNING id INTO b;
  IF b IS NULL THEN SELECT id INTO b FROM customer_vault.businesses WHERE fingertip_business_id = p_fingertip; END IF;
  RETURN b;
END $$;

-- Owner/admin set the business GSTIN (needed for CGST/SGST vs IGST checks). Empty clears it.
CREATE OR REPLACE FUNCTION customer_vault.set_business_gstin(p_business uuid, p_gstin text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE g text := nullif(upper(btrim(coalesce(p_gstin, ''))), '');
BEGIN
  IF coalesce(customer_vault.member_role(p_business), '') NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF g IS NOT NULL AND NOT customer_vault.gstin_valid(g) THEN RAISE EXCEPTION 'bad_gstin'; END IF;
  UPDATE customer_vault.businesses SET gstin = g WHERE id = p_business;
END $$;

-- Staff of a linked shop are managed in Fingertip only (one staff list).
CREATE OR REPLACE FUNCTION customer_vault.add_business_member(p_business uuid, p_email text, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = customer_vault AS $$
DECLARE me text := customer_vault.member_role(p_business); u uuid;
BEGIN
  IF me IS NULL OR me NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF EXISTS (SELECT 1 FROM customer_vault.businesses WHERE id = p_business AND fingertip_business_id IS NOT NULL)
    THEN RAISE EXCEPTION 'staff_managed_in_fingertip'; END IF;
  IF p_role NOT IN ('admin', 'staff') OR (p_role = 'admin' AND me <> 'owner') THEN RAISE EXCEPTION 'bad_role'; END IF;
  SELECT id INTO u FROM auth.users WHERE lower(email) = lower(btrim(p_email));
  IF u IS NULL THEN RAISE EXCEPTION 'user_not_found'; END IF;
  INSERT INTO customer_vault.business_members(business_id, user_id, role) VALUES (p_business, u, p_role) ON CONFLICT DO NOTHING;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION customer_vault.open_fingertip_business(uuid), customer_vault.set_business_gstin(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION customer_vault.open_fingertip_business(uuid), customer_vault.set_business_gstin(uuid, text) TO authenticated;
