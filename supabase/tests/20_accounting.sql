-- Accounting engine: balance enforcement, posted entries locked, AI drafts only, personal/business separation.
select t.as_user('00000000-0000-0000-0000-0000000000c1');
insert into v values ('pbook', customer_vault.my_personal_book()::text);
select t.ok('personal book created with standard accounts', (select count(*) >= 10 from customer_vault.ledger_accounts));
select t.ok('second call returns the same personal book', customer_vault.my_personal_book() = (select val::uuid from v where k='pbook'));
insert into v values ('e1', customer_vault.create_draft_entry((select val::uuid from v where k='pbook'), '2026-11-05', 'Groceries', 'Ratnadeep',
  '[{"account":"FOOD","debit":125000},{"account":"CASH","credit":125000}]')::text);
select customer_vault.post_entry((select val::uuid from v where k='e1'));
select t.ok('a balanced entry posts', (select status = 'posted' from customer_vault.journal_entries where id = (select val::uuid from v where k='e1')));
insert into v values ('bad', customer_vault.create_draft_entry((select val::uuid from v where k='pbook'), '2026-11-05', 'Typo', null,
  '[{"account":"FOOD","debit":10000},{"account":"CASH","credit":9000}]')::text);
select t.ok('an unbalanced entry is refused at posting', t.fails($$select customer_vault.post_entry((select val::uuid from v where k='bad'))$$, 'not_balanced'));
select t.ok('a posted entry cannot be changed', t.fails($$select customer_vault.delete_draft((select val::uuid from v where k='e1'))$$, 'not_allowed'));
select t.ok('clients cannot write ledgers directly', t.fails($$update customer_vault.journal_entries set memo = 'x'$$) and t.fails($$delete from customer_vault.journal_lines$$));
select t.ok('unknown accounts are refused', t.fails($$select customer_vault.create_draft_entry((select val::uuid from v where k='pbook'), '2026-11-05', 'x', null, '[{"account":"NOPE","debit":1},{"account":"CASH","credit":1}]')$$, 'unknown_account'));
insert into v values ('rev', customer_vault.reverse_entry((select val::uuid from v where k='e1'), '2026-11-06')::text);
select t.ok('a mistake is corrected by a reversing entry, which nets to zero',
  (select sum(debit_paise) - sum(credit_paise) = 0 from customer_vault.account_totals((select val::uuid from v where k='pbook'), '2026-11-01', '2026-11-30') where code = 'FOOD'));
select t.ok('an entry cannot be reversed twice', t.fails($$select customer_vault.reverse_entry((select val::uuid from v where k='e1'))$$, 'already_reversed'));

-- AI suggestion: never posts by itself.
insert into v values ('sug', customer_vault.suggest_entry((select val::uuid from v where k='pbook'), '2026-11-06', 'Electricity bill',
  '[{"account":"BILLS","debit":84000},{"account":"BANK","credit":84000}]', 0.92)::text);
select t.ok('a suggestion leaves the ledger untouched', t.rows($$select 1 from customer_vault.journal_entries where memo = 'Electricity bill'$$) = 0);
insert into v values ('draft', customer_vault.accept_suggestion((select val::uuid from v where k='sug'))::text);
select t.ok('accepting creates a DRAFT, not a posted entry', (select status = 'draft' and source = 'ai' from customer_vault.journal_entries where id = (select val::uuid from v where k='draft')));
select customer_vault.post_entry((select val::uuid from v where k='draft'));
select t.ok('the person then posts it', (select status = 'posted' and posted_by = '00000000-0000-0000-0000-0000000000c1' from customer_vault.journal_entries where id = (select val::uuid from v where k='draft')));

-- Business book: separate, members only.
select t.as_user('00000000-0000-0000-0000-0000000000b1');
insert into v values ('bbook', customer_vault.business_book((select val::uuid from v where k='biz'))::text);
select t.ok('business book has GST and ledger accounts', t.rows($$select 1 from customer_vault.ledger_accounts where code in ('OUTPUT_CGST','INPUT_SGST','RECEIVABLES','PAYABLES')$$) = 4);
select t.ok('the business sees none of the customer''s personal accounts', t.rows($$select 1 from customer_vault.journal_entries$$) = 0
  and t.rows($$select 1 from customer_vault.books where kind = 'personal'$$) = 0);
select t.ok('a business entry cannot use a personal-book account',
  t.fails($$select customer_vault.create_draft_entry((select val::uuid from v where k='pbook'), '2026-11-05', 'x', null, '[{"account":"CASH","debit":1},{"account":"FOOD","credit":1}]')$$, 'not_allowed'));
insert into v values ('sale', customer_vault.create_draft_entry((select val::uuid from v where k='bbook'), '2026-11-05', 'Invoice 1043', 'Ravi',
  '[{"account":"RECEIVABLES","debit":118000},{"account":"SALES","credit":100000},{"account":"OUTPUT_CGST","credit":9000},{"account":"OUTPUT_SGST","credit":9000}]', 'ocr')::text);
select customer_vault.post_entry((select val::uuid from v where k='sale'));
select t.ok('a GST sale with three credits posts when balanced', (select status = 'posted' from customer_vault.journal_entries where id = (select val::uuid from v where k='sale')));
select t.as_user('00000000-0000-0000-0000-0000000000b3');
select t.ok('an unrelated business sees no books', t.rows('select 1 from customer_vault.books') = 0 and t.fails($$select customer_vault.business_book((select val::uuid from v where k='biz'))$$, 'not_allowed'));
reset role;
select t.ok('posting is refused even for direct database edits when unbalanced',
  t.fails($$update customer_vault.journal_entries set status = 'posted', posted_at = now() where id = (select val::uuid from v where k='bad')$$, 'not_balanced'));
select t.ok('entries cannot be created already posted', t.fails($$insert into customer_vault.journal_entries(book_id, entry_date, status, created_by, posted_at) values ((select val::uuid from v where k='pbook'), '2026-11-05', 'posted', '00000000-0000-0000-0000-0000000000c1', now())$$, 'insert_as_draft'));
