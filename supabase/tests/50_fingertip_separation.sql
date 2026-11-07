-- The vault lives beside Fingertip without touching it (see 05_fingertip_lookalike.sql).
reset role;
insert into storage.objects(bucket_id, name, owner) values ('patient-vault', '00000000-0000-0000-0000-0000000000c1/rx.jpg', '00000000-0000-0000-0000-0000000000c1');
select t.ok('the vault created nothing in Fingertip''s public schema (only the two lookalike tables are there)',
  (select count(*) = 2 from pg_tables where schemaname = 'public'));
select t.ok('vault businesses go to the vault''s own table, never to Fingertip''s public.businesses',
  (select count(*) = 0 from public.businesses) and (select count(*) > 0 from customer_vault.businesses));

select t.as_user('00000000-0000-0000-0000-0000000000c1');
select t.ok('the vault''s file rules give no access to Fingertip''s files (patient-vault)',
  t.rows($$select 1 from storage.objects where bucket_id = 'patient-vault'$$) = 0
  and t.fails($$insert into storage.objects(bucket_id, name, owner) values ('patient-vault', '00000000-0000-0000-0000-0000000000c1/x.jpg', '00000000-0000-0000-0000-0000000000c1')$$));
reset role;
