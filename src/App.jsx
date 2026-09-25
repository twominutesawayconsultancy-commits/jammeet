// App.jsx — Jam-Meet: async remote rehearsal room for bands.
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { supabase } from './supabaseClient'
import * as api from './lib/api'
import {
  Mixer, synthDemoStems, decodeAudio, formatTime, DEMO_TRACK_NAMES,
} from './lib/audio'
import * as cache from './lib/cache'
import {
  Play, Pause, Square, Repeat, Plus, X, Trash2, Users, LogOut, Upload,
  ChevronLeft, Crown, Shield, MessageSquare, Music2, FolderOpen, Pencil,
  Check, RefreshCw, Timer, Sparkles, Send, UserPlus, SlidersHorizontal,
} from 'lucide-react'

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */

const KEY_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const SIGS = ['4/4', '3/4', '6/8', '2/4', '5/4', '7/8']

const LANES = [
  { id: 'unrehearsed', label: 'Unrehearsed', hint: 'no ratings yet', tone: 'slate' },
  { id: 'woodshedding', label: 'Woodshedding', hint: 'avg below 4', tone: 'amber' },
  { id: 'tightening', label: 'Tightening up', hint: 'avg 4 – 7', tone: 'lime' },
  { id: 'showready', label: 'Show-ready', hint: 'avg 7 and up', tone: 'green' },
]

/**
 * Band readiness = average over EVERY joined member; anyone who hasn't rated
 * yet counts as 0, so one bandmate's 8 can't make the whole song look ready.
 */
function songReadiness(song, members) {
  const joined = new Set(members.filter((m) => m.user_id).map((m) => m.user_id))
  const ratings = (song.practice || []).filter((p) => p.confidence != null && joined.has(p.user_id))
  const total = joined.size
  if (ratings.length === 0) return { lane: 'unrehearsed', avg: null, count: 0, total }
  const avg = ratings.reduce((s, p) => s + p.confidence, 0) / Math.max(total, 1)
  const lane = avg < 4 ? 'woodshedding' : avg < 7 ? 'tightening' : 'showready'
  return { lane, avg, count: ratings.length, total }
}

/** Pass counts at which we ask "how confident are you now?": 3, 6, 9, 15, 20, 25… */
function isRatingMilestone(plays) {
  return plays === 3 || plays === 6 || plays === 9 || (plays >= 15 && plays % 5 === 0)
}

/** True when the board owner set this confidence on the musician's behalf. */
const ratedByOwner = (p) => !!(p?.rated_by && p.rated_by !== p.user_id)

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|flac|aif|aiff|webm)$/i
const isAudioFile = (f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name)

/** "03 - Bass DI.wav" -> "Bass DI" */
function cleanTrackName(filename) {
  const base = filename.replace(/\.[^.]+$/, '')
  const stripped = base.replace(/^\s*\d+\s*[-_.)\]]*\s*/, '').trim()
  return stripped || base
}

/** Walk a drop payload; supports whole-folder drops via webkitGetAsEntry. */
async function filesFromDataTransfer(dt) {
  const out = []
  const walk = async (entry) => {
    if (!entry) return
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej))
      if (isAudioFile(f)) out.push(f)
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      let batch
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        for (const e of batch) await walk(e)
      } while (batch.length > 0)
    }
  }
  const items = dt.items ? [...dt.items] : []
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
  if (entries.some(Boolean)) {
    for (const e of entries) await walk(e)
  } else {
    for (const f of [...(dt.files || [])]) if (isAudioFile(f)) out.push(f)
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return out
}

function initials(name = '?') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('')
}

function roleBadge(role) {
  if (role === 'owner') return <span className="badge badge-owner"><Crown size={11} /> owner</span>
  if (role === 'admin') return <span className="badge badge-admin"><Shield size={11} /> admin</span>
  return <span className="badge badge-member">member</span>
}

/* ================================================================== */
/* Root                                                                */
/* ================================================================== */

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [booting, setBooting] = useState(true)
  const [profileError, setProfileError] = useState(null)
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [route, setRoute] = useState({ name: 'home' })
  const [toasts, setToasts] = useState([])

  const notify = useCallback((msg, kind = 'error') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, msg, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200)
  }, [])

  useEffect(() => {
    if (!supabase) { setBooting(false); return }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setBooting(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let alive = true
    setProfileError(null)
    if (session?.user) {
      api.ensureProfile(session.user)
        .then((p) => { if (alive) setProfile(p) })
        .catch((e) => { if (alive) setProfileError(e.message) })
    } else {
      setProfile(null)
      setRoute({ name: 'home' })
    }
    return () => { alive = false }
  }, [session?.user?.id, profileAttempt]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!supabase) return <SetupScreen />
  if (booting) return <FullBleed><div className="boot-pulse">warming up the room…</div></FullBleed>
  if (!session) return <AuthGate toasts={toasts} />
  if (!profile && profileError) {
    return (
      <ProfileErrorScreen
        message={profileError}
        onRetry={() => setProfileAttempt((n) => n + 1)}
      />
    )
  }

  return (
    <div className="app">
      <Header
        profile={profile}
        onHome={() => setRoute({ name: 'home' })}
        notify={notify}
        onProfileSaved={setProfile}
      />
      {route.name === 'home' && (
        <BoardsHome
          profile={profile}
          notify={notify}
          onOpen={(boardId) => setRoute({ name: 'board', boardId })}
        />
      )}
      {route.name === 'board' && (
        <BoardView
          key={route.boardId}
          boardId={route.boardId}
          songId={route.songId || null}
          profile={profile}
          notify={notify}
          onBack={() => setRoute({ name: 'home' })}
          onOpenSong={(songId) => setRoute({ ...route, songId })}
          onCloseSong={() => setRoute({ name: 'board', boardId: route.boardId })}
        />
      )}
      <Toasts toasts={toasts} />
    </div>
  )
}

function Toasts({ toasts }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
      ))}
    </div>
  )
}

function FullBleed({ children }) {
  return <div className="fullbleed">{children}</div>
}

/* ================================================================== */
/* Setup + Auth                                                        */
/* ================================================================== */

function SetupScreen() {
  return (
    <FullBleed>
      <div className="setup-card">
        <Wordmark />
        <h2>Almost wired up</h2>
        <p>
          The app can't find its Supabase connection. Add these two environment
          variables (in Vercel: Project → Settings → Environment Variables, then
          redeploy; locally: an <code>.env</code> file):
        </p>
        <pre>{`VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...`}</pre>
        <p className="dim">
          Both values live in the Supabase <em>dashboard</em> under Project
          Settings → API. Full walkthrough in the README.
        </p>
      </div>
    </FullBleed>
  )
}

function Wordmark({ small }) {
  return (
    <div className={small ? 'wordmark wordmark-sm' : 'wordmark'}>
      <span className="wm-bars" aria-hidden="true"><i /><i /><i /></span>
      JAM<span className="wm-dot">·</span>MEET
    </div>
  )
}

function AuthGate({ toasts }) {
  const [busy, setBusy] = useState(false)
  return (
    <FullBleed>
      <div className="auth-card">
        <Wordmark />
        <p className="auth-tag">The rehearsal happens whenever you do.</p>
        <p className="auth-body">
          Load the stems once. Everyone woodsheds on their own clock — mute your
          part, play along with the band, rate how tight you are. Songs climb the
          board toward <strong>Show-ready</strong> on their own.
        </p>
        <button
          className="btn btn-google"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await api.signInGoogle() } catch (e) { setBusy(false); alert(e.message) }
          }}
        >
          <GoogleG /> {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
      </div>
      <Toasts toasts={toasts} />
    </FullBleed>
  )
}

/** Shown when the profile can't be set up after sign-in, so the user is never
 *  stuck on "Loading boards…" with no way to sign out. */
function ProfileErrorScreen({ message, onRetry }) {
  return (
    <FullBleed>
      <div className="setup-card">
        <Wordmark />
        <h2>Couldn't finish signing you in</h2>
        <p>Your Google sign-in worked, but setting up your profile failed:</p>
        <pre className="wrap">{message}</pre>
        <p className="dim">
          Try again in a moment. If it keeps happening, sign out and back in, or
          send this message to your bandleader.
        </p>
        <div className="row gap">
          <button className="btn btn-primary" onClick={onRetry}>
            <RefreshCw size={14} /> Try again
          </button>
          <button className="btn btn-ghost" onClick={() => api.signOut()}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>
    </FullBleed>
  )
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.4 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.6l-7.5-5.8c-2.1 1.4-4.7 2.2-7.7 2.2-6.3 0-11.7-3.9-13.6-9.5l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  )
}

/* ================================================================== */
/* Header + profile popover                                            */
/* ================================================================== */

function Header({ profile, onHome, notify, onProfileSaved }) {
  const [open, setOpen] = useState(false)
  return (
    <header className="topbar">
      <button className="wm-btn" onClick={onHome} aria-label="Home">
        <Wordmark small />
      </button>
      <div className="topbar-right">
        {profile && (
          <button className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="avatar" style={{ '--c': profile.color }}>{initials(profile.display_name)}</span>
            <span className="avatar-name">{profile.display_name}</span>
          </button>
        )}
        {open && profile && (
          <ProfilePopover
            profile={profile}
            notify={notify}
            onSaved={(p) => { onProfileSaved(p); setOpen(false) }}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </header>
  )
}

function ProfilePopover({ profile, onSaved, onClose, notify }) {
  const [name, setName] = useState(profile.display_name || '')
  const [instrument, setInstrument] = useState(profile.instrument || '')
  const [saving, setSaving] = useState(false)
  const [cacheMb, setCacheMb] = useState(null)
  useEffect(() => {
    let alive = true
    cache.cacheSize().then((b) => { if (alive) setCacheMb(Math.round((b / 1048576) * 10) / 10) })
    return () => { alive = false }
  }, [])
  return (
    <div className="popover" role="dialog" aria-label="Your profile">
      <label className="field">
        <span>Stage name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Instrument</span>
        <input
          value={instrument}
          placeholder="drums, bass, keys…"
          onChange={(e) => setInstrument(e.target.value)}
        />
      </label>
      <p className="dim tiny">
        Your instrument is shown to bandmates so everyone knows which stem is
        "yours" to mute.
      </p>
      <div className="row gap">
        <button
          className="btn btn-primary"
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true)
            try {
              const p = await api.updateProfile(profile.id, {
                display_name: name.trim(),
                instrument: instrument.trim() || null,
              })
              onSaved(p)
            } catch (e) { notify(e.message) } finally { setSaving(false) }
          }}
        >
          <Check size={14} /> Save
        </button>
        <button className="btn btn-ghost" onClick={() => api.signOut()}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
      <div className="cache-row">
        <span className="dim tiny">
          Stems saved on this device: <strong>{cacheMb === null ? '…' : `${cacheMb} MB`}</strong>
          <br />Saved songs skip the download next time.
        </span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            await cache.clearAll()
            setCacheMb(0)
            notify('Cached audio cleared. Songs will re-download once.')
          }}
        >
          <Trash2 size={13} /> Clear
        </button>
      </div>
      <button className="popover-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
    </div>
  )
}

/* ================================================================== */
/* Boards home                                                         */
/* ================================================================== */

function BoardsHome({ profile, onOpen, notify }) {
  const [rows, setRows] = useState(null)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(() => {
    if (!profile) return
    api.fetchMyBoards(profile.id).then(setRows).catch((e) => notify(e.message))
  }, [profile, notify])

  useEffect(() => { load() }, [load])

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Your rooms</h1>
          <p className="dim">One board per band. Stems in, show-ready out.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Plus size={15} /> New board
        </button>
      </div>

      {!rows && <div className="dim">Loading boards…</div>}
      {rows && rows.length === 0 && (
        <div className="empty">
          <Music2 size={28} />
          <p>No boards yet. Start one for your band, or ask your bandleader for an invite — boards you're invited to appear here automatically after you sign in.</p>
        </div>
      )}

      <div className="board-grid">
        {(rows || []).map(({ role, board }) => (
          <div
            key={board.id}
            className="board-card"
            style={{ '--accent': board.accent || 'var(--teal)' }}
            onClick={() => onOpen(board.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(board.id)}
          >
            <div className="board-card-stripe" />
            <div className="board-card-body">
              <h3>{board.name}</h3>
              {board.tagline && <p className="dim">{board.tagline}</p>}
              <div className="row spread">
                {roleBadge(role)}
                {role === 'owner' && (
                  <button
                    className="icon-btn danger"
                    title="Delete board"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!window.confirm(`Delete "${board.name}" and every song, stem and rating in it? This can't be undone.`)) return
                      try { await api.deleteBoard(board.id); load() } catch (err) { notify(err.message) }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {showNew && (
        <NewBoardModal
          onClose={() => setShowNew(false)}
          onCreated={(b) => { setShowNew(false); onOpen(b.id) }}
          notify={notify}
        />
      )}
    </main>
  )
}

const ACCENTS = ['#3ec6c0', '#f2a33c', '#ff6b4a', '#8b7cf6', '#7cc36a']

function NewBoardModal({ onClose, onCreated, notify }) {
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [accent, setAccent] = useState(ACCENTS[0])
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="New board" onClose={onClose}>
      <label className="field">
        <span>Band / project name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="The Midnight Setlist" />
      </label>
      <label className="field">
        <span>Tagline (optional)</span>
        <input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Spring tour prep" />
      </label>
      <div className="field">
        <span>Accent</span>
        <div className="swatches">
          {ACCENTS.map((c) => (
            <button
              key={c}
              className={`swatch ${accent === c ? 'on' : ''}`}
              style={{ '--c': c }}
              onClick={() => setAccent(c)}
              aria-label={`accent ${c}`}
            />
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              const b = await api.createBoard({ name: name.trim(), tagline: tagline.trim() || null, accent })
              onCreated(b)
            } catch (e) { notify(e.message); setBusy(false) }
          }}
        >
          Create board
        </button>
      </div>
    </Modal>
  )
}

/* ================================================================== */
/* Board view — readiness lanes                                        */
/* ================================================================== */

function BoardView({ boardId, songId, profile, notify, onBack, onOpenSong, onCloseSong }) {
  const [bundle, setBundle] = useState(null)
  const [showNewSong, setShowNewSong] = useState(false)
  const [showMembers, setShowMembers] = useState(false)

  const refresh = useCallback(() => {
    api.fetchBoardBundle(boardId).then(setBundle).catch((e) => notify(e.message))
  }, [boardId, notify])

  useEffect(() => { refresh() }, [refresh])

  const songGone = !!(bundle && songId && !bundle.songs.some((s) => s.id === songId))
  useEffect(() => {
    if (songGone) onCloseSong() // song was deleted under us
  }, [songGone]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!bundle) return <main className="page dim">Loading board…</main>

  const { board, members, songs } = bundle
  const me = members.find((m) => m.user_id === profile?.id)
  const myRole = me?.role || 'member'
  const canAdmin = myRole === 'owner' || myRole === 'admin'
  const isOwner = myRole === 'owner'

  const song = songId ? songs.find((s) => s.id === songId) : null
  if (songId && !song) return null

  if (song) {
    return (
      <SongView
        key={song.id}
        boardId={boardId}
        song={song}
        members={members}
        myRole={myRole}
        profile={profile}
        refresh={refresh}
        onBack={onCloseSong}
        notify={notify}
      />
    )
  }

  const byLane = Object.fromEntries(LANES.map((l) => [l.id, []]))
  songs.forEach((s) => {
    const r = songReadiness(s, members)
    byLane[r.lane].push({ song: s, r })
  })
  Object.values(byLane).forEach((arr) =>
    arr.sort((a, b) => (b.r.avg ?? -1) - (a.r.avg ?? -1) || a.song.title.localeCompare(b.song.title))
  )

  return (
    <main className="page board-page" style={{ '--accent': board.accent || 'var(--teal)' }}>
      <div className="board-head">
        <button className="btn btn-ghost" onClick={onBack}><ChevronLeft size={15} /> Rooms</button>
        <div className="board-title">
          <h1>{board.name}</h1>
          {board.tagline && <span className="dim">{board.tagline}</span>}
        </div>
        <div className="row gap">
          <div className="member-dots" title={members.map((m) => m.profiles?.display_name || m.email).join(', ')}>
            {members.slice(0, 6).map((m) => (
              <span
                key={m.id}
                className={`avatar sm ${m.user_id ? '' : 'pending'}`}
                style={{ '--c': m.profiles?.color || '#39424e' }}
                title={m.profiles?.display_name || `${m.email} (invited)`}
              >
                {initials(m.profiles?.display_name || m.email)}
              </span>
            ))}
          </div>
          <button className="btn btn-ghost" onClick={() => setShowMembers(true)}>
            <Users size={15} /> Members
          </button>
          {canAdmin && (
            <button className="btn btn-primary" onClick={() => setShowNewSong(true)}>
              <Plus size={15} /> Add song
            </button>
          )}
        </div>
      </div>

      <div className="lanes">
        {LANES.map((lane) => (
          <section key={lane.id} className={`lane lane-${lane.tone}`}>
            <header className="lane-head">
              <span className="lane-led" aria-hidden="true" />
              <h2>{lane.label}</h2>
              <span className="lane-hint">{lane.hint}</span>
              <span className="lane-count">{byLane[lane.id].length}</span>
            </header>
            <div className="lane-body">
              {byLane[lane.id].length === 0 && <div className="lane-empty">—</div>}
              {byLane[lane.id].map(({ song: s, r }) => (
                <SongCard
                  key={s.id}
                  song={s}
                  readiness={r}
                  members={members}
                  onOpen={() => onOpenSong(s.id)}
                  canDelete={isOwner}
                  onDelete={async () => {
                    if (!window.confirm(`Delete "${s.title}"? Stems, ratings and comments go with it.`)) return
                    try { await api.deleteSong(s.id); refresh() } catch (e) { notify(e.message) }
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {showNewSong && (
        <NewSongModal
          boardId={boardId}
          onClose={() => setShowNewSong(false)}
          onCreated={(newSongId) => { setShowNewSong(false); refresh(); onOpenSong(newSongId) }}
          notify={notify}
        />
      )}
      {showMembers && (
        <MembersModal
          board={board}
          members={members}
          myRole={myRole}
          profile={profile}
          refresh={refresh}
          onClose={() => setShowMembers(false)}
          onLeft={onBack}
          notify={notify}
        />
      )}
    </main>
  )
}

function SongCard({ song, readiness, members, onOpen, canDelete, onDelete }) {
  const claimed = members.filter((m) => m.user_id)
  return (
    <div className="song-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="song-card-top">
        <h3>{song.title}</h3>
        {canDelete && (
          <button className="icon-btn danger" title="Delete song"
            onClick={(e) => { e.stopPropagation(); onDelete() }}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <div className="song-meta mono">
        <span>{song.key}</span>
        <span>{song.sig}</span>
        <span>{song.bpm} BPM</span>
      </div>
      <div className="song-card-bottom">
        <span className="chip"><SlidersHorizontal size={11} /> {song.stems.length} stems</span>
        {song.commentCount > 0 && <span className="chip"><MessageSquare size={11} /> {song.commentCount}</span>}
        <span className="song-avg mono">
          {readiness.avg == null ? '—' : readiness.avg.toFixed(1)}
        </span>
      </div>
      <div className="rating-dots">
        {claimed.map((m) => {
          const p = (song.practice || []).find((x) => x.user_id === m.user_id)
          const c = p?.confidence
          return (
            <span
              key={m.id}
              className="rdot"
              style={{ '--c': m.profiles?.color || '#39424e', opacity: c == null ? 0.25 : 1 }}
              title={`${m.profiles?.display_name || m.email}: ${c == null ? 'not rated' : c + '/10'}${ratedByOwner(p) ? ' (set by owner)' : ''}`}
            >
              {c ?? '·'}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/* ================================================================== */
/* New song modal — demo synth OR folder upload                        */
/* ================================================================== */

function NewSongModal({ boardId, onClose, onCreated, notify }) {
  const [title, setTitle] = useState('')
  const [root, setRoot] = useState('C')
  const [scale, setScale] = useState('major')
  const [sig, setSig] = useState('4/4')
  const [bpm, setBpm] = useState(100)
  const [mode, setMode] = useState('demo') // demo | upload
  const [demoCount, setDemoCount] = useState(4)
  const [files, setFiles] = useState([]) // [{file, name}]
  const [dragOver, setDragOver] = useState(false)
  const [progress, setProgress] = useState(null) // string status while creating
  const fileInputRef = useRef(null)
  const dirInputRef = useRef(null)

  const addFiles = (list) => {
    const next = [...files]
    for (const f of list) {
      if (!isAudioFile(f)) continue
      next.push({ file: f, name: cleanTrackName(f.name) })
    }
    next.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }))
    setFiles(next)
    if (next.length > 0) setMode('upload')
  }

  const create = async () => {
    try {
      setProgress('Creating song…')
      const song = await api.addSong(boardId, {
        title: title.trim(),
        key: `${root} ${scale}`,
        sig,
        bpm: Math.max(30, Math.min(300, Number(bpm) || 100)),
      })
      if (mode === 'demo') {
        const names = DEMO_TRACK_NAMES.slice(0, demoCount)
        for (let i = 0; i < names.length; i++) {
          setProgress(`Adding demo track ${i + 1}/${names.length}…`)
          await api.addStem(song.id, { name: names[i], source: 'demo', sort: i })
        }
      } else {
        for (let i = 0; i < files.length; i++) {
          const { file, name } = files[i]
          setProgress(`Uploading ${i + 1}/${files.length}: ${name}…`)
          const stem = await api.addStem(song.id, { name, source: 'upload', sort: i })
          await api.uploadStemFile(boardId, song.id, stem.id, file)
        }
      }
      onCreated(song.id)
    } catch (e) {
      setProgress(null)
      notify(`Couldn't create the song: ${e.message}`)
    }
  }

  const valid = title.trim() && (mode === 'demo' ? demoCount > 0 : files.length > 0)

  return (
    <Modal title="Add song" onClose={progress ? undefined : onClose} wide>
      <div className="grid-2">
        <label className="field span-2">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Neon Alibi" />
        </label>
        <div className="field">
          <span>Key</span>
          <div className="row gap">
            <select value={root} onChange={(e) => setRoot(e.target.value)}>
              {KEY_ROOTS.map((k) => <option key={k}>{k}</option>)}
            </select>
            <select value={scale} onChange={(e) => setScale(e.target.value)}>
              <option value="major">major</option>
              <option value="minor">minor</option>
            </select>
          </div>
        </div>
        <div className="field">
          <span>Time / tempo</span>
          <div className="row gap">
            <select value={sig} onChange={(e) => setSig(e.target.value)}>
              {SIGS.map((s) => <option key={s}>{s}</option>)}
            </select>
            <input
              className="bpm-input mono" type="number" min="30" max="300" value={bpm}
              onChange={(e) => setBpm(e.target.value)} aria-label="BPM"
            />
            <span className="dim self-center">BPM</span>
          </div>
        </div>
      </div>

      <div className="mode-toggle" role="tablist">
        <button role="tab" aria-selected={mode === 'demo'} className={mode === 'demo' ? 'on' : ''} onClick={() => setMode('demo')}>
          <Sparkles size={14} /> Auto-generate demo stems
        </button>
        <button role="tab" aria-selected={mode === 'upload'} className={mode === 'upload' ? 'on' : ''} onClick={() => setMode('upload')}>
          <Upload size={14} /> Upload real audio
        </button>
      </div>

      {mode === 'demo' && (
        <div className="demo-config">
          <p className="dim">
            Jam-Meet synthesizes playable 4-bar loops from the key and BPM above —
            perfect for trying the room before the real stems land.
          </p>
          <label className="field">
            <span>Tracks: {demoCount}</span>
            <input type="range" min="2" max="6" value={demoCount}
              onChange={(e) => setDemoCount(Number(e.target.value))} />
          </label>
          <div className="row gap wrap">
            {DEMO_TRACK_NAMES.slice(0, demoCount).map((n) => <span className="chip" key={n}>{n}</span>)}
          </div>
        </div>
      )}

      {mode === 'upload' && (
        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault(); setDragOver(false)
            const got = await filesFromDataTransfer(e.dataTransfer)
            if (got.length === 0) notify('No audio files found in that drop.', 'info')
            addFiles(got)
          }}
        >
          <FolderOpen size={22} />
          <p><strong>Drop a whole folder of stems here</strong> — each audio file
            becomes a track, named from its filename.</p>
          <div className="row gap">
            <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>Choose files</button>
            <button className="btn btn-ghost" onClick={() => dirInputRef.current?.click()}>Choose a folder</button>
          </div>
          <input ref={fileInputRef} type="file" multiple accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aif,.aiff"
            hidden onChange={(e) => addFiles([...e.target.files])} />
          <input ref={dirInputRef} type="file" webkitdirectory="" hidden
            onChange={(e) => addFiles([...e.target.files])} />
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={i}>
                  <input
                    className="file-name" value={f.name}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setFiles(files.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  />
                  <span className="dim tiny mono">{f.file.name}</span>
                  <button className="icon-btn" onClick={(e) => { e.stopPropagation(); setFiles(files.filter((_, j) => j !== i)) }} aria-label="Remove file">
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="modal-actions">
        {progress
          ? <span className="dim">{progress}</span>
          : <>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!valid} onClick={create}>Create song</button>
          </>}
      </div>
    </Modal>
  )
}

/* ================================================================== */
/* Members modal                                                       */
/* ================================================================== */

function MembersModal({ board, members, myRole, profile, refresh, onClose, onLeft, notify }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const isOwner = myRole === 'owner'
  const adminCount = members.filter((m) => m.role === 'admin').length

  return (
    <Modal title="Band members" onClose={onClose}>
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id} className="member-row">
            <span className={`avatar ${m.user_id ? '' : 'pending'}`} style={{ '--c': m.profiles?.color || '#39424e' }}>
              {initials(m.profiles?.display_name || m.email)}
            </span>
            <div className="member-info">
              <strong>{m.profiles?.display_name || m.email}</strong>
              <span className="dim tiny">
                {m.user_id ? (m.profiles?.instrument || m.email) : 'invited — joins on first sign-in'}
              </span>
            </div>
            {isOwner && m.role !== 'owner' ? (
              <div className="row gap">
                <select
                  value={m.role}
                  onChange={async (e) => {
                    try { await api.setMemberRole(m.id, e.target.value); refresh() }
                    catch (err) { notify(err.message) }
                  }}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button className="icon-btn danger" title="Remove"
                  onClick={async () => {
                    if (!window.confirm(`Remove ${m.profiles?.display_name || m.email} from ${board.name}?`)) return
                    try { await api.removeMember(m.id); refresh() } catch (err) { notify(err.message) }
                  }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ) : roleBadge(m.role)}
          </li>
        ))}
      </ul>

      {isOwner && (
        <div className="invite-box">
          <h4><UserPlus size={14} /> Invite by email</h4>
          <p className="dim tiny">
            They'll see this board the first time they sign in with that Google
            account. Admins can add songs and manage stems — max 2 per board
            ({adminCount}/2 used).
          </p>
          <div className="row gap">
            <input
              type="email" placeholder="bassist@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && document.getElementById('invite-go')?.click()}
            />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">member</option>
              <option value="admin" disabled={adminCount >= 2}>admin</option>
            </select>
            <button
              id="invite-go" className="btn btn-primary" disabled={busy || !email.includes('@')}
              onClick={async () => {
                setBusy(true)
                try {
                  await api.inviteMember(board.id, email, role)
                  setEmail(''); refresh()
                } catch (e) { notify(e.message) } finally { setBusy(false) }
              }}
            >
              Invite
            </button>
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="modal-actions">
          <button
            className="btn btn-danger-ghost"
            onClick={async () => {
              const mine = members.find((m) => m.user_id === profile.id)
              if (!mine) return
              if (!window.confirm(`Leave ${board.name}? Your ratings stay with the band.`)) return
              try { await api.removeMember(mine.id); onClose(); onLeft() } catch (e) { notify(e.message) }
            }}
          >
            Leave board
          </button>
        </div>
      )}
    </Modal>
  )
}

/* ================================================================== */
/* Song view — the mixing console                                      */
/* ================================================================== */

function SongView({ boardId, song, members, myRole, profile, refresh, onBack, notify }) {
  const canAdmin = myRole === 'owner' || myRole === 'admin'
  const isOwner = myRole === 'owner'
  const beatsPerBar = parseInt(song.sig.split('/')[0], 10) || 4

  const mixerRef = useRef(null)
  const meterEls = useRef({})
  const masterMeterEl = useRef(null)
  const timeEl = useRef(null)
  const progressEl = useRef(null)

  const [loadState, setLoadState] = useState('loading') // loading | ready | error
  const [loadMsg, setLoadMsg] = useState('Loading stems…')
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [metro, setMetro] = useState(false)
  const [master, setMaster] = useState(1)
  const [trackUi, setTrackUi] = useState({}) // id -> {gain, muted, solo}
  const [duration, setDuration] = useState(0)
  const [showEdit, setShowEdit] = useState(false)

  const myPractice = (song.practice || []).find((p) => p.user_id === profile.id)
  const [plays, setPlays] = useState(myPractice?.plays ?? 0)
  const [myRating, setMyRating] = useState(myPractice?.confidence ?? null)
  const playsRef = useRef(plays)
  playsRef.current = plays
  const [ratePromptAt, setRatePromptAt] = useState(null) // pass count that triggered the check-in

  // Keep the local rating in step when the owner rates for you (arrives via refresh).
  useEffect(() => { setMyRating(myPractice?.confidence ?? null) }, [myPractice?.confidence])

  const rateMine = async (v) => {
    try {
      setMyRating(v)
      await api.rateSong(song.id, profile.id, v)
      refresh()
    } catch (e) { notify(e.message) }
  }

  const stemsSig = useMemo(
    () => JSON.stringify(song.stems.map((s) => [s.id, s.name, s.storage_path, s.source])),
    [song.stems]
  )

  // Build (or rebuild) the mixer whenever the stem set changes.
  useEffect(() => {
    let cancelled = false
    const mixer = new Mixer()
    mixerRef.current = mixer
    mixer.setTempo(song.bpm, beatsPerBar)
    mixer.onPassComplete = () => {
      api.logPlay(song.id)
        .then((n) => {
          setPlays(n)
          if (isRatingMilestone(n)) setRatePromptAt(n) // audio keeps playing underneath
          refresh()
        })
        .catch(() => { /* offline pass — not fatal */ })
    }

    ;(async () => {
      try {
        setLoadState('loading')
        const demoStems = song.stems.filter((s) => s.source === 'demo' || !s.storage_path)
        const realStems = song.stems.filter((s) => !(s.source === 'demo' || !s.storage_path))

        // Memory holds only the most recently opened song: drop any other song's
        // decoded audio before decoding this one, so a phone never holds two.
        cache.retainOnly(realStems.map((s) => [s.id, s.storage_path]))

        // Anything already decoded in memory is free — reopening a song you
        // just closed should be instant.
        const inMemory = new Map()
        for (const s of realStems) {
          const b = cache.getMemory(s.id, s.storage_path)
          if (b) inMemory.set(s.id, b)
        }
        const needed = realStems.filter((s) => !inMemory.has(s.id))

        // Say whether we're downloading or just reading what this device saved.
        const onDevice = await Promise.all(needed.map((s) => cache.hasStored(s.id, s.storage_path)))
        const toDownload = onDevice.filter((x) => !x).length
        const label = toDownload
          ? `Downloading ${toDownload} stem${toDownload === 1 ? '' : 's'}`
          : 'Loading stems saved on this device'
        if (!cancelled) {
          setLoadMsg(
            demoStems.length ? 'Synthesizing demo loops…'
              : needed.length ? `${label}…` : 'Ready'
          )
        }

        const demoBufs = await synthDemoStems(demoStems, song)

        // Fetch every remaining stem at once rather than one after another.
        let done = 0
        const total = needed.length
        const tick = () => {
          done += 1
          if (!cancelled && total) setLoadMsg(`${label}… ${done}/${total}`)
        }
        const fetched = new Map()
        await Promise.all(
          needed.map(async (s) => {
            let bytes = await cache.getStored(s.id, s.storage_path)
            if (!bytes) {
              const ab = await api.fetchStemArrayBuffer(s.storage_path)
              bytes = ab
              cache.putStored(s.id, s.storage_path, ab) // decodeAudio copies internally, so ab stays intact
            }
            const buffer = await decodeAudio(bytes)
            cache.putMemory(s.id, s.storage_path, buffer)
            fetched.set(s.id, buffer)
            tick()
          })
        )

        if (cancelled) return
        const defs = []
        for (const s of song.stems) {
          const buffer = demoBufs.get(s.id) || inMemory.get(s.id) || fetched.get(s.id)
          if (!buffer) continue
          defs.push({ id: s.id, name: s.name, buffer, gain: s.gain ?? 1 })
        }
        if (cancelled) return
        mixer.setTracks(defs)
        setDuration(mixer.duration)
        setTrackUi(Object.fromEntries(defs.map((d) => [d.id, { gain: d.gain, muted: false, solo: false }])))
        setLoadState('ready')
      } catch (e) {
        if (!cancelled) { setLoadState('error'); setLoadMsg(e.message) }
      }
    })()

    return () => { cancelled = true; mixer.dispose(); mixerRef.current = null }
  }, [stemsSig, song.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // rAF loop: transport, timecode, progress, VU meters (direct DOM for 60fps).
  useEffect(() => {
    let raf
    const tick = () => {
      const mixer = mixerRef.current
      if (mixer) {
        const pos = mixer.update()
        if (timeEl.current) timeEl.current.textContent = formatTime(pos)
        if (progressEl.current && mixer.duration > 0) {
          progressEl.current.style.width = `${(pos / mixer.duration) * 100}%`
        }
        for (const [id, el] of Object.entries(meterEls.current)) {
          if (!el) continue
          const lvl = mixer.playing ? mixer.trackLevel(id) : 0
          el.style.height = `${Math.round(lvl * 100)}%`
        }
        if (masterMeterEl.current) {
          const lvl = mixer.playing ? mixer.masterLevel() : 0
          masterMeterEl.current.style.width = `${Math.round(lvl * 100)}%`
        }
        if (mixer.playing !== playingStateRef.current) {
          playingStateRef.current = mixer.playing
          setPlaying(mixer.playing)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const playingStateRef = useRef(false)

  const mixer = mixerRef.current

  const togglePlay = async () => {
    if (!mixer || loadState !== 'ready') return
    if (mixer.playing) { mixer.pause(); setPlaying(false) }
    else { await mixer.play(); setPlaying(true) }
  }

  const seekFromEvent = (e) => {
    if (!mixer || mixer.duration === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    mixer.seek(frac * mixer.duration)
  }

  const claimed = members.filter((m) => m.user_id)
  const readiness = songReadiness(song, members)
  const laneMeta = LANES.find((l) => l.id === readiness.lane)

  return (
    <main className="page console-page">
      <div className="console-head">
        <button className="btn btn-ghost" onClick={onBack}><ChevronLeft size={15} /> Board</button>
        <div className="console-title">
          <h1>{song.title}</h1>
          <div className="song-meta mono">
            <span>{song.key}</span><span>{song.sig}</span><span>{song.bpm} BPM</span>
            <span className={`lane-chip lane-${laneMeta.tone}`}>{laneMeta.label}</span>
          </div>
        </div>
        {canAdmin && (
          <button className="btn btn-ghost" onClick={() => setShowEdit(true)}>
            <Pencil size={14} /> Edit tracks
          </button>
        )}
      </div>

      <div className="console-layout">
        <section className="console" aria-label="Mixing console">
          {loadState === 'loading' && <div className="console-loading">{loadMsg}</div>}
          {loadState === 'error' && (
            <div className="console-loading error">
              {loadMsg}
              <button className="btn btn-ghost" onClick={refresh}><RefreshCw size={14} /> Retry</button>
            </div>
          )}

          {loadState === 'ready' && (
            <>
              <div className="strips">
                {song.stems.map((s) => {
                  const ui = trackUi[s.id] || { gain: 1, muted: false, solo: false }
                  return (
                    <div key={s.id} className={`strip ${ui.muted ? 'is-muted' : ''} ${ui.solo ? 'is-solo' : ''}`}>
                      <div className="strip-name" title={s.name}>{s.name}</div>
                      <div className="strip-src mono">{s.source === 'demo' ? 'DEMO' : 'WAVE'}</div>
                      <div className="strip-body">
                        <div className="vu" aria-hidden="true">
                          <div className="vu-fill" ref={(el) => { meterEls.current[s.id] = el }} />
                          <div className="vu-leds" />
                        </div>
                        <div className="fader">
                          <input
                            type="range" min="0" max="1.5" step="0.01" value={ui.gain}
                            aria-label={`${s.name} level`}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value)
                              mixer?.setTrackGain(s.id, v)
                              setTrackUi((t) => ({ ...t, [s.id]: { ...ui, gain: v } }))
                            }}
                          />
                        </div>
                      </div>
                      <div className="strip-gain mono">{ui.gain.toFixed(2)}</div>
                      <div className="strip-btns">
                        <button
                          className={`ms-btn m ${ui.muted ? 'on' : ''}`}
                          aria-pressed={ui.muted}
                          title="Mute (mute your own instrument and play along)"
                          onClick={() => {
                            const muted = mixer?.toggleMute(s.id)
                            setTrackUi((t) => ({ ...t, [s.id]: { ...ui, muted } }))
                          }}
                        >M</button>
                        <button
                          className={`ms-btn s ${ui.solo ? 'on' : ''}`}
                          aria-pressed={ui.solo}
                          title="Solo"
                          onClick={() => {
                            const solo = mixer?.toggleSolo(s.id)
                            setTrackUi((t) => ({ ...t, [s.id]: { ...ui, solo } }))
                          }}
                        >S</button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="transport">
                <div className="progress" onPointerDown={seekFromEvent} role="slider"
                  aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (!mixer) return
                    if (e.key === 'ArrowRight') mixer.seek(mixer.position + 1)
                    if (e.key === 'ArrowLeft') mixer.seek(mixer.position - 1)
                  }}>
                  <div className="progress-fill" ref={progressEl} />
                </div>
                <div className="transport-row">
                  <div className="row gap">
                    <button className="t-btn primary" onClick={togglePlay} title={playing ? 'Pause' : 'Play (all stems start together)'}>
                      {playing ? <Pause size={18} /> : <Play size={18} />}
                    </button>
                    <button className="t-btn" onClick={() => { mixer?.stop(); setPlaying(false) }} title="Stop">
                      <Square size={15} />
                    </button>
                    <button className={`t-btn toggle ${loop ? 'on' : ''}`} aria-pressed={loop} title="Loop"
                      onClick={() => { const v = !loop; setLoop(v); if (mixer) mixer.loop = v }}>
                      <Repeat size={15} />
                    </button>
                    <button className={`t-btn toggle ${metro ? 'on' : ''}`} aria-pressed={metro}
                      title={`Metronome (accent on 1 of ${beatsPerBar})`}
                      onClick={() => { const v = !metro; setMetro(v); if (mixer) mixer.metroOn = v }}>
                      <Timer size={15} />
                    </button>
                  </div>
                  <div className="timecode mono">
                    <span ref={timeEl}>00:00.0</span>
                    <span className="dim"> / {formatTime(duration)}</span>
                  </div>
                  <div className="master">
                    <span className="tiny dim">MASTER</span>
                    <input type="range" min="0" max="1.5" step="0.01" value={master} aria-label="Master volume"
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setMaster(v); mixer?.setMasterGain(v)
                      }} />
                    <div className="master-vu"><div className="master-vu-fill" ref={masterMeterEl} /></div>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <aside className="side">
          <PracticePanel
            plays={plays}
            myRating={myRating}
            claimed={claimed}
            song={song}
            readiness={readiness}
            onRate={rateMine}
            isOwner={isOwner}
            profileId={profile.id}
            onRateFor={async (userId, v) => {
              try { await api.rateForMember(song.id, userId, v); refresh() }
              catch (e) { notify(e.message) }
            }}
          />
          <CommentsPanel song={song} profile={profile} myRole={myRole} notify={notify} onChanged={refresh} />
        </aside>
      </div>

      {ratePromptAt != null && (
        <RatePrompt
          plays={ratePromptAt}
          current={myRating}
          onRate={(v) => { setRatePromptAt(null); rateMine(v) }}
          onClose={() => setRatePromptAt(null)}
        />
      )}

      {showEdit && (
        <EditTracksModal
          boardId={boardId}
          song={song}
          onClose={() => setShowEdit(false)}
          refresh={refresh}
          notify={notify}
        />
      )}
    </main>
  )
}

/* ---------------- practice / readiness ---------------- */

const SCORES = Array.from({ length: 10 }, (_, i) => i + 1)

/** Check-in that pops up at 3, 6, 10, 20… full passes. */
function RatePrompt({ plays, current, onRate, onClose }) {
  return (
    <Modal title="How's it feeling?" onClose={onClose}>
      <p>
        That's <strong>{plays} full plays</strong> of this song. How confident are you
        with your part right now?
      </p>
      <div className="rate-row" role="radiogroup" aria-label="Confidence 1 to 10">
        {SCORES.map((v) => (
          <button key={v} role="radio" aria-checked={current === v}
            className={`rate-btn ${current === v ? 'on' : ''}`} onClick={() => onRate(v)}>
            {v}
          </button>
        ))}
      </div>
      <p className="dim tiny">1 = still learning it · 10 = show-ready. We'll ask again as you keep playing.</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Not now</button>
      </div>
    </Modal>
  )
}

function PracticePanel({ plays, myRating, claimed, song, readiness, onRate, isOwner, profileId, onRateFor }) {
  const canRate = plays >= 3
  const [pickFor, setPickFor] = useState(null) // member user_id the owner is rating
  return (
    <div className="panel">
      <h3>Woodshed log</h3>
      <div className="plays-row">
        <span className="mono plays-count">{plays}</span>
        <span className="dim">full passes</span>
        <span className="pass-pips" aria-hidden="true">
          {[0, 1, 2].map((i) => <i key={i} className={plays > i ? 'lit' : ''} />)}
        </span>
      </div>
      <p className="dim tiny">
        A pass counts when the transport runs the song to the end. Rate your
        confidence after three passes — we'll check in again at 6, 9, 15, then every 5.
      </p>
      <div className={`rate-row ${canRate ? '' : 'locked'}`} role="radiogroup" aria-label="Confidence 1 to 10">
        {SCORES.map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={myRating === v}
            className={`rate-btn ${myRating === v ? 'on' : ''}`}
            disabled={!canRate}
            onClick={() => onRate(v)}
          >
            {v}
          </button>
        ))}
      </div>
      {!canRate && <p className="dim tiny lock-hint">Rating unlocks after 3 passes — {plays}/3 so far.</p>}

      <h4 className="readiness-h">Band readiness</h4>
      <ul className="readiness-list">
        {claimed.map((m) => {
          const p = (song.practice || []).find((x) => x.user_id === m.user_id)
          const name = m.profiles?.display_name || m.email
          const canSet = isOwner && m.user_id !== profileId
          return (
            <li key={m.id} className={pickFor === m.user_id ? 'picking' : ''}>
              <div className="rl-row">
                <span className="avatar sm" style={{ '--c': m.profiles?.color || '#39424e' }}>
                  {initials(name)}
                </span>
                <span className="rl-name">{name}</span>
                <span className="dim tiny">{p?.plays ? `${p.plays}×` : ''}</span>
                {ratedByOwner(p) && (
                  <span className="by-owner" title="Set by the board owner"><Crown size={10} /> owner</span>
                )}
                {canSet ? (
                  <button
                    className="mono rl-score rl-score-btn"
                    title={`Rate for ${name}`}
                    aria-expanded={pickFor === m.user_id}
                    onClick={() => setPickFor(pickFor === m.user_id ? null : m.user_id)}
                  >
                    {p?.confidence ?? '—'} <Pencil size={10} />
                  </button>
                ) : (
                  <span className="mono rl-score">{p?.confidence ?? '—'}</span>
                )}
              </div>
              {pickFor === m.user_id && (
                <div className="rate-row rate-row-sm" role="radiogroup" aria-label={`Confidence for ${name}`}>
                  {SCORES.map((v) => (
                    <button key={v} role="radio" aria-checked={p?.confidence === v}
                      className={`rate-btn ${p?.confidence === v ? 'on' : ''}`}
                      onClick={() => { setPickFor(null); onRateFor(m.user_id, v) }}>
                      {v}
                    </button>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <div className="band-avg">
        <span>Band average</span>
        <span className="mono">{readiness.avg == null ? '—' : `${readiness.avg.toFixed(1)} / 10`}</span>
      </div>
      <p className="dim tiny band-avg-note">
        {readiness.count} of {readiness.total} rated · not-yet-rated counts as 0
      </p>
    </div>
  )
}

/* ---------------- comments ---------------- */

function CommentsPanel({ song, profile, myRole, notify, onChanged }) {
  const [comments, setComments] = useState(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.fetchComments(song.id).then(setComments).catch((e) => notify(e.message))
  }, [song.id, notify])
  useEffect(() => { load() }, [load])

  const send = async () => {
    if (!body.trim()) return
    setBusy(true)
    try {
      await api.addComment(song.id, profile.id, body.trim())
      setBody(''); load(); onChanged()
    } catch (e) { notify(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="panel">
      <h3><MessageSquare size={14} /> Notes to the band</h3>
      <div className="comments">
        {!comments && <span className="dim tiny">Loading…</span>}
        {comments && comments.length === 0 && (
          <span className="dim tiny">No notes yet. "Watch the push into the bridge" goes here.</span>
        )}
        {(comments || []).map((c) => (
          <div key={c.id} className="comment">
            <span className="avatar sm" style={{ '--c': c.profiles?.color || '#39424e' }}>
              {initials(c.profiles?.display_name || '?')}
            </span>
            <div className="comment-body">
              <div className="comment-head">
                <strong>{c.profiles?.display_name || 'Someone'}</strong>
                <span className="dim tiny">{new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                {(c.user_id === profile.id || myRole === 'owner') && (
                  <button className="icon-btn danger tiny-btn" title="Delete note"
                    onClick={async () => {
                      try { await api.deleteComment(c.id); load(); onChanged() } catch (e) { notify(e.message) }
                    }}>
                    <X size={11} />
                  </button>
                )}
              </div>
              <p>{c.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="comment-input">
        <input
          value={body}
          placeholder="Leave a note…"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
        />
        <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={send} aria-label="Send note">
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

/* ---------------- edit tracks (owner/admin) ---------------- */

function EditTracksModal({ boardId, song, onClose, refresh, notify }) {
  const [busyId, setBusyId] = useState(null)
  const [names, setNames] = useState(Object.fromEntries(song.stems.map((s) => [s.id, s.name])))
  const addFileRef = useRef(null)

  const saveName = async (stem) => {
    const n = (names[stem.id] || '').trim()
    if (!n || n === stem.name) return
    try { await api.renameStem(stem.id, n); refresh() } catch (e) { notify(e.message) }
  }

  const replaceAudio = async (stem, file) => {
    if (!isAudioFile(file)) { notify('That file doesn\'t look like audio.'); return }
    setBusyId(stem.id)
    try {
      if (stem.storage_path) await supabase.storage.from('stems').remove([stem.storage_path])
      cache.dropMemory(stem.id) // this device is holding the old decode
      await api.uploadStemFile(boardId, song.id, stem.id, file)
      refresh()
    } catch (e) { notify(e.message) } finally { setBusyId(null) }
  }

  const addUploadTrack = async (file) => {
    if (!isAudioFile(file)) { notify('That file doesn\'t look like audio.'); return }
    setBusyId('new')
    try {
      const stem = await api.addStem(song.id, {
        name: cleanTrackName(file.name),
        source: 'upload',
        sort: song.stems.length,
      })
      await api.uploadStemFile(boardId, song.id, stem.id, file)
      refresh()
    } catch (e) { notify(e.message) } finally { setBusyId(null) }
  }

  const addDemoTrack = async () => {
    const used = new Set(song.stems.map((s) => s.name))
    const name = DEMO_TRACK_NAMES.find((n) => !used.has(n)) || `Loop ${song.stems.length + 1}`
    setBusyId('new')
    try {
      await api.addStem(song.id, { name, source: 'demo', sort: song.stems.length })
      refresh()
    } catch (e) { notify(e.message) } finally { setBusyId(null) }
  }

  return (
    <Modal title={`Tracks — ${song.title}`} onClose={onClose} wide>
      <ul className="track-edit-list">
        {song.stems.map((s) => (
          <li key={s.id} className="track-edit-row">
            <span className="chip mono">{s.source === 'demo' ? 'DEMO' : 'WAVE'}</span>
            <input
              value={names[s.id] ?? s.name}
              onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))}
              onBlur={() => saveName(s)}
              onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
              aria-label="Track name"
            />
            <label className={`btn btn-ghost file-btn ${busyId === s.id ? 'busy' : ''}`}>
              <Upload size={13} /> {busyId === s.id ? 'Uploading…' : 'Replace audio'}
              <input type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aif,.aiff" hidden
                onChange={(e) => e.target.files[0] && replaceAudio(s, e.target.files[0])} />
            </label>
            <button className="icon-btn danger" title="Remove track"
              disabled={busyId != null}
              onClick={async () => {
                if (!window.confirm(`Remove track "${s.name}"?`)) return
                try { await api.removeStem(s); refresh() } catch (e) { notify(e.message) }
              }}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="row gap">
        <label className="btn btn-ghost file-btn">
          <Plus size={14} /> {busyId === 'new' ? 'Working…' : 'Add track from file'}
          <input ref={addFileRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aif,.aiff" hidden
            onChange={(e) => e.target.files[0] && addUploadTrack(e.target.files[0])} />
        </label>
        <button className="btn btn-ghost" disabled={busyId != null} onClick={addDemoTrack}>
          <Sparkles size={14} /> Add demo loop
        </button>
      </div>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}

/* ================================================================== */
/* Modal shell                                                         */
/* ================================================================== */

function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose() }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>}
        </div>
        {children}
      </div>
    </div>
  )
}
