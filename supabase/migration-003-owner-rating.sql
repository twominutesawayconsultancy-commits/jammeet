-- ============================================================================
-- Jam-Meet — migration 003: board owner can rate on a musician's behalf.
-- IDEMPOTENT and ADDITIVE: safe to run repeatedly and while the app is live
-- (adds one nullable column and one new function; nothing existing changes).
--
--   * practice.rated_by — who set the current confidence score. The musician's
--     own id when they rated themselves; the owner's id when the owner rated
--     for them (the app shows a small "set by owner" tag in that case).
--   * rate_for_member() — owner-only. Sets a member's confidence for a song,
--     creating their practice row if they haven't played it yet.
-- ============================================================================

alter table public.practice
  add column if not exists rated_by uuid references public.profiles(id) on delete set null;

create or replace function public.rate_for_member(p_song uuid, p_user uuid, p_confidence integer)
returns void language plpgsql security definer set search_path = public
as $$
declare
  b uuid := public.song_board(p_song);
begin
  if b is null or not public.is_owner(b) then
    raise exception 'Only the board owner can rate on behalf of a member.';
  end if;
  if p_confidence is null or p_confidence not between 1 and 10 then
    raise exception 'Confidence must be between 1 and 10.';
  end if;
  if not exists (select 1 from memberships m where m.board_id = b and m.user_id = p_user) then
    raise exception 'That person is not a member of this board.';
  end if;

  insert into practice (song_id, user_id, plays, confidence, rated_by, updated_at)
  values (p_song, p_user, 0, p_confidence, (select auth.uid()), now())
  on conflict (song_id, user_id) do update
    set confidence = excluded.confidence,
        rated_by   = excluded.rated_by,
        updated_at = now();
end;
$$;

revoke all on function public.rate_for_member(uuid, uuid, integer) from public, anon;
grant execute on function public.rate_for_member(uuid, uuid, integer) to authenticated;
