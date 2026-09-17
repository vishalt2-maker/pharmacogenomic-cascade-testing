-- =====================================================================
-- PCT 001_local_auth_shim.sql   ***LOCAL / SELF-HOSTED ONLY***
--
-- DO NOT APPLY THIS ON SUPABASE. Supabase already provides the `auth`
-- schema, `auth.users`, and `auth.uid()`. This file reproduces just enough
-- of that contract so the identical clinical DDL and the identical RLS
-- policies run unchanged against a plain PostgreSQL (or PGlite) instance.
--
-- Semantics deliberately mirror Supabase: auth.uid() reads the subject
-- claim from the current session's request context.
-- =====================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,
  created_at    timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid(): returns the authenticated subject, or NULL.
-- NULL is the fail-closed default -- an unset context authenticates as nobody,
-- and every RLS policy compares against it, so nobody sees anything.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase ships these roles. Create them locally so GRANTs and the
-- `to authenticated` clause in every policy resolve identically.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema auth to authenticated, anon, service_role;
grant usage on schema knowledge to authenticated, service_role;
grant usage on schema clinical to authenticated, service_role;
grant usage on schema registry to service_role;
