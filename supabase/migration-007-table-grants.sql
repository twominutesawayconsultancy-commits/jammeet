-- ============================================================================
-- Jam-Meet — migration 007: explicit Data API table grants.
--
-- WHY: Until 2026-10-30, Supabase automatically granted the API roles
-- (anon / authenticated / service_role) privileges on every new table in the
-- `public` schema. From that date it stops doing so for NEWLY created tables.
-- Existing tables (including this live project's) keep their grants and are
-- unaffected. The exposure is a REBUILD of the schema — a new project, a
-- preview branch (Woodshed), or `supabase db reset` — which, run after the
-- cutoff, would create these tables WITHOUT API access, so PostgREST /
-- supabase-js would return "permission denied" even though RLS policies exist.
--
-- This migration writes those grants explicitly for every current app table so
-- a rebuild behaves exactly like production does today. Runs after 005/006, so
-- the Gigs tables exist by now. Row-level security stays the real access gate:
-- every policy is `to authenticated`, so `anon` gets table-level SELECT and no
-- rows. Guarded + idempotent: grants only tables that exist, and re-granting an
-- existing privilege is a no-op — safe to run repeatedly and on the live DB
-- (nothing changes for current users).
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','boards','memberships','songs','stems','practice','comments',
    'gigs','gig_answers','gig_songs','gig_notes'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant select on public.%I to anon', t);
      execute format('grant select, insert, update, delete on public.%I to authenticated', t);
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
end $$;

-- ============================================================================
-- Done. The same block is folded into schema.sql so a from-scratch rebuild
-- includes it. No change to the live database's behaviour.
-- ============================================================================
