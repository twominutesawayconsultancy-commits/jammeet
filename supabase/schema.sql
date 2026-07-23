-- ============================================================================
-- Jam-Meet — Supabase schema. IDEMPOTENT: safe to run repeatedly in the
-- SQL Editor (supabase.com/dashboard → your project → SQL Editor → Run).
--
-- Design notes (these pre-empt real failure modes):
--   * memberships.user_id / practice.user_id / comments.user_id reference
--     public.profiles(id) — NOT auth.users directly — so PostgREST can embed
--     joins like `comments(*, profiles(...))`. FKs only to auth.users cause
--     PGRST200 "could not find a relationship" errors.
--   * All RLS helper functions are SECURITY DEFINER, so policies on
--     memberships can consult memberships without infinite recursion.
--   * Every policy is `to authenticated` and uses `(select auth.uid())`
--     (initPlan-cached; also avoids per-row re-evaluation).
--   * claim_invites() lets a freshly-invited user pick up pending invites
--     on first login; invite_member() links already-registered users at once.
--   * A trigger caps admins at 2 per board.
--   * The `stems` storage bucket is private with a 50 MB per-file limit
--     (you must ALSO raise the project-wide upload limit in the dashboard:
--     Storage → Settings — the global default of 50 MB is fine, but on some
--     plans it defaults lower; see README).
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text unique,
  display_name text,
  instrument   text,
  color        text default '#3ec6c0',
  created_at   timestamptz not null default now()
);

create table if not exists public.boards (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  tagline    text,
  accent     text default '#3ec6c0',
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete cascade, -- null until invite is claimed
  email      text not null,
  role       text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  unique (board_id, email)
);

create table if not exists public.songs (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards(id) on delete cascade,
  title      text not null,
  key        text default 'C major',
  sig        text default '4/4',
  bpm        integer default 100 check (bpm between 20 and 400),
  created_at timestamptz not null default now()
);

create table if not exists public.stems (
  id           uuid primary key default gen_random_uuid(),
  song_id      uuid not null references public.songs(id) on delete cascade,
  name         text not null,
  source       text not null default 'upload' check (source in ('demo','upload')),
  storage_path text,
  sort         integer not null default 0,
  gain         real not null default 1,
  created_at   timestamptz not null default now()
);

create table if not exists public.practice (
  id         uuid primary key default gen_random_uuid(),
  song_id    uuid not null references public.songs(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  plays      integer not null default 0,
  confidence integer check (confidence between 1 and 10),
  updated_at timestamptz not null default now(),
  unique (song_id, user_id)
);

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  song_id    uuid not null references public.songs(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_memberships_board on public.memberships(board_id);
create index if not exists idx_memberships_user  on public.memberships(user_id);
create index if not exists idx_memberships_email on public.memberships(lower(email));
create index if not exists idx_songs_board       on public.songs(board_id);
create index if not exists idx_stems_song        on public.stems(song_id);
create index if not exists idx_practice_song     on public.practice(song_id);
create index if not exists idx_comments_song     on public.comments(song_id);

-- ============================================================================
-- 2. HELPER FUNCTIONS (SECURITY DEFINER — prevents RLS recursion)
-- ============================================================================

create or replace function public.is_member(b uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.board_id = b and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_admin(b uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.board_id = b and m.user_id = (select auth.uid())
      and m.role in ('owner','admin')
  );
$$;

create or replace function public.is_owner(b uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.board_id = b and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

create or replace function public.song_board(s uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select board_id from songs where id = s;
$$;

-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================

-- 3a. Auto-create the owner's membership when a board is created.
create or replace function public.handle_new_board()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into memberships (board_id, user_id, email, role)
  select new.id, new.owner_id, coalesce(p.email, ''), 'owner'
  from profiles p where p.id = new.owner_id
  on conflict (board_id, email) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_board on public.boards;
create trigger trg_handle_new_board
  after insert on public.boards
  for each row execute function public.handle_new_board();

-- 3b. Cap admins at 2 per board.
create or replace function public.enforce_admin_limit()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.role = 'admin' then
    if (select count(*) from memberships m
        where m.board_id = new.board_id and m.role = 'admin' and m.id <> new.id) >= 2 then
      raise exception 'A board can have at most 2 admins.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_admin_limit on public.memberships;
create trigger trg_enforce_admin_limit
  before insert or update on public.memberships
  for each row execute function public.enforce_admin_limit();

-- 3c. Create a profile row automatically on signup (belt) — the client also
--     upserts it on login (suspenders), per known failure mode #4.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- 4. RPCs
-- ============================================================================

-- Claim pending invites for the signed-in user (call on every login).
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
  return n;
end;
$$;

-- Owner-only invite. Links the profile immediately if the invitee already
-- has an account (otherwise claim_invites picks it up on their first login).
create or replace function public.invite_member(p_board uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  existing uuid;
begin
  if not public.is_owner(p_board) then
    raise exception 'Only the board owner can invite members.';
  end if;
  if p_role not in ('admin','member') then
    raise exception 'Role must be admin or member.';
  end if;
  select id into existing from profiles where lower(email) = lower(p_email) limit 1;
  insert into memberships (board_id, user_id, email, role)
  values (p_board, existing, lower(p_email), p_role)
  on conflict (board_id, email) do nothing;
  if not found then
    raise exception 'That email is already on this board.';
  end if;
end;
$$;

-- Count a rehearsal pass. Upserts the practice row so the first pass works.
create or replace function public.increment_play(p_song uuid)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  new_plays integer;
begin
  if not public.is_member(public.song_board(p_song)) then
    raise exception 'Not a member of this board.';
  end if;
  insert into practice (song_id, user_id, plays)
  values (p_song, (select auth.uid()), 1)
  on conflict (song_id, user_id)
  do update set plays = practice.plays + 1, updated_at = now()
  returning plays into new_plays;
  return new_plays;
end;
$$;

grant execute on function public.claim_invites()                  to authenticated;
grant execute on function public.invite_member(uuid, text, text)  to authenticated;
grant execute on function public.increment_play(uuid)             to authenticated;

-- ============================================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles    enable row level security;
alter table public.boards      enable row level security;
alter table public.memberships enable row level security;
alter table public.songs       enable row level security;
alter table public.stems       enable row level security;
alter table public.practice    enable row level security;
alter table public.comments    enable row level security;

-- ---- profiles ----
drop policy if exists "profiles select" on public.profiles;
create policy "profiles select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---- boards ----
drop policy if exists "boards select" on public.boards;
create policy "boards select" on public.boards
  for select to authenticated
  using (public.is_member(id) or owner_id = (select auth.uid()));

drop policy if exists "boards insert" on public.boards;
create policy "boards insert" on public.boards
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists "boards update" on public.boards;
create policy "boards update" on public.boards
  for update to authenticated
  using (public.is_owner(id)) with check (public.is_owner(id));

drop policy if exists "boards delete" on public.boards;
create policy "boards delete" on public.boards
  for delete to authenticated using (public.is_owner(id));

-- ---- memberships ----
drop policy if exists "memberships select" on public.memberships;
create policy "memberships select" on public.memberships
  for select to authenticated
  using (public.is_member(board_id) or user_id = (select auth.uid()));

drop policy if exists "memberships insert" on public.memberships;
create policy "memberships insert" on public.memberships
  for insert to authenticated
  with check (public.is_owner(board_id) and role in ('admin','member'));
  -- (the single 'owner' row is created by the handle_new_board trigger,
  --  which runs as definer and bypasses this policy)

drop policy if exists "memberships update" on public.memberships;
create policy "memberships update" on public.memberships
  for update to authenticated
  using (public.is_owner(board_id) and role <> 'owner')
  with check (public.is_owner(board_id) and role in ('admin','member'));

drop policy if exists "memberships delete" on public.memberships;
create policy "memberships delete" on public.memberships
  for delete to authenticated
  using (role <> 'owner'
         and (public.is_owner(board_id) or user_id = (select auth.uid())));

-- ---- songs ----
drop policy if exists "songs select" on public.songs;
create policy "songs select" on public.songs
  for select to authenticated using (public.is_member(board_id));

drop policy if exists "songs insert" on public.songs;
create policy "songs insert" on public.songs
  for insert to authenticated with check (public.is_admin(board_id));

drop policy if exists "songs update" on public.songs;
create policy "songs update" on public.songs
  for update to authenticated
  using (public.is_admin(board_id)) with check (public.is_admin(board_id));

drop policy if exists "songs delete" on public.songs;
create policy "songs delete" on public.songs
  for delete to authenticated using (public.is_owner(board_id));

-- ---- stems ----
drop policy if exists "stems select" on public.stems;
create policy "stems select" on public.stems
  for select to authenticated using (public.is_member(public.song_board(song_id)));

drop policy if exists "stems insert" on public.stems;
create policy "stems insert" on public.stems
  for insert to authenticated with check (public.is_admin(public.song_board(song_id)));

drop policy if exists "stems update" on public.stems;
create policy "stems update" on public.stems
  for update to authenticated
  using (public.is_admin(public.song_board(song_id)))
  with check (public.is_admin(public.song_board(song_id)));

drop policy if exists "stems delete" on public.stems;
create policy "stems delete" on public.stems
  for delete to authenticated using (public.is_admin(public.song_board(song_id)));

-- ---- practice ----
drop policy if exists "practice select" on public.practice;
create policy "practice select" on public.practice
  for select to authenticated using (public.is_member(public.song_board(song_id)));

drop policy if exists "practice insert" on public.practice;
create policy "practice insert" on public.practice
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and public.is_member(public.song_board(song_id)));

drop policy if exists "practice update" on public.practice;
create policy "practice update" on public.practice
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "practice delete" on public.practice;
create policy "practice delete" on public.practice
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---- comments ----
drop policy if exists "comments select" on public.comments;
create policy "comments select" on public.comments
  for select to authenticated using (public.is_member(public.song_board(song_id)));

drop policy if exists "comments insert" on public.comments;
create policy "comments insert" on public.comments
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and public.is_member(public.song_board(song_id)));

drop policy if exists "comments delete" on public.comments;
create policy "comments delete" on public.comments
  for delete to authenticated
  using (user_id = (select auth.uid())
         or public.is_owner(public.song_board(song_id)));

-- ============================================================================
-- 6. STORAGE — private `stems` bucket, path <boardId>/<songId>/<stemId>.<ext>
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('stems', 'stems', false, 52428800)  -- 50 MB per file
on conflict (id) do update
  set public = false, file_size_limit = 52428800;

-- Members can read; owner/admin can write. The first path segment is the
-- board id, so policies derive permissions from it.
drop policy if exists "stems storage read" on storage.objects;
create policy "stems storage read" on storage.objects
  for select to authenticated
  using (bucket_id = 'stems'
         and public.is_member(((storage.foldername(name))[1])::uuid));

drop policy if exists "stems storage insert" on storage.objects;
create policy "stems storage insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'stems'
              and public.is_admin(((storage.foldername(name))[1])::uuid));

drop policy if exists "stems storage update" on storage.objects;
create policy "stems storage update" on storage.objects
  for update to authenticated
  using (bucket_id = 'stems'
         and public.is_admin(((storage.foldername(name))[1])::uuid));

drop policy if exists "stems storage delete" on storage.objects;
create policy "stems storage delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'stems'
         and public.is_admin(((storage.foldername(name))[1])::uuid));

-- ============================================================================
-- Done. Next steps live in README.md (Google OAuth + URL Configuration —
-- do not skip the Redirect URLs `/**` wildcard, or sessions silently fail).
-- ============================================================================
