-- ============================================================================
-- Jam-Meet — migration 002: profile reconcile (auth id-drift fix).
-- IDEMPOTENT and ADDITIVE: safe to run repeatedly, and safe to run while the
-- current app is live (today's code never calls reconcile_profile, and the
-- trigger change only matters for brand-new sign-ups).
--
-- Problem: if Google/Supabase issues a NEW auth id for an email that already
-- has a profile (e.g. after the OAuth provider was reconfigured):
--   1. handle_new_user's `on conflict (id)` doesn't cover the unique EMAIL, so
--      the trigger raised and Google sign-up itself failed.
--   2. The client's upsert-on-id hit the same unique-email error, leaving the
--      user signed in but with no profile ("owns nothing").
--
-- Fix:
--   1. handle_new_user ignores ANY unique conflict; the client reconciles.
--   2. reconcile_profile() — called by the client on every sign-in — moves the
--      old profile's boards, memberships, practice and comments to the new id.
--      It only ever acts on the CALLER's own identity (auth.uid() and the email
--      stored in auth.users); client-supplied id/email are never trusted.
--   3. Normal sign-ins no longer overwrite a user's edited stage name.
-- ============================================================================

-- 1. Sign-up trigger: never abort auth sign-up over a profile conflict.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict do nothing; -- id OR email; reconcile_profile() fixes drift on login
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Reconcile the caller's profile. Signature matches the client call:
--    rpc('reconcile_profile', { p_id, p_email, p_display, p_color }).
create or replace function public.reconcile_profile(
  p_id uuid, p_email text, p_display text default null, p_color text default null)
returns void language plpgsql security definer set search_path = public
as $$
declare
  me       uuid := (select auth.uid());
  my_email text;
  old      public.profiles%rowtype;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;
  if p_id is distinct from me then
    raise exception 'Profile id does not match the signed-in user.';
  end if;

  -- Trust the auth record, not the client, for the email.
  select u.email into my_email from auth.users u where u.id = me;

  if my_email is not null then
    select * into old from profiles
     where lower(email) = lower(my_email) and id <> me
     limit 1;
  end if;

  if old.id is not null then
    -- Id drift: free the email, carry the old identity over to the new id.
    update profiles set email = null where id = old.id;

    insert into profiles (id, email, display_name, instrument, color, created_at)
    values (me, my_email, old.display_name, old.instrument, old.color, old.created_at)
    on conflict (id) do update
      set email        = excluded.email,
          display_name = excluded.display_name,
          instrument   = excluded.instrument,
          color        = excluded.color,
          created_at   = excluded.created_at;

    update boards      set owner_id = me where owner_id = old.id;
    update memberships set user_id  = me where user_id  = old.id;
    update comments    set user_id  = me where user_id  = old.id;

    -- practice is unique per (song, user): merge rows both ids have, move the rest.
    update practice n
       set plays      = n.plays + o.plays,
           confidence = coalesce(n.confidence, o.confidence),
           updated_at = greatest(n.updated_at, o.updated_at)
      from practice o
     where o.user_id = old.id and n.user_id = me and n.song_id = o.song_id;
    delete from practice o
     where o.user_id = old.id
       and exists (select 1 from practice n where n.user_id = me and n.song_id = o.song_id);
    update practice set user_id = me where user_id = old.id;

    delete from profiles where id = old.id;
  end if;

  -- Normal path: create the profile if missing; keep an edited stage name.
  insert into profiles (id, email, display_name, color)
  values (me, my_email,
          coalesce(nullif(trim(p_display), ''), split_part(coalesce(my_email, ''), '@', 1)),
          coalesce(p_color, '#3ec6c0'))
  on conflict (id) do update set email = excluded.email;
end;
$$;

revoke all on function public.reconcile_profile(uuid, text, text, text) from public, anon;
grant execute on function public.reconcile_profile(uuid, text, text, text) to authenticated;
