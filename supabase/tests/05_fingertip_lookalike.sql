-- LOCAL TEST ONLY. Stand-ins for objects the live Fingertip project already has in its own `public` schema, with the
-- same names the vault uses. They are deliberately UNSAFE (is_member/can_use_book always say yes): if any vault
-- function or rule ever used these instead of its own customer_vault.* versions, the access tests would fail.
create table public.businesses (id uuid primary key default gen_random_uuid(), name text);
create table public.business_members (business_id uuid, user_id uuid, role text);
create function public.is_member(p uuid) returns boolean language sql as $$ select true $$;
create function public.member_role(p uuid) returns text language sql as $$ select 'owner' $$;
create function public.can_use_book(p uuid) returns boolean language sql as $$ select true $$;
create function public.can_approve_book(p uuid) returns boolean language sql as $$ select true $$;
create function public.can_see_document(p uuid) returns boolean language sql as $$ select true $$;
grant select on public.businesses, public.business_members to anon, authenticated;
grant execute on function public.is_member(uuid), public.member_role(uuid), public.can_use_book(uuid),
  public.can_approve_book(uuid), public.can_see_document(uuid) to anon, authenticated;
-- Fingertip's own private bucket (its files must stay invisible to the vault and vice versa).
insert into storage.buckets(id, name, public) values ('patient-vault', 'patient-vault', false);
