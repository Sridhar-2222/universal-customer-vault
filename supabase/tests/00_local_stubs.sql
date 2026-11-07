-- LOCAL TEST ONLY. Never run against a real Supabase project.
-- Minimal stand-ins for Supabase's auth and storage schemas plus tiny test helpers (t.*), so the migrations in
-- supabase/migrations can be applied to a throwaway local Postgres and checked with supabase/tests/*.sql.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;

create schema t;
grant usage on schema t to anon, authenticated;
create function t.ok(name text, cond boolean) returns text language sql as $$
  select case when cond then 'PASS ' else 'FAIL ' end || name $$;
create function t.fails(q text, expect text default null) returns boolean language plpgsql as $$
begin execute q; return false;
exception when others then return expect is null or sqlerrm like '%' || expect || '%'; end $$;
create function t.rows(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || q || ') s' into n; return n; end $$;
create function t.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  if uid is null then execute 'set role anon'; else execute 'set role authenticated'; end if;
end $$;
grant execute on all functions in schema t to anon, authenticated;
