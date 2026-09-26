// api.js — all Supabase reads/writes in one place so App.jsx stays UI-focused.
import { supabase } from '../supabaseClient'

const PALETTE = ['#3ec6c0', '#f2a33c', '#ff6b4a', '#8b7cf6', '#7cc36a', '#e2c04b']

function throwIf(error) {
  if (error) throw new Error(error.message || String(error))
}

/* ---------------- auth + profile ---------------- */

export async function signInGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  throwIf(error)
}

export async function signOut() {
  await supabase.auth.signOut()
}

/**
 * Called on every sign-in. Reconciles the profile row AND claims any pending
 * invites that match the user's email (via the claim_invites RPC). Without
 * this, a freshly-invited user is logged in but "owns nothing".
 */
export async function ensureProfile(user) {
  const display =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    (user.email || '').split('@')[0]
  const color = PALETTE[Math.abs(hashCode(user.id)) % PALETTE.length]

  // Reconcile via RPC (supabase/migration-002-profile-reconcile.sql) rather than
  // a plain upsert: it keeps a user's edited stage name, and if Google issues a
  // new auth id for an existing email it moves that user's boards, memberships,
  // ratings and comments over. The server trusts auth.uid(), not these args.
  const { error } = await supabase.rpc('reconcile_profile', {
    p_id: user.id,
    p_email: user.email,
    p_display: display,
    p_color: color,
  })
  throwIf(error)

  const { error: e2 } = await supabase.rpc('claim_invites')
  throwIf(e2)

  const { data, error: e3 } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  throwIf(e3)
  return data
}

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export async function updateProfile(userId, patch) {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select()
    .single()
  throwIf(error)
  return data
}

/* ---------------- boards ---------------- */

export async function fetchMyBoards(userId) {
  const { data, error } = await supabase
    .from('memberships')
    .select('role, boards(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  throwIf(error)
  return (data || [])
    .filter((m) => m.boards)
    .map((m) => ({ role: m.role, board: m.boards }))
}

export async function createBoard({ name, tagline, accent }) {
  const { data: userData } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('boards')
    .insert({ name, tagline, accent, owner_id: userData.user.id })
    .select()
    .single()
  throwIf(error)
  // owner membership is created by a DB trigger (handle_new_board)
  return data
}

/** Owner or admin: fix the board's name / tagline / accent (RLS: migration-004). */
export async function updateBoard(boardId, patch) {
  const { data, error } = await supabase
    .from('boards')
    .update(patch)
    .eq('id', boardId)
    .select()
    .single()
  throwIf(error)
  return data
}

/**
 * Remove every stem file under a storage folder: `<boardId>` (two levels deep)
 * or `<boardId>/<songId>`. Best-effort — storage cleanup never blocks the delete
 * the user asked for — but without it deleted songs leave their audio behind.
 */
async function removeStemFolder(prefix) {
  try {
    const bucket = supabase.storage.from('stems')
    const paths = []
    const walk = async (dir, depth) => {
      const { data, error } = await bucket.list(dir, { limit: 1000 })
      if (error || !data) return
      for (const item of data) {
        const full = `${dir}/${item.name}`
        if (item.id) paths.push(full) // a file
        else if (depth > 0) await walk(full, depth - 1) // a folder
      }
    }
    await walk(prefix, prefix.includes('/') ? 0 : 1)
    for (let i = 0; i < paths.length; i += 100) await bucket.remove(paths.slice(i, i + 100))
  } catch { /* best-effort */ }
}

export async function deleteBoard(boardId) {
  // Files first: once the board row is gone, nobody passes the storage policy.
  await removeStemFolder(boardId)
  const { error } = await supabase.from('boards').delete().eq('id', boardId)
  throwIf(error)
}

export async function fetchBoardBundle(boardId) {
  const [b, m, s] = await Promise.all([
    supabase.from('boards').select('*').eq('id', boardId).single(),
    supabase
      .from('memberships')
      .select('*, profiles(display_name, instrument, color, email)')
      .eq('board_id', boardId)
      .order('created_at', { ascending: true }),
    supabase
      .from('songs')
      .select('*, stems(*), practice(*), comments(count)')
      .eq('board_id', boardId)
      .order('created_at', { ascending: true }),
  ])
  throwIf(b.error)
  throwIf(m.error)
  throwIf(s.error)
  const songs = (s.data || []).map((song) => ({
    ...song,
    stems: (song.stems || []).sort((a, z) => a.sort - z.sort || a.name.localeCompare(z.name)),
    commentCount: song.comments?.[0]?.count ?? 0,
  }))
  return { board: b.data, members: m.data || [], songs }
}

/* ---------------- memberships ---------------- */

export async function inviteMember(boardId, email, role) {
  const { error } = await supabase.rpc('invite_member', {
    p_board: boardId,
    p_email: email.trim().toLowerCase(),
    p_role: role,
  })
  throwIf(error)
}

export async function setMemberRole(membershipId, role) {
  const { error } = await supabase
    .from('memberships')
    .update({ role })
    .eq('id', membershipId)
  throwIf(error)
}

export async function removeMember(membershipId) {
  const { error } = await supabase.from('memberships').delete().eq('id', membershipId)
  throwIf(error)
}

/* ---------------- songs ---------------- */

export async function addSong(boardId, { title, key, sig, bpm }) {
  const { data, error } = await supabase
    .from('songs')
    .insert({ board_id: boardId, title, key, sig, bpm })
    .select()
    .single()
  throwIf(error)
  return data
}

export async function updateSong(songId, patch) {
  const { error } = await supabase.from('songs').update(patch).eq('id', songId)
  throwIf(error)
}

export async function deleteSong(songId, boardId) {
  const { error } = await supabase.from('songs').delete().eq('id', songId)
  throwIf(error)
  // Row first (so a refused delete keeps its audio), then the song's files.
  if (boardId) await removeStemFolder(`${boardId}/${songId}`)
}

/* ---------------- stems + storage ---------------- */

export async function addStem(songId, { name, source, sort, gain = 1 }) {
  const { data, error } = await supabase
    .from('stems')
    .insert({ song_id: songId, name, source, sort, gain })
    .select()
    .single()
  throwIf(error)
  return data
}

function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename)
  return m ? m[1].toLowerCase() : 'bin'
}

/** Upload a stem's audio and stamp storage_path on the row. */
export async function uploadStemFile(boardId, songId, stemId, file) {
  // The revision suffix means replacing a stem always produces a NEW path.
  // Devices cache stems by path, so every member picks up replaced audio
  // automatically instead of playing a stale cached copy.
  const rev = Date.now().toString(36)
  const path = `${boardId}/${songId}/${stemId}-${rev}.${extOf(file.name)}`
  const { error } = await supabase.storage.from('stems').upload(path, file, {
    upsert: true,
    contentType: file.type || 'application/octet-stream',
  })
  throwIf(error)
  const { error: e2 } = await supabase
    .from('stems')
    .update({ storage_path: path, source: 'upload' })
    .eq('id', stemId)
  throwIf(e2)
  return path
}

/**
 * Swap a stem's audio safely: upload the new file and point the row at it
 * FIRST, and only then delete the old file — a failed upload leaves the
 * track playing its old audio instead of pointing at nothing.
 */
export async function replaceStemAudio(boardId, songId, stem, file) {
  const path = await uploadStemFile(boardId, songId, stem.id, file)
  if (stem.storage_path && stem.storage_path !== path) {
    await supabase.storage.from('stems').remove([stem.storage_path]) // best-effort
  }
  return path
}

export async function renameStem(stemId, name) {
  const { error } = await supabase.from('stems').update({ name }).eq('id', stemId)
  throwIf(error)
}

export async function removeStem(stem) {
  if (stem.storage_path) {
    // best-effort: don't block row deletion on storage cleanup
    await supabase.storage.from('stems').remove([stem.storage_path])
  }
  const { error } = await supabase.from('stems').delete().eq('id', stem.id)
  throwIf(error)
}

export async function stemSignedUrl(path) {
  const { data, error } = await supabase.storage.from('stems').createSignedUrl(path, 3600)
  throwIf(error)
  return data.signedUrl
}

export async function fetchStemArrayBuffer(path) {
  const url = await stemSignedUrl(path)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download stem audio (${res.status})`)
  return res.arrayBuffer()
}

/* ---------------- practice + comments ---------------- */

export async function logPlay(songId) {
  const { data, error } = await supabase.rpc('increment_play', { p_song: songId })
  throwIf(error)
  return data // new play count
}

export async function rateSong(songId, userId, confidence) {
  const { error } = await supabase
    .from('practice')
    // rated_by = self clears any "set by owner" tag (migration-003).
    .update({ confidence, rated_by: userId, updated_at: new Date().toISOString() })
    .eq('song_id', songId)
    .eq('user_id', userId)
  throwIf(error)
}

/** Owner only: set a member's confidence for them (checked server-side). */
export async function rateForMember(songId, userId, confidence) {
  const { error } = await supabase.rpc('rate_for_member', {
    p_song: songId,
    p_user: userId,
    p_confidence: confidence,
  })
  throwIf(error)
}

export async function fetchComments(songId) {
  const { data, error } = await supabase
    .from('comments')
    .select('*, profiles(display_name, color, instrument)')
    .eq('song_id', songId)
    .order('created_at', { ascending: true })
  throwIf(error)
  return data || []
}

export async function addComment(songId, userId, body) {
  const { error } = await supabase
    .from('comments')
    .insert({ song_id: songId, user_id: userId, body })
  throwIf(error)
}

/** Author, owner or admin: change a note's text (edit_comment RPC, migration-004). */
export async function editComment(id, body) {
  const { error } = await supabase.rpc('edit_comment', { p_id: id, p_body: body })
  throwIf(error)
}

export async function deleteComment(id) {
  const { error } = await supabase.from('comments').delete().eq('id', id)
  throwIf(error)
}
