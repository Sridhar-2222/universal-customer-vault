-- Vault ownership, business sending and customer-controlled sharing. Synthetic users only.
-- C = customer, C2 = other customer, O = business owner, S = business staff, X = unrelated business owner, F = friend.
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'customer@example.test'), ('00000000-0000-0000-0000-0000000000c2', 'customer2@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@example.test'), ('00000000-0000-0000-0000-0000000000b2', 'staff@example.test'),
  ('00000000-0000-0000-0000-0000000000b3', 'other@example.test'), ('00000000-0000-0000-0000-0000000000f1', 'friend@example.test');
create temp table v(k text primary key, val text);
grant all on v to anon, authenticated;

-- Customer stores a document in their own vault.
select t.as_user('00000000-0000-0000-0000-0000000000c1');
insert into storage.objects(bucket_id, name, owner) values ('vault', '00000000-0000-0000-0000-0000000000c1/w.pdf', '00000000-0000-0000-0000-0000000000c1');
insert into v values ('mine', public.add_my_document('Fridge warranty', 'warranty', 'personal', '00000000-0000-0000-0000-0000000000c1/w.pdf', 'application/pdf', 1000, '2026-11-01', '2028-11-01', 'Warranty card 2 years')::text);
select t.ok('owner sees own document', t.rows('select 1 from public.vault_documents') = 1);
select t.ok('health records are refused here (kept separately)',
  t.fails($$select public.add_my_document('x', 'other', 'health', '00000000-0000-0000-0000-0000000000c1/w.pdf', 'application/pdf', 1)$$, 'health_kept_separately'));
select t.ok('cannot record a file outside own folder',
  t.fails($$select public.add_my_document('x', 'other', 'personal', '00000000-0000-0000-0000-0000000000c2/x.pdf', 'application/pdf', 1)$$, 'bad_file'));
select t.ok('cannot upload into another person''s folder',
  t.fails($$insert into storage.objects(bucket_id, name, owner) values ('vault', '00000000-0000-0000-0000-0000000000c2/x.pdf', '00000000-0000-0000-0000-0000000000c1')$$));
select t.ok('clients cannot write vault tables directly', t.fails($$update public.vault_documents set title = 'x'$$));

-- Business setup.
select t.as_user('00000000-0000-0000-0000-0000000000b1');
insert into v values ('biz', public.create_business('Sai Electronics', '36ABCDE1234F1Z5')::text);
select t.ok('owner adds staff by email', public.add_business_member((select val::uuid from v where k='biz'), 'staff@example.test', 'staff') = 'ok');
insert into v values ('code', public.business_join_code((select val::uuid from v where k='biz')));
select t.ok('business gets an 8-letter join code', (select val ~ '^[A-HJ-NP-Z2-9]{8}$' from v where k='code'));
select t.ok('business cannot see the customer''s own documents', t.rows('select 1 from public.vault_documents') = 0);
select t.as_user('00000000-0000-0000-0000-0000000000b2');
select t.ok('staff cannot send before the customer links',
  t.fails($$insert into storage.objects(bucket_id, name, owner) values ('vault', '00000000-0000-0000-0000-0000000000c1/' || (select val from v where k='biz') || '/inv.pdf', '00000000-0000-0000-0000-0000000000b2')$$));

-- Customer links the business with consent; the business sends an invoice.
select t.as_user(null);
select t.ok('anyone can preview a business code', (select business_name = 'Sai Electronics' from public.preview_business_code((select val from v where k='code'))));
select t.as_user('00000000-0000-0000-0000-0000000000c1');
select t.ok('linking needs consent', t.fails($$select public.link_business((select val from v where k='code'), false)$$, 'consent_required'));
select public.link_business((select val from v where k='code'), true);
select t.as_user('00000000-0000-0000-0000-0000000000b2');
insert into storage.objects(bucket_id, name, owner) values ('vault', '00000000-0000-0000-0000-0000000000c1/' || (select val from v where k='biz') || '/inv.pdf', '00000000-0000-0000-0000-0000000000b2');
insert into v values ('sent', public.send_document((select val::uuid from v where k='biz'), '00000000-0000-0000-0000-0000000000c1', 'Invoice 1043', 'invoice',
  '00000000-0000-0000-0000-0000000000c1/' || (select val from v where k='biz') || '/inv.pdf', 'application/pdf', 2000, '2026-11-05')::text);
select t.ok('staff sees only what the business sent, not the warranty', t.rows('select 1 from public.vault_documents') = 1
  and t.rows($$select 1 from public.vault_documents where title = 'Fridge warranty'$$) = 0);
select t.ok('staff cannot send to someone who never linked',
  t.fails($$select public.send_document((select val::uuid from v where k='biz'), '00000000-0000-0000-0000-0000000000c2', 'x', 'invoice', '00000000-0000-0000-0000-0000000000c2/x.pdf', 'application/pdf', 1)$$, 'customer_not_linked'));

select t.as_user('00000000-0000-0000-0000-0000000000c1');
select t.ok('customer sees both documents in their vault', t.rows('select 1 from public.vault_documents') = 2);
select t.ok('the sent invoice belongs to the customer', (select owner_id = '00000000-0000-0000-0000-0000000000c1' from public.vault_documents where title = 'Invoice 1043'));

-- Customer shares the warranty with a friend for 7 days, then revokes.
insert into v values ('share', public.share_document((select val::uuid from v where k='mine'), null, 'friend@example.test', 7)::text);
select t.as_user('00000000-0000-0000-0000-0000000000f1');
select t.ok('friend sees the shared document', t.rows($$select 1 from public.vault_documents where title = 'Fridge warranty'$$) = 1);
select t.ok('friend can read the shared file', t.rows($$select 1 from storage.objects where bucket_id = 'vault' and name like '%/w.pdf'$$) = 1);
select t.ok('friend cannot revoke the share', t.fails($$select public.revoke_share((select val::uuid from v where k='share'))$$, 'not_allowed'));
select t.as_user('00000000-0000-0000-0000-0000000000c1');
select public.revoke_share((select val::uuid from v where k='share'));
select t.as_user('00000000-0000-0000-0000-0000000000f1');
select t.ok('after revoking, the friend sees nothing', t.rows('select 1 from public.vault_documents') = 0
  and t.rows($$select 1 from storage.objects where bucket_id = 'vault'$$) = 0);

-- Unrelated business and other customer see nothing.
select t.as_user('00000000-0000-0000-0000-0000000000b3');
select t.ok('unrelated business sees no documents or files', t.rows('select 1 from public.vault_documents') = 0
  and t.rows($$select 1 from storage.objects where bucket_id = 'vault'$$) = 0);
select t.as_user('00000000-0000-0000-0000-0000000000c2');
select t.ok('another customer sees nothing', t.rows('select 1 from public.vault_documents') = 0);

-- Customer unlinks: the business can no longer send.
select t.as_user('00000000-0000-0000-0000-0000000000c1');
select public.unlink_business((select val::uuid from v where k='biz'));
select t.as_user('00000000-0000-0000-0000-0000000000b2');
select t.ok('after unlinking, the business cannot send',
  t.fails($$insert into storage.objects(bucket_id, name, owner) values ('vault', '00000000-0000-0000-0000-0000000000c1/' || (select val from v where k='biz') || '/inv2.pdf', '00000000-0000-0000-0000-0000000000b2')$$));
select t.as_user('00000000-0000-0000-0000-0000000000c1');
select t.ok('activity history records every step',
  (select count(*) >= 6 from public.vault_activity) and t.fails($$delete from public.vault_activity$$));
reset role;
