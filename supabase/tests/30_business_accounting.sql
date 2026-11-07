-- Business accounting (0003): invoices, GST checks, approval, payments, ledgers, reports. Synthetic data only.
-- Business 'biz' (state 36, Telangana) from 10_vault.sql: b1 owner, b2 staff, b3 unrelated; c1 a customer.
-- Valid test GSTINs: 36AAACR5055K1Z8 (Telangana), 27AAACS1234F1ZS (Maharashtra), 36AAPFU0939F1ZW (Telangana).
select t.as_user('00000000-0000-0000-0000-0000000000b2');
insert into v values ('s1', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-101","date":"2026-10-20","due_date":"2026-10-30",
  "party":{"name":"Ravi Traders","gstin":"36AAACR5055K1Z8"},
  "items":[{"description":"LED bulb 9W","hsn":"8539","qty":10,"rate":10000,"gst_rate":18},{"description":"Wire 90m","hsn":"8544","qty":1,"rate":200000,"discount":20000,"gst_rate":18}],
  "cgst":25200,"sgst":25200,"igst":0,"total":330400}$j$::jsonb)::text);
select t.ok('staff saves a sale invoice as a draft with no issues',
  (select status = 'draft' and issues = '{}' and taxable_paise = 280000 and round_off_paise = 0 from customer_vault.invoices where id = (select val::uuid from v where k='s1')));
select t.ok('staff cannot post (approval is owner/admin)', t.fails($$select customer_vault.post_invoice((select val::uuid from v where k='s1'))$$, 'not_allowed'));
select t.ok('staff cannot post journal entries in a business book either',
  t.fails($$select customer_vault.post_entry(customer_vault.create_draft_entry((select val::uuid from v where k='bbook'), '2026-10-20', 'x', null, '[{"account":"CASH","debit":100},{"account":"SALES","credit":100}]'))$$, 'not_allowed'));

select t.as_user('00000000-0000-0000-0000-0000000000b1');
select customer_vault.post_invoice((select val::uuid from v where k='s1'));
select t.ok('owner posts it: one balanced entry, receivable on the customer',
  (select status = 'posted' and entry_id is not null from customer_vault.invoices where id = (select val::uuid from v where k='s1'))
  and (select sum(debit_paise) = 330400 and sum(credit_paise) = 330400 from customer_vault.journal_lines where entry_id = (select entry_id from customer_vault.invoices where id = (select val::uuid from v where k='s1')))
  and (select party_id is not null from customer_vault.journal_lines l join customer_vault.ledger_accounts a on a.id = l.account_id
       where a.code = 'RECEIVABLES' and l.entry_id = (select entry_id from customer_vault.invoices where id = (select val::uuid from v where k='s1'))));
select t.ok('a posted invoice is locked', t.fails($$select customer_vault.save_invoice((select val::uuid from v where k='bbook'), '{"kind":"sale","number":"INV-101","date":"2026-10-20","party":{"name":"Ravi Traders"},"items":[],"total":1}', 'manual', null, (select val::uuid from v where k='s1'))$$, 'not_draft'));

-- Checks that block posting.
insert into v values ('dup', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"inv-101","date":"2026-10-21","party":{"name":"Ravi Traders"},
  "items":[{"description":"Bulb","qty":1,"rate":10000,"gst_rate":18}],"cgst":900,"sgst":900,"total":11800}$j$::jsonb)::text);
select t.ok('the same sale number is flagged and cannot be posted',
  (select 'duplicate_number' = any(issues) from customer_vault.invoices where id = (select val::uuid from v where k='dup'))
  and t.fails($$select customer_vault.post_invoice((select val::uuid from v where k='dup'))$$, 'has_issues'));
insert into v values ('off', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-102","date":"2026-10-21","party":{"name":"Walk-in"},
  "items":[{"description":"Bulb","qty":1,"rate":10000,"gst_rate":18}],"cgst":900,"sgst":900,"total":12300}$j$::jsonb)::text);
select t.ok('a total that does not add up (by more than ₹1) is flagged', (select issues = '{items_total_mismatch}' from customer_vault.invoices where id = (select val::uuid from v where k='off')));
insert into v values ('igst', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-103","date":"2026-10-21","party":{"name":"Ravi Traders","gstin":"36AAACR5055K1Z8"},
  "items":[{"description":"Bulb","qty":1,"rate":10000,"gst_rate":18}],"igst":1800,"total":11800}$j$::jsonb)::text);
select t.ok('IGST to a customer in the same state is flagged', (select 'wrong_tax_type' = any(issues) from customer_vault.invoices where id = (select val::uuid from v where k='igst')));
insert into v values ('inter', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-104","date":"2026-10-21","party":{"name":"Shah & Co","gstin":"27AAACS1234F1ZS"},
  "items":[{"description":"Bulb","qty":1,"rate":10000,"gst_rate":18}],"cgst":900,"sgst":900,"total":11800}$j$::jsonb)::text);
select t.ok('CGST+SGST to another state is flagged', (select 'wrong_tax_type' = any(issues) from customer_vault.invoices where id = (select val::uuid from v where k='inter')));
insert into v values ('rate', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-105","date":"2026-10-21","party":{"name":"Walk-in"},
  "items":[{"description":"Bulb","qty":1,"rate":10000,"gst_rate":18}],"cgst":500,"sgst":500,"total":11000}$j$::jsonb)::text);
select t.ok('tax that does not match the GST rate is flagged', (select 'tax_rate_mismatch' = any(issues) from customer_vault.invoices where id = (select val::uuid from v where k='rate')));
select t.ok('a wrong GSTIN check digit is refused', t.fails($$select customer_vault.save_party((select val::uuid from v where k='bbook'), 'customer', 'Fake', '36AAACR5055K1Z9')$$, 'bad_gstin'));
-- Fixing the draft clears the issue (same id).
select customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-104","date":"2026-10-21","party":{"name":"Shah & Co","gstin":"27AAACS1234F1ZS"},
  "items":[{"description":"Bulb","qty":1,"rate":10000,"gst_rate":18}],"igst":1800,"total":11800}$j$::jsonb, 'manual', null, (select val::uuid from v where k='inter'));
select t.ok('correcting a draft clears its issues', (select issues = '{}' from customer_vault.invoices where id = (select val::uuid from v where k='inter')));
select customer_vault.post_invoice((select val::uuid from v where k='inter'));
insert into v values ('ro', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"sale","number":"INV-106","date":"2026-10-22","party":{"name":"Walk-in"},
  "items":[{"description":"Switch","qty":3,"rate":3390,"gst_rate":18}],"cgst":900,"sgst":900,"total":12000}$j$::jsonb)::text);
select customer_vault.post_invoice((select val::uuid from v where k='ro'));
select t.ok('round-off up to ₹1 posts through the round-off account',
  (select round_off_paise = 30 and issues = '{}' from customer_vault.invoices where id = (select val::uuid from v where k='ro'))
  and t.rows($$select 1 from customer_vault.journal_lines l join customer_vault.ledger_accounts a on a.id = l.account_id where a.code = 'ROUND_OFF'$$) = 1);

-- OCR purchase: saved for review; posting needs an explicit confirmation.
insert into v values ('p1', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"purchase","number":"UF/2026/889","date":"2026-10-15","due_date":"2026-10-25",
  "party":{"name":"Udaya Fittings","gstin":"36AAPFU0939F1ZW"},
  "items":[{"description":"LED bulb 9W","hsn":"8539","qty":100,"rate":6000,"gst_rate":18}],"cgst":54000,"sgst":54000,"total":708000,
  "ocr":{"engine":"paddleocr","confidence":{"total":0.97,"number":0.88}}}$j$::jsonb, 'ocr')::text);
select t.ok('an OCR invoice is saved for review, not posted', (select status = 'review' and source = 'ocr' from customer_vault.invoices where id = (select val::uuid from v where k='p1')));
select t.ok('posting an OCR invoice needs an explicit confirmation', t.fails($$select customer_vault.post_invoice((select val::uuid from v where k='p1'))$$, 'confirm_required'));
select customer_vault.post_invoice((select val::uuid from v where k='p1'), true);
select t.ok('the confirmed purchase books input GST and a payable to the supplier',
  (select sum(l.debit_paise) = 108000 from customer_vault.journal_lines l join customer_vault.ledger_accounts a on a.id = l.account_id
   where a.code in ('INPUT_CGST','INPUT_SGST') and l.entry_id = (select entry_id from customer_vault.invoices where id = (select val::uuid from v where k='p1')))
  and (select source = 'ocr' from customer_vault.journal_entries where id = (select entry_id from customer_vault.invoices where id = (select val::uuid from v where k='p1'))));
insert into v values ('p1dup', customer_vault.save_invoice((select val::uuid from v where k='bbook'), $j${"kind":"purchase","number":"UF/2026/889","date":"2026-10-15",
  "party":{"name":"Udaya Fittings","gstin":"36AAPFU0939F1ZW"},"items":[{"description":"LED bulb 9W","qty":100,"rate":6000,"gst_rate":18}],"cgst":54000,"sgst":54000,"total":708000}$j$::jsonb, 'ocr')::text);
select t.ok('the same supplier bill read twice is caught as a duplicate', (select 'duplicate_number' = any(issues) from customer_vault.invoices where id = (select val::uuid from v where k='p1dup')));

-- Payments.
select t.as_user('00000000-0000-0000-0000-0000000000b2');
select t.ok('a payment cannot be more than what is due', t.fails($$select customer_vault.record_payment((select val::uuid from v where k='s1'), '2026-10-25', 330401, 'bank')$$, 'more_than_due'));
select customer_vault.record_payment((select val::uuid from v where k='s1'), '2026-10-25', 130400, 'bank', 'UPI 5521');
select customer_vault.record_payment((select val::uuid from v where k='p1'), '2026-10-20', 200000, 'cash');
select t.ok('staff records money received and paid', t.rows('select 1 from customer_vault.payments') = 2);
select t.ok('receivables and payables per party, with overdue after the due date',
  (select outstanding_paise = 200000 and overdue_paise = 200000 from customer_vault.party_balances((select val::uuid from v where k='bbook'), '2026-11-07') where name = 'Ravi Traders')
  and (select outstanding_paise = 508000 and kind = 'supplier' from customer_vault.party_balances((select val::uuid from v where k='bbook'), '2026-11-07') where name = 'Udaya Fittings')
  and (select overdue_paise = 0 from customer_vault.party_balances((select val::uuid from v where k='bbook'), '2026-10-28') where name = 'Ravi Traders'));
select t.ok('the cash book shows opening and running balance',
  (select array_agg(balance_paise order by entry_date) = array[0::bigint, -200000] from customer_vault.account_ledger((select val::uuid from v where k='bbook'), 'CASH', '2026-10-01', '2026-10-31')));

select t.as_user('00000000-0000-0000-0000-0000000000b1');
select t.ok('an invoice with payments cannot be cancelled', t.fails($$select customer_vault.cancel_invoice((select val::uuid from v where k='s1'))$$, 'has_payments'));
insert into v values ('ro_cancel', customer_vault.cancel_invoice((select val::uuid from v where k='ro'), '2026-10-23'));
select t.ok('an unpaid posted invoice is cancelled by reversal and kept', (select val = 'cancelled' from v where k='ro_cancel')
  and (select status = 'cancelled' from customer_vault.invoices where id = (select val::uuid from v where k='ro'))
  and (select count(*) = 2 from customer_vault.journal_lines l join customer_vault.ledger_accounts a on a.id = l.account_id where a.code = 'ROUND_OFF'));
select t.ok('a draft is simply removed', customer_vault.cancel_invoice((select val::uuid from v where k='off')) = 'deleted');
select t.ok('GST summary: output tax on sales, input credit on purchases',
  (select cgst_paise = 25200 and igst_paise = 1800 and invoices = 2 from customer_vault.gst_summary((select val::uuid from v where k='bbook'), '2026-10-01', '2026-10-31') where kind = 'sale')
  and (select cgst_paise = 54000 and sgst_paise = 54000 from customer_vault.gst_summary((select val::uuid from v where k='bbook'), '2026-10-01', '2026-10-31') where kind = 'purchase'));
select t.ok('the whole business ledger stays balanced',
  (select sum(debit_paise) = sum(credit_paise) from customer_vault.journal_lines l join customer_vault.journal_entries e on e.id = l.entry_id
   where e.status = 'posted' and e.book_id = (select val::uuid from v where k='bbook')));

-- Outsiders.
select t.as_user('00000000-0000-0000-0000-0000000000b3');
select t.ok('an unrelated business sees no invoices, parties or payments',
  t.rows('select 1 from customer_vault.invoices') = 0 and t.rows('select 1 from customer_vault.parties') = 0 and t.rows('select 1 from customer_vault.payments') = 0);
select t.ok('an unrelated business cannot write into this book or read its reports',
  t.fails($$select customer_vault.save_invoice((select val::uuid from v where k='bbook'), '{"kind":"sale","number":"X","date":"2026-10-01","party":{"name":"x"},"items":[],"total":100}')$$, 'not_allowed')
  and t.fails($$select * from customer_vault.party_balances((select val::uuid from v where k='bbook'))$$, 'not_allowed'));
select t.as_user('00000000-0000-0000-0000-0000000000c1');
select t.ok('invoices belong to business books only (personal book refused)',
  t.fails($$select customer_vault.save_invoice((select val::uuid from v where k='pbook'), '{"kind":"sale","number":"X","date":"2026-10-01","party":{"name":"x"},"items":[],"total":100}')$$, 'not_allowed'));
reset role;
select t.ok('posted invoices cannot be edited even directly',
  t.fails($$update customer_vault.invoices set total_paise = 1 where id = (select val::uuid from v where k='s1')$$, 'invoice_posted')
  and t.fails($$delete from customer_vault.invoice_items where invoice_id = (select val::uuid from v where k='s1')$$, 'invoice_posted'));
