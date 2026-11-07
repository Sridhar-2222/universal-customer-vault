-- Business bill files (0004). Business 'biz' from 10_vault.sql: b1 owner, b2 staff, b3 unrelated; c1 a linked customer.
select t.as_user('00000000-0000-0000-0000-0000000000b3');
insert into v values ('biz2', public.create_business('Other Traders')::text);

select t.as_user('00000000-0000-0000-0000-0000000000b2');
insert into storage.objects(bucket_id, name, owner) values ('vault', 'b/' || (select val from v where k='biz') || '/bill1.jpg', '00000000-0000-0000-0000-0000000000b2');
select t.ok('staff uploads a bill photo into their business folder',
  t.rows($$select 1 from storage.objects where name = 'b/' || (select val from v where k='biz') || '/bill1.jpg'$$) = 1);
select t.ok('staff cannot upload into another business''s folder',
  t.fails($$insert into storage.objects(bucket_id, name, owner) values ('vault', 'b/' || (select val from v where k='biz2') || '/x.jpg', '00000000-0000-0000-0000-0000000000b2')$$));
select t.ok('only photos and PDFs are accepted in a business folder',
  t.fails($$insert into storage.objects(bucket_id, name, owner) values ('vault', 'b/' || (select val from v where k='biz') || '/x.exe', '00000000-0000-0000-0000-0000000000b2')$$));
insert into v values ('f1', public.add_business_file((select val::uuid from v where k='biz'), 'b/' || (select val from v where k='biz') || '/bill1.jpg', 'image/jpeg', 2048)::text);
select t.ok('staff records the file; a missing or misplaced file is refused',
  (select val is not null from v where k='f1')
  and t.fails($$select public.add_business_file((select val::uuid from v where k='biz'), 'b/' || (select val from v where k='biz') || '/nothere.jpg')$$, 'bad_file')
  and t.fails($$select public.add_business_file((select val::uuid from v where k='biz'), 'b/' || (select val from v where k='biz2') || '/bill1.jpg')$$, 'bad_file'));
insert into v values ('r1', public.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"purchase","number":"PB-77","date":"2026-11-02",
  "party":{"name":"Usha Fans"},"items":[{"description":"Fan","qty":1,"rate":100000,"gst_rate":18}],"cgst":9000,"sgst":9000,"total":118000,
  "ocr":{"engine":"paddle"}}$j$::jsonb, 'ocr')::text);
select public.attach_invoice_file((select val::uuid from v where k='r1'), (select val::uuid from v where k='f1'));
select t.ok('the photo is linked to the bill under review',
  (select file_id = (select val::uuid from v where k='f1') and status = 'review' from public.invoices where id = (select val::uuid from v where k='r1')));
select t.ok('a photo cannot be linked to a posted invoice',
  t.fails($$select public.attach_invoice_file((select val::uuid from v where k='s1'), (select val::uuid from v where k='f1'))$$, 'not_draft'));

select t.as_user('00000000-0000-0000-0000-0000000000b1');
select t.ok('the owner sees the file and its record',
  t.rows($$select 1 from storage.objects where name = 'b/' || (select val from v where k='biz') || '/bill1.jpg'$$) = 1
  and t.rows($$select 1 from public.business_files$$) = 1);
delete from storage.objects where name = 'b/' || (select val from v where k='biz') || '/bill1.jpg';
reset role;
select t.ok('nobody can delete a bill file, not even the owner',
  (select count(*) = 1 from storage.objects where name = 'b/' || (select val from v where k='biz') || '/bill1.jpg'));

select t.as_user('00000000-0000-0000-0000-0000000000b3');
select t.ok('another business cannot see the file, its record, or link it',
  t.rows($$select 1 from storage.objects where name like 'b/%'$$) = 0
  and t.rows($$select 1 from public.business_files$$) = 0
  and t.fails($$select public.attach_invoice_file((select val::uuid from v where k='r1'), (select val::uuid from v where k='f1'))$$, 'not_allowed'));
select t.ok('another business cannot record a file in this business',
  t.fails($$select public.add_business_file((select val::uuid from v where k='biz'), 'b/' || (select val from v where k='biz') || '/bill1.jpg')$$, 'not_allowed'));

select t.as_user('00000000-0000-0000-0000-0000000000c1');
select t.ok('a linked customer cannot see the business''s bill files',
  t.rows($$select 1 from storage.objects where name like 'b/%'$$) = 0 and t.rows($$select 1 from public.business_files$$) = 0);

select t.as_user(null);
select t.ok('anonymous visitors see nothing and cannot call the functions',
  t.rows($$select 1 from storage.objects where name like 'b/%'$$) = 0
  and t.fails($$select public.add_business_file((select val::uuid from v where k='biz'), 'b/x/y.jpg')$$));
reset role;
