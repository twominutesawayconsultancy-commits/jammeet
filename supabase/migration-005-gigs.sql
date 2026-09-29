-- ============================================================================
-- Jam-Meet — migration 005: gigs calendar, availability answers, setlists.
-- IDEMPOTENT and ADDITIVE: only new tables, one helper function and their
-- policies. Nothing existing changes, so it is safe while the app is live.
--
--   * gigs         — a show on a board's calendar (date, place, status, details).
--   * gig_answers  — APPEND-ONLY availability log: In / Maybe / Out, optional
--                    note, who set it and when. The latest row per person is
--                    their current answer; earlier rows are the history, so
--                    "I said the 3rd / no you said the 4th" is settled by the log.
--                    No update/delete policies exist, so history can't be rewritten.
--   * gig_songs    — the setlist: ordered songs from the SAME board.
--   * gig_notes    — per-gig notes thread (timings, dress, travel...).
-- Members read everything on their board. Owner/admins create and edit gigs
-- and setlists, and may record an answer on a member's behalf (set_by shows it).
-- ============================================================================

create table if not exists public.gigs (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards(id) on delete cascade,
  gig_date   date not null,
  title      text not null,
  venue      text,
  status     text not null default 'tentative'
             check (status in ('tentative','confirmed','cancelled')),
  details    text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gig_answers (
  id         uuid primary key default gen_random_uuid(),
  gig_id     uuid not null references public.gigs(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  answer     text not null check (answer in ('in','maybe','out')),
  note       text check (note is null or length(note) <= 300),
  set_by     uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.gig_songs (
  gig_id   uuid not null references public.gigs(id) on delete cascade,
  song_id  uuid not null references public.songs(id) on delete cascade,
  position integer not null default 0,
  primary key (gig_id, song_id)
);

create table if not exists public.gig_notes (
  id         uuid primary key default gen_random_uuid(),
  gig_id     uuid not null references public.gigs(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_gigs_board_date   on public.gigs(board_id, gig_date);
create index if not exists idx_gig_answers_gig   on public.gig_answers(gig_id, created_at);
create index if not exists idx_gig_songs_gig     on public.gig_songs(gig_id);
create index if not exists idx_gig_notes_gig     on public.gig_notes(gig_id);

-- Board of a gig (SECURITY DEFINER, like song_board, to avoid RLS recursion).
create or replace function public.gig_board(g uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select board_id from gigs where id = g; $$;

revoke all on function public.gig_board(uuid) from public, anon;
grant execute on function public.gig_board(uuid) to authenticated;

alter table public.gigs        enable row level security;
alter table public.gig_answers enable row level security;
alter table public.gig_songs   enable row level security;
alter table public.gig_notes   enable row level security;

-- ---- gigs: members read; owner + admins write ----
drop policy if exists "gigs select" on public.gigs;
create policy "gigs select" on public.gigs
  for select to authenticated using (public.is_member(board_id));
drop policy if exists "gigs insert" on public.gigs;
create policy "gigs insert" on public.gigs
  for insert to authenticated
  with check (public.is_admin(board_id) and created_by = (select auth.uid()));
drop policy if exists "gigs update" on public.gigs;
create policy "gigs update" on public.gigs
  for update to authenticated
  using (public.is_admin(board_id)) with check (public.is_admin(board_id));
drop policy if exists "gigs delete" on public.gigs;
create policy "gigs delete" on public.gigs
  for delete to authenticated using (public.is_admin(board_id));

-- ---- gig_answers: append-only log ----
drop policy if exists "gig_answers select" on public.gig_answers;
create policy "gig_answers select" on public.gig_answers
  for select to authenticated using (public.is_member(public.gig_board(gig_id)));
drop policy if exists "gig_answers insert" on public.gig_answers;
create policy "gig_answers insert" on public.gig_answers
  for insert to authenticated
  with check (
    set_by = (select auth.uid())
    and exists (select 1 from memberships m
                where m.board_id = public.gig_board(gig_id) and m.user_id = gig_answers.user_id)
    and (user_id = (select auth.uid()) or public.is_admin(public.gig_board(gig_id)))
  );
-- (no update / delete policies on purpose)

-- ---- gig_songs: members read; owner + admins write; same-board songs only ----
drop policy if exists "gig_songs select" on public.gig_songs;
create policy "gig_songs select" on public.gig_songs
  for select to authenticated using (public.is_member(public.gig_board(gig_id)));
drop policy if exists "gig_songs insert" on public.gig_songs;
create policy "gig_songs insert" on public.gig_songs
  for insert to authenticated
  with check (public.is_admin(public.gig_board(gig_id))
              and public.song_board(song_id) = public.gig_board(gig_id));
drop policy if exists "gig_songs update" on public.gig_songs;
create policy "gig_songs update" on public.gig_songs
  for update to authenticated
  using (public.is_admin(public.gig_board(gig_id)))
  with check (public.is_admin(public.gig_board(gig_id))
              and public.song_board(song_id) = public.gig_board(gig_id));
drop policy if exists "gig_songs delete" on public.gig_songs;
create policy "gig_songs delete" on public.gig_songs
  for delete to authenticated using (public.is_admin(public.gig_board(gig_id)));

-- ---- gig_notes: members read + write their own; author or owner/admin deletes ----
drop policy if exists "gig_notes select" on public.gig_notes;
create policy "gig_notes select" on public.gig_notes
  for select to authenticated using (public.is_member(public.gig_board(gig_id)));
drop policy if exists "gig_notes insert" on public.gig_notes;
create policy "gig_notes insert" on public.gig_notes
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_member(public.gig_board(gig_id)));
drop policy if exists "gig_notes delete" on public.gig_notes;
create policy "gig_notes delete" on public.gig_notes
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin(public.gig_board(gig_id)));
