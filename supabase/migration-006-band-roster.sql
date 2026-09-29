-- ============================================================================
-- Jam-Meet — migration 006: band roster without accounts + chat-era answers.
-- Requires migration-005. IDEMPOTENT and ADDITIVE: new columns, functions and
-- a trigger; one policy is replaced. Existing rows keep working.
--
--   * Band people without accounts: a memberships row with user_id null (like
--     an invite) plus a display_name. If their email isn't known yet it gets a
--     placeholder '<slug>-<6 hex>@no-email.invalid' (the .invalid TLD can never
--     be a real address). Owner/admins can fix the name/email later; when the
--     person signs in with that Google email, claim_invites() links the row and
--     all their gig history comes with it.
--   * gig_answers now point at the membership (membership_id), so people
--     without accounts can have answers. user_id is kept (filled when known).
--   * source 'app' | 'chat': chat answers are imported from a WhatsApp export
--     (owner/admins only) and carry said_at = when it was said in the chat.
--     App answers always get said_at = now() (set by trigger; can't backdate).
--   * person_name snapshots the name at insert, so history survives a member
--     leaving the board (membership_id then becomes null).
-- ============================================================================

alter table public.memberships add column if not exists display_name text;

alter table public.gig_answers add column if not exists membership_id uuid
  references public.memberships(id) on delete set null;
alter table public.gig_answers add column if not exists source text not null default 'app';
alter table public.gig_answers add column if not exists said_at timestamptz not null default now();
alter table public.gig_answers add column if not exists person_name text;
alter table public.gig_answers alter column user_id drop not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gig_answers_source_check') then
    alter table public.gig_answers
      add constraint gig_answers_source_check check (source in ('app','chat'));
  end if;
end $$;

create index if not exists idx_gig_answers_membership on public.gig_answers(membership_id);

-- Backfill rows written before this migration (app answers keyed by user_id).
update public.gig_answers a
   set membership_id = m.id
  from public.gigs g, public.memberships m
 where a.membership_id is null and g.id = a.gig_id
   and m.board_id = g.board_id and m.user_id = a.user_id;
update public.gig_answers a
   set person_name = coalesce(p.display_name, m.display_name)
  from public.memberships m left join public.profiles p on p.id = m.user_id
 where a.person_name is null and m.id = a.membership_id;
update public.gig_answers set said_at = created_at
 where source = 'app' and said_at <> created_at;

-- ---- fill + validate every new answer ----
create or replace function public.gig_answer_fill()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  mem memberships%rowtype;
begin
  if new.membership_id is null and new.user_id is not null then
    select * into mem from memberships
     where board_id = gig_board(new.gig_id) and user_id = new.user_id;
  else
    select * into mem from memberships where id = new.membership_id;
  end if;
  if mem.id is null or mem.board_id <> gig_board(new.gig_id) then
    raise exception 'That person is not on this board.';
  end if;
  new.membership_id := mem.id;
  new.user_id := mem.user_id;
  new.person_name := coalesce(
    (select display_name from profiles where id = mem.user_id), mem.display_name,
    split_part(mem.email, '@', 1));
  new.created_at := now();
  if new.source = 'app' then new.said_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists trg_gig_answer_fill on public.gig_answers;
create trigger trg_gig_answer_fill
  before insert on public.gig_answers
  for each row execute function public.gig_answer_fill();

-- ---- replace the insert policy (checked after the trigger has filled the row) ----
drop policy if exists "gig_answers insert" on public.gig_answers;
create policy "gig_answers insert" on public.gig_answers
  for insert to authenticated
  with check (
    set_by = (select auth.uid())
    and exists (
      select 1 from memberships m
       where m.id = gig_answers.membership_id
         and m.board_id = public.gig_board(gig_id)
         and (m.user_id = (select auth.uid()) or public.is_admin(m.board_id))
    )
    and (source = 'app' or public.is_admin(public.gig_board(gig_id)))
  );
-- (still no update / delete policies: the log is append-only)

-- ---- band people: owner + admins add and edit ----
create or replace function public.placeholder_email(p_name text)
returns text language sql volatile set search_path = public
as $$
  select coalesce(nullif(trim(both '-' from regexp_replace(lower(coalesce(p_name,'')), '[^a-z0-9]+', '-', 'g')), ''), 'member')
         || '-' || substr(md5(gen_random_uuid()::text), 1, 6) || '@no-email.invalid';
$$;

-- Add someone to the band. Email optional (placeholder if blank).
-- Owner may add admins; admins may add members only. Returns the membership id.
create or replace function public.add_band_person(p_board uuid, p_name text, p_email text, p_role text default 'member')
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  em text := lower(nullif(trim(coalesce(p_email, '')), ''));
  nm text := nullif(trim(coalesce(p_name, '')), '');
  existing uuid;
  new_id uuid;
begin
  if not public.is_admin(p_board) then
    raise exception 'Only the owner or an admin can add band members.';
  end if;
  if p_role not in ('admin','member') then raise exception 'Role must be admin or member.'; end if;
  if p_role = 'admin' and not public.is_owner(p_board) then
    raise exception 'Only the owner can add admins.';
  end if;
  if em is null and nm is null then raise exception 'Give a name or an email.'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right.'; end if;
  if em is null then em := public.placeholder_email(nm); end if;
  select id into existing from profiles where lower(email) = em limit 1;
  insert into memberships (board_id, user_id, email, role, display_name)
  values (p_board, existing, em, p_role, nm)
  on conflict (board_id, email) do nothing
  returning id into new_id;
  if new_id is null then raise exception 'That email is already on this board.'; end if;
  return new_id;
end;
$$;

-- Fix the name and/or email of someone who hasn't signed in yet.
-- A blank email keeps (or creates) a placeholder. If the email belongs to an
-- existing account, the row is linked at once.
create or replace function public.update_band_person(p_membership uuid, p_name text, p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  mem memberships%rowtype;
  em text := lower(nullif(trim(coalesce(p_email, '')), ''));
  nm text := nullif(trim(coalesce(p_name, '')), '');
  existing uuid;
begin
  select * into mem from memberships where id = p_membership;
  if mem.id is null or not public.is_admin(mem.board_id) then
    raise exception 'Only the owner or an admin can edit band members.';
  end if;
  if mem.user_id is not null then
    raise exception 'This person has already joined; they manage their own name.';
  end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right.'; end if;
  if em is null then
    em := case when mem.email like '%@no-email.invalid' then mem.email
               else public.placeholder_email(coalesce(nm, mem.display_name)) end;
  end if;
  if exists (select 1 from memberships where board_id = mem.board_id and lower(email) = em and id <> mem.id) then
    raise exception 'That email is already on this board.';
  end if;
  select id into existing from profiles where lower(email) = em limit 1;
  if existing is not null and exists (select 1 from memberships where board_id = mem.board_id and user_id = existing) then
    raise exception 'That person has already joined this board under another entry.';
  end if;
  update memberships
     set display_name = coalesce(nm, display_name), email = em, user_id = existing
   where id = mem.id;
  update gig_answers set user_id = existing where membership_id = mem.id and existing is not null;
end;
$$;

-- When an invite is claimed, give that person's earlier (chat) answers their user_id.
create or replace function public.claim_invites()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  my_email text;
  n integer;
begin
  select email into my_email from profiles where id = (select auth.uid());
  if my_email is null then return 0; end if;
  update memberships
     set user_id = (select auth.uid())
   where user_id is null and lower(email) = lower(my_email);
  get diagnostics n = row_count;
  update gig_answers a set user_id = (select auth.uid())
    from memberships m
   where a.membership_id = m.id and a.user_id is null and m.user_id = (select auth.uid());
  return n;
end;
$$;

revoke all on function public.gig_answer_fill() from public, anon, authenticated;
revoke all on function public.placeholder_email(text) from public, anon;
revoke all on function public.add_band_person(uuid, text, text, text) from public, anon;
revoke all on function public.update_band_person(uuid, text, text) from public, anon;
grant execute on function public.add_band_person(uuid, text, text, text) to authenticated;
grant execute on function public.update_band_person(uuid, text, text) to authenticated;
grant execute on function public.claim_invites() to authenticated;
