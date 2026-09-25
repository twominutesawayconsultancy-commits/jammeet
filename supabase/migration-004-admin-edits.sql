-- ============================================================================
-- Jam-Meet — migration 004: owner AND admins can fix mistakes.
-- IDEMPOTENT. Safe while the app is live: it only widens who may do an edit
-- (owner → owner + admins) and adds one nullable column and one function.
--
--   * Boards: admins may now edit name / tagline / accent (deleting a board
--     stays owner-only).
--   * Comments: owner and admins may delete ANY note on their board (was owner
--     only); anyone may edit their own note, and owner/admins may edit any note
--     on their board, via edit_comment(). comments.edited_at marks edits.
--   * Songs (title, key, time sig, BPM) were already editable by owner + admins.
-- ============================================================================

-- ---- boards: owner + admins can edit ----
drop policy if exists "boards update" on public.boards;
create policy "boards update" on public.boards
  for update to authenticated
  using (public.is_admin(id)) with check (public.is_admin(id));

-- ---- comments: owner + admins can delete any note on their board ----
drop policy if exists "comments delete" on public.comments;
create policy "comments delete" on public.comments
  for delete to authenticated
  using (user_id = (select auth.uid())
         or public.is_admin(public.song_board(song_id)));

-- ---- comments: editing (body only, through a function so nobody can move a
--      note to another song or re-attribute it to someone else) ----
alter table public.comments add column if not exists edited_at timestamptz;

create or replace function public.edit_comment(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select id, user_id, song_id into c from comments where id = p_id;
  if c.id is null then
    raise exception 'That note no longer exists.';
  end if;
  if c.user_id is distinct from (select auth.uid())
     and not public.is_admin(public.song_board(c.song_id)) then
    raise exception 'Only the author, the owner or an admin can edit this note.';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'A note can''t be empty.';
  end if;
  update comments set body = trim(p_body), edited_at = now() where id = p_id;
end;
$$;

revoke all on function public.edit_comment(uuid, text) from public, anon;
grant execute on function public.edit_comment(uuid, text) to authenticated;
