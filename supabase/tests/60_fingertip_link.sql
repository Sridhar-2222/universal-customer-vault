-- A Fingertip shop is its Vault business (0006). Fingertip shop 'Sai Medicals': e1 owner, e2 staff; e3 owns another shop.
reset role;
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'shopowner@example.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'shopstaff@example.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'othershop@example.test');
insert into public.businesses(id, kind, legal_name) values
  ('00000000-0000-0000-0000-00000000f001', 'chemist', 'Sai Medicals'),
  ('00000000-0000-0000-0000-00000000f002', 'chemist', 'Other Pharmacy');
insert into public.business_members(business_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000e1', 'owner'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000e2', 'staff'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000e3', 'owner');

select t.as_user('00000000-0000-0000-0000-0000000000e2');
select t.ok('shop staff cannot be the first to open the shop''s Vault business',
  t.fails($$select customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001')$$, 'owner_must_open_first'));

select t.as_user('00000000-0000-0000-0000-0000000000e1');
insert into v values ('fv', customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001')::text);
select t.ok('the shop owner opens it: one Vault business with the shop''s name, linked to the shop',
  (select name = 'Sai Medicals' and fingertip_business_id = '00000000-0000-0000-0000-00000000f001' from customer_vault.businesses where id = (select val::uuid from v where k='fv'))
  and customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001') = (select val::uuid from v where k='fv')
  and customer_vault.member_role((select val::uuid from v where k='fv')) = 'owner');
select t.ok('no separate staff list: the Vault member table stays empty for a linked shop',
  t.rows($$select 1 from customer_vault.business_members where business_id = (select val::uuid from v where k='fv')$$) = 0);
select t.ok('staff are added in Fingertip, not in the Vault',
  t.fails($$select customer_vault.add_business_member((select val::uuid from v where k='fv'), 'shopstaff@example.test', 'staff')$$, 'staff_managed_in_fingertip'));
select customer_vault.set_business_gstin((select val::uuid from v where k='fv'), '36aaacr5055k1z8');
select t.ok('the owner sets the shop GSTIN (checked); a wrong one is refused',
  (select gstin = '36AAACR5055K1Z8' from customer_vault.businesses where id = (select val::uuid from v where k='fv'))
  and t.fails($$select customer_vault.set_business_gstin((select val::uuid from v where k='fv'), '36AAACR5055K1Z9')$$, 'bad_gstin'));
insert into v values ('fbook', customer_vault.business_book((select val::uuid from v where k='fv'))::text);

select t.as_user('00000000-0000-0000-0000-0000000000e2');
select t.ok('shop staff now get the same business with role staff, and can use its books',
  customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001') = (select val::uuid from v where k='fv')
  and customer_vault.member_role((select val::uuid from v where k='fv')) = 'staff'
  and t.rows($$select 1 from customer_vault.books where id = (select val::uuid from v where k='fbook')$$) = 1);
insert into v values ('fs1', customer_vault.save_invoice((select val::uuid from v where k='fbook'), $j${"kind":"sale","number":"S-1","date":"2026-11-08",
  "party":{"name":"Walk-in"},"items":[{"description":"Paracetamol 650","qty":2,"rate":3000,"gst_rate":12}],"cgst":360,"sgst":360,"total":6720}$j$::jsonb)::text);
select t.ok('staff can save a draft invoice but not post it, and cannot set the GSTIN',
  (select status = 'draft' from customer_vault.invoices where id = (select val::uuid from v where k='fs1'))
  and t.fails($$select customer_vault.post_invoice((select val::uuid from v where k='fs1'))$$, 'not_allowed')
  and t.fails($$select customer_vault.set_business_gstin((select val::uuid from v where k='fv'), null)$$, 'not_allowed'));

select t.as_user('00000000-0000-0000-0000-0000000000e3');
select t.ok('the owner of another shop cannot open, see or use this shop''s Vault business',
  t.fails($$select customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001')$$, 'not_allowed')
  and t.rows($$select 1 from customer_vault.businesses where id = (select val::uuid from v where k='fv')$$) = 0
  and t.rows($$select 1 from customer_vault.invoices where book_id = (select val::uuid from v where k='fbook')$$) = 0
  and t.fails($$select customer_vault.business_book((select val::uuid from v where k='fv'))$$, 'not_allowed'));

reset role;
delete from public.business_members where business_id = '00000000-0000-0000-0000-00000000f001' and user_id = '00000000-0000-0000-0000-0000000000e2';
select t.as_user('00000000-0000-0000-0000-0000000000e2');
select t.ok('removing someone from the shop in Fingertip ends their Vault access at once',
  t.rows($$select 1 from customer_vault.businesses where id = (select val::uuid from v where k='fv')$$) = 0
  and t.rows($$select 1 from customer_vault.invoices where book_id = (select val::uuid from v where k='fbook')$$) = 0
  and t.fails($$select customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001')$$, 'not_allowed'));

select t.as_user(null);
select t.ok('visitors cannot open a shop''s Vault business',
  t.fails($$select customer_vault.open_fingertip_business('00000000-0000-0000-0000-00000000f001')$$));
reset role;
select t.ok('one shop links to one Vault business only',
  t.fails($$insert into customer_vault.businesses(name, created_by, fingertip_business_id) values ('Copy', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000f001')$$));
select t.ok('the Vault never wrote to Fingertip''s tables',
  (select count(*) = 2 from public.businesses) and (select count(*) = 2 from public.business_members));
