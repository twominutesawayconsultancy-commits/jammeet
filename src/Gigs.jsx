// Gigs.jsx — a board's gig calendar: dates, who's In/Maybe/Out (with full
// answer history), the setlist for each gig, and a notes thread.
// Data: supabase/migration-005-gigs.sql. All calls go through lib/api.js.
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import * as api from './lib/api'
import { Modal, initials, songReadiness, LANES, memberName } from './App.jsx'
import GigImportModal from './GigImport.jsx'
import {
  ChevronLeft, ChevronRight, Plus, Pencil, Trash2, Send, X, CalendarDays,
  ListMusic, MessageSquare, History, ArrowUp, ArrowDown, Play, FileUp,
  Plane, Shirt, BarChart3, MapPin, Clock,
} from 'lucide-react'

const STATUS = {
  tentative: 'Tentative',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
}
const ANSWER = { in: 'In', maybe: 'Maybe', out: 'Out' }
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseDay = (k) => new Date(`${k}T12:00:00`)
const fmtDay = (k, opts) => parseDay(k).toLocaleDateString(undefined, opts)
const fmtStamp = (iso) => new Date(iso).toLocaleString(undefined, {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
})
const nameOf = memberName
const fmtShort = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** Whose answer a log row is: the membership, or the saved name if they've left. */
const answerKey = (a) => a.membership_id || `gone:${a.person_name || a.id}`

/**
 * Per person (keyed by membership id): current answer (latest by when it was
 * said), the one before it, and the full history. People who never answered
 * are left out of the map. Rows arrive sorted by said_at from api.fetchGigs.
 */
function answerState(gig) {
  const map = new Map()
  for (const a of gig.gig_answers || []) {
    const k = answerKey(a)
    const e = map.get(k) || { history: [] }
    e.history.push(a)
    map.set(k, e)
  }
  for (const e of map.values()) {
    e.current = e.history[e.history.length - 1]
    const earlier = [...e.history].reverse().find((h) => h.answer !== e.current.answer)
    e.changedFrom = earlier ? earlier.answer : null
  }
  return map
}

/**
 * Read a gig's details text into sections. The chat importer (GigImport.jsx)
 * writes labelled lines — "Lineup: A (vocals), B (keys)", "Open: Bassist",
 * "Travel: …", "Dress: …", "Poll: …", an indented "Schedule:" and
 * "From the chat:" block — and anything unlabelled is the summary. Details
 * typed by hand come back as summary text, so nothing is ever hidden.
 */
const FACT_LABELS = ['Venue', 'Travel', 'Dress', 'Poll']
function parseDetails(details) {
  const d = { summary: [], lineup: [], open: [], facts: [], schedule: [], chat: [], needsCheck: false }
  let block = null
  for (const raw of (details || '').split('\n')) {
    const line = raw.trimEnd()
    if (block && /^\s+\S/.test(line)) {
      const t = line.trim()
      if (block === 'chat') d.chat.push(t)
      else {
        const m = t.match(/^(.*?)\s+—\s+(.*)$/)
        d.schedule.push(m ? { t: m[1], what: m[2] } : { t: '', what: t })
      }
      continue
    }
    block = null
    let m
    if (!line.trim()) continue
    if (/^From the chat:\s*$/.test(line)) block = 'chat'
    else if (/^Schedule:\s*$/.test(line)) block = 'schedule'
    else if (/^Needs check:/.test(line)) d.needsCheck = true
    else if ((m = line.match(/^Lineup:\s*(.+)$/))) {
      for (const part of m[1].split(/,\s*/)) {
        const p = part.match(/^(.*?)\s*(?:\(([^)]*)\))?$/)
        if (p && p[1]) d.lineup.push({ name: p[1].trim(), role: p[2]?.trim() || '' })
      }
    } else if ((m = line.match(/^Open:\s*(.+)$/))) d.open.push(...m[1].split(/,\s*/))
    else if ((m = line.match(new RegExp(`^(${FACT_LABELS.join('|')}):\\s*(.+)$`)))) d.facts.push({ label: m[1], value: m[2] })
    else d.summary.push(line.trim())
  }
  return d
}

const norm = (s) => (s || '').trim().toLowerCase()
/** Board member a lineup name refers to (full name, then first name). */
function findMember(members, name) {
  return members.find((m) => norm(nameOf(m)) === norm(name))
    || members.find((m) => norm(nameOf(m)).split(/\s+/)[0] === norm(name).split(/\s+/)[0])
}

/**
 * Everyone who matters for a gig, one row per board member:
 * status = their latest answer, or 'listed' (shown as "Confirmed on call": named in the lineup, no answer
 * yet), or 'none'. `clash` = in the lineup but answered Maybe/Out.
 */
function peopleFor(gig, members) {
  const state = answerState(gig)
  const listed = new Map()
  for (const l of parseDetails(gig.details).lineup) {
    const m = findMember(members, l.name)
    if (m) listed.set(m.id, l.role)
  }
  return members.map((m) => {
    const e = state.get(m.id)
    const status = e ? e.current.answer : listed.has(m.id) ? 'listed' : 'none'
    return { m, e, status, role: listed.get(m.id) || '', listed: listed.has(m.id), clash: listed.has(m.id) && e && e.current.answer !== 'in' }
  })
}

function gigCounts(gig, members = []) {
  const c = { in: 0, maybe: 0, out: 0, listed: 0, changed: 0 }
  for (const p of peopleFor(gig, members)) {
    if (p.status !== 'none') c[p.status]++
    if (p.e?.changedFrom) c.changed++
  }
  return c
}
const countLine = (c) => [
  c.in && `${c.in} in`, c.maybe && `${c.maybe} maybe`, c.out && `${c.out} out`,
  c.listed && `${c.listed} confirmed on call`,
].filter(Boolean).join(' · ') || 'no answers yet'

/** Title without repeated or placeholder parts ("Wedding · Wedding · 5-piece" → "Wedding · 5-piece"). */
function gigTitle(g) {
  const seen = new Set()
  const parts = (g.title || '').split(/\s+·\s+/).filter((p) => {
    const k = p.trim().toLowerCase()
    if (!k || k === 'unknown' || seen.has(k)) return false
    seen.add(k); return true
  })
  return parts.join(' · ') || 'Gig'
}

/** What the status means today: past confirmed = Played, past tentative = Unconfirmed. */
function gigPhase(g) {
  if (g.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled' }
  const past = g.gig_date < dayKey(new Date())
  if (past) return g.status === 'confirmed' ? { key: 'played', label: 'Played' } : { key: 'unconfirmed', label: 'Unconfirmed' }
  return { key: g.status, label: STATUS[g.status] }
}

/**
 * One line for lists: named answers if there are any, else the WhatsApp poll
 * counts (which never carry names), else "no answers yet". Cancelled gigs
 * show no counts.
 */
function gigLine(g, c) {
  if (g.status === 'cancelled') return 'Cancelled'
  const named = c.in + c.maybe + c.out + c.listed
  if (named) return countLine(c) + (c.changed ? ` · ${c.changed} changed` : '')
  const poll = parseDetails(g.details).facts.find((f) => f.label === 'Poll')
  return poll ? `Poll: ${poll.value} · names not recorded` : 'No answers yet'
}

/* ================================================================== */
/* Calendar + agenda                                                   */
/* ================================================================== */

export default function GigsView({ board, members, songs, profile, myRole, notify, onOpenSong }) {
  const [gigs, setGigs] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const today = dayKey(new Date())
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const [openId, setOpenId] = useState(null)
  const [editing, setEditing] = useState(null) // null | 'new' | gig
  const [onlyMine, setOnlyMine] = useState(false)
  const [importing, setImporting] = useState(false)
  const canAdmin = myRole === 'owner' || myRole === 'admin'
  const myMembership = members.find((m) => m.user_id === profile.id)

  // A phone can keep an old copy of the app open for days. When a newer
  // deploy is out, say so on the Gigs tab so nobody reads stale screens.
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const mine = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src')
    if (!mine) return undefined // dev server: nothing to compare
    const check = () => fetch('/', { cache: 'no-store' }).then((r) => r.text()).then((html) => {
      const live = html.match(/\/assets\/index-[^"']+\.js/)?.[0]
      if (live && !mine.endsWith(live)) setStale(true)
    }).catch(() => {})
    check()
    const onFocus = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onFocus)
    return () => document.removeEventListener('visibilitychange', onFocus)
  }, [])

  const load = useCallback(() => {
    api.fetchGigs(board.id)
      .then((g) => { setGigs(g); setLoadError(null) })
      .catch((e) => setLoadError(e.message))
  }, [board.id])
  useEffect(() => { load() }, [load])

  // First load: jump to the month of the next upcoming gig.
  const [jumped, setJumped] = useState(false)
  useEffect(() => {
    if (jumped || !gigs) return
    setJumped(true)
    const next = gigs.find((g) => g.gig_date >= today && g.status !== 'cancelled')
    if (next) {
      const d = parseDay(next.gig_date)
      setCursor({ y: d.getFullYear(), m: d.getMonth() })
    }
  }, [gigs, jumped, today])

  if (loadError) {
    return (
      <div className="gigs-empty">
        <CalendarDays size={22} />
        <p>Gigs couldn't load: {loadError}</p>
        <p className="dim tiny">If this says a table doesn't exist, the gigs database update hasn't been applied here yet.</p>
      </div>
    )
  }
  if (!gigs) return <div className="dim gigs-empty">Loading gigs…</div>

  const isMine = (g) => {
    const me = peopleFor(g, members).find((p) => p.m.id === myMembership?.id)
    return !!me && ['in', 'maybe', 'listed'].includes(me.status)
  }
  const visible = onlyMine ? gigs.filter(isMine) : gigs

  const first = new Date(cursor.y, cursor.m, 1, 12)
  const lead = (first.getDay() + 6) % 7
  const daysIn = new Date(cursor.y, cursor.m + 1, 0).getDate()
  const cells = Math.ceil((lead + daysIn) / 7) * 7
  const monthGigs = visible.filter((g) => {
    const d = parseDay(g.gig_date)
    return d.getFullYear() === cursor.y && d.getMonth() === cursor.m
  })
  const shift = (n) => setCursor(({ y, m }) => {
    const d = new Date(y, m + n, 1)
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const openGig = gigs.find((g) => g.id === openId)

  return (
    <div className="gigs">
      {stale && (
        <div className="gstale">
          <span>A newer version of the gig calendar is out.</span>
          <button className="btn btn-primary tiny-btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <div className="gigs-bar">
        <div className="row gap">
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <h2 className="gigs-month">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} /></button>
          <button className="btn btn-ghost" onClick={() => {
            const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() })
          }}>Today</button>
        </div>
        <div className="row gap">
          <div className="seg" role="group" aria-label="Whose gigs">
            <button className={!onlyMine ? 'on' : ''} onClick={() => setOnlyMine(false)}>Everyone</button>
            <button className={onlyMine ? 'on' : ''} onClick={() => setOnlyMine(true)}>My gigs</button>
          </div>
          {canAdmin && (
            <button className="btn btn-ghost" onClick={() => setImporting(true)} title="Add gigs and answers from a WhatsApp chat export">
              <FileUp size={15} /> Import from chat
            </button>
          )}
          {canAdmin && (
            <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> Add gig</button>
          )}
        </div>
      </div>

      <div className="gcal" role="grid" aria-label="Gig calendar">
        {DOW.map((d) => <div key={d} className="gcal-dow">{d}</div>)}
        {Array.from({ length: cells }, (_, i) => {
          const d = new Date(cursor.y, cursor.m, 1 - lead + i, 12)
          const k = dayKey(d)
          const out = d.getMonth() !== cursor.m
          const dayGigs = visible.filter((g) => g.gig_date === k)
          return (
            <div key={k} className={`gcal-cell ${out ? 'out' : ''} ${k === today ? 'today' : ''}`}>
              <span className="gcal-n">{d.getDate()}</span>
              {dayGigs.map((g) => {
                const c = gigCounts(g, members)
                return (
                  <button key={g.id} className={`gpill st-${gigPhase(g).key}`} onClick={() => setOpenId(g.id)}
                    title={`${gigTitle(g)} · ${gigPhase(g).label} · ${gigLine(g, c)}`}>
                    {c.changed > 0 && <span className="gpill-flag" aria-label="answers changed">↺</span>}
                    {gigTitle(g)}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="gigs-legend dim tiny">
        <span className="lg st-confirmed">Confirmed</span>
        <span className="lg st-tentative">Tentative</span>
        <span className="lg st-cancelled">Cancelled</span>
        <span>↺ someone changed their answer</span>
      </div>

      <div className="gagenda">
        {monthGigs.length === 0 && (
          <div className="dim tiny gagenda-empty">
            {gigs.length === 0
              ? (canAdmin ? 'No gigs yet. Add the first one with "Add gig".' : 'No gigs yet. The owner or an admin adds them.')
              : 'Nothing this month.'}
          </div>
        )}
        {monthGigs.map((g) => {
          const c = gigCounts(g, members)
          const mine = answerState(g).get(myMembership?.id)?.current?.answer
          return (
            <button key={g.id} className="grow" onClick={() => setOpenId(g.id)}>
              <span className="grow-date">
                <b>{parseDay(g.gig_date).getDate()}</b>
                <small>{fmtDay(g.gig_date, { weekday: 'short' })}</small>
              </span>
              <span className="grow-main">
                <strong className={g.status === 'cancelled' ? 'struck' : ''}>{gigTitle(g)}{g.venue ? ` · ${g.venue}` : ''}</strong>
                <span className="dim tiny">
                  {gigLine(g, c)}
                  {g.gig_songs.length ? ` · ${g.gig_songs.length} songs` : ''}
                </span>
              </span>
              <span className="row gap">
                {mine && <span className={`ans ans-${mine}`}>You: {ANSWER[mine]}</span>}
                <span className={`gstatus st-${gigPhase(g).key}`}>{gigPhase(g).label}</span>
              </span>
            </button>
          )
        })}
      </div>

      {openGig && (
        <GigModal
          gig={openGig}
          allGigs={gigs}
          members={members}
          songs={songs}
          profile={profile}
          canAdmin={canAdmin}
          notify={notify}
          onChanged={load}
          onClose={() => setOpenId(null)}
          onEdit={() => setEditing(openGig)}
          onOpenSong={onOpenSong}
        />
      )}
      {importing && (
        <GigImportModal
          board={board}
          members={members}
          gigs={gigs}
          profile={profile}
          notify={notify}
          onClose={() => setImporting(false)}
          onDone={() => { setImporting(false); load() }}
        />
      )}
      {editing && (
        <GigFormModal
          gig={editing === 'new' ? null : editing}
          boardId={board.id}
          profile={profile}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={(g) => {
            setEditing(null); load()
            if (g) {
              setOpenId(g.id)
              const d = parseDay(g.gig_date)
              setCursor({ y: d.getFullYear(), m: d.getMonth() })
            }
          }}
        />
      )}
    </div>
  )
}

/* ================================================================== */
/* Add / edit gig                                                      */
/* ================================================================== */

function GigFormModal({ gig, boardId, profile, notify, onClose, onSaved }) {
  const [date, setDate] = useState(gig?.gig_date || dayKey(new Date()))
  const [title, setTitle] = useState(gig?.title || '')
  const [venue, setVenue] = useState(gig?.venue || '')
  const [status, setStatus] = useState(gig?.status || 'tentative')
  const [details, setDetails] = useState(gig?.details || '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    const fields = {
      gig_date: date, title: title.trim(), venue: venue.trim() || null,
      status, details: details.trim() || null,
    }
    try {
      if (gig) { await api.updateGig(gig.id, fields); onSaved(null) }
      else onSaved(await api.createGig(boardId, profile.id, fields))
    } catch (e) { notify(e.message); setBusy(false) }
  }

  return (
    <Modal title={gig ? 'Edit gig' : 'Add gig'} onClose={onClose}>
      <div className="grid-2">
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Gig</span>
        <input autoFocus={!gig} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Wedding, Bhopal · 5-piece" />
      </label>
      <label className="field">
        <span>Venue (optional)</span>
        <input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Taj Lakefront" />
      </label>
      <label className="field">
        <span>Details (optional)</span>
        <textarea rows={8} value={details} onChange={(e) => setDetails(e.target.value)}
          placeholder={'One-line summary\nLineup: Name (vocals), Name (guitar)\nOpen: Bassist\nTravel: Flight, leave 2 days early\nDress: Formals\nSchedule:\n  4:00pm — Soundcheck\n  9:00pm — Band'} />
        <span className="dim tiny">Lines starting Lineup:, Open:, Travel:, Dress:, Poll: and an indented Schedule: show as their own sections.</span>
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !title.trim() || !date} onClick={save}>
          {gig ? 'Save changes' : 'Add gig'}
        </button>
      </div>
    </Modal>
  )
}

/* ================================================================== */
/* One gig: who's in, answers, setlist, notes                          */
/* ================================================================== */

function GigModal({ gig, allGigs, members, songs, profile, canAdmin, notify, onChanged, onClose, onEdit, onOpenSong }) {
  const byId = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members])
  const byUser = useMemo(() => Object.fromEntries(members.filter((m) => m.user_id).map((m) => [m.user_id, m])), [members])
  const myMembership = byUser[profile.id]
  const [expanded, setExpanded] = useState(null)
  const [editSet, setEditSet] = useState(false)

  const d = parseDetails(gig.details)
  const order = { in: 0, maybe: 1, listed: 2, out: 3, none: 4 }
  const everyone = peopleFor(gig, members).sort((a, b) =>
    (b.listed - a.listed) || (order[a.status] - order[b.status]))
  const counts = gigCounts(gig, members)
  const lineup = everyone.filter((p) => p.listed)
  const others = everyone.filter((p) => !p.listed && p.status !== 'none')
  const silent = everyone.filter((p) => p.status === 'none')

  // Flags a gig manager must act on before the show.
  const flags = []
  if (d.needsCheck) flags.push({ tone: 'warn', text: 'Date or booking unclear in the chat. Confirm with the client.' })
  for (const o of d.open) flags.push({ tone: 'warn', text: `Need: ${o}` })
  for (const p of everyone.filter((x) => x.clash)) {
    flags.push({ tone: 'hot', text: `${nameOf(p.m)} is in the lineup but said ${ANSWER[p.e.current.answer]}` })
  }
  const playing = (g, mid) => {
    const p = peopleFor(g, members).find((x) => x.m.id === mid)
    return p && ['in', 'listed'].includes(p.status)
  }
  // Back-to-back: people playing this gig who also play the day before/after.
  const mine = everyone.filter((x) => ['in', 'listed'].includes(x.status))
  for (const g of allGigs) {
    if (g.id === gig.id || g.status === 'cancelled') continue
    const gap = Math.round((parseDay(g.gig_date) - parseDay(gig.gig_date)) / 86400000)
    if (Math.abs(gap) > 1) continue
    const both = mine.filter((p) => playing(g, p.m.id)).map((p) => nameOf(p.m))
    if (!both.length) continue
    const when = gap === 0 ? 'the same day' : gap === 1 ? 'the next day' : 'the day before'
    flags.push({ tone: 'info', text: `${both.join(', ')} also ${both.length > 1 ? 'play' : 'plays'} ${gigTitle(g)} ${when} (${fmtDay(g.gig_date, { day: 'numeric', month: 'short' })})` })
  }

  const days = Math.round((parseDay(gig.gig_date) - parseDay(dayKey(new Date()))) / 86400000)
  const countdown = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 0 ? `In ${days} days` : days === -1 ? 'Yesterday' : `${-days} days ago`
  const setlist = gig.gig_songs.map((gs) => songs.find((s) => s.id === gs.song_id)).filter(Boolean)

  // One "story so far" timeline: chat notes + answers, oldest first. Answers
  // recorded together (same moment, answer and quote — e.g. a lineup message)
  // collapse into one entry with several names.
  const story = useMemo(() => {
    const items = []
    const gigDay = parseDay(gig.gig_date)
    for (const l of d.chat) {
      const m = l.match(/^([^,]+),\s*(\d{1,2} [A-Za-z]{3})[a-z]*:\s*(.*)$/)
      if (!m) { items.push({ kind: 'chat', at: null, who: '', text: l }); continue }
      let at = new Date(`${m[2]} ${gigDay.getFullYear()} 12:00`)
      if (Number.isNaN(at.getTime())) at = null
      else if (at > gigDay) at.setFullYear(at.getFullYear() - 1)
      items.push({ kind: 'chat', at, who: m[1].trim(), text: m[3] })
    }
    const groups = new Map()
    for (const a of gig.gig_answers || []) {
      const k = `${a.said_at}|${a.answer}|${a.note || ''}`
      const g = groups.get(k) || { kind: 'ans', at: new Date(a.said_at || a.created_at), answer: a.answer, note: a.note, source: a.source, names: [] }
      g.names.push(byId[a.membership_id] ? nameOf(byId[a.membership_id]) : (a.person_name || 'Someone'))
      groups.set(k, g)
    }
    // A chat note the answers already quote (same day) is shown once, on the answers.
    const flat = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const sameDay = (x, y) => x && y && x.toDateString() === y.toDateString()
    const answered = [...groups.values()]
    const keep = items.filter((c) => {
      const key = flat(c.text).slice(0, 24)
      return !key || !answered.some((g) => sameDay(g.at, c.at) && flat(g.note).includes(key))
    })
    keep.push(...answered)
    return keep.sort((a, z) => (a.at?.getTime() ?? 0) - (z.at?.getTime() ?? 0))
  }, [gig, members]) // eslint-disable-line react-hooks/exhaustive-deps
  const [storyAll, setStoryAll] = useState(false)
  const shownStory = storyAll ? story : story.slice(-5)
  const factIcon = { Travel: Plane, Dress: Shirt, Poll: BarChart3, Venue: MapPin }
  const gd = parseDay(gig.gig_date)

  const personRow = (p) => {
    const { m, e, status, role } = p
    const cur = e?.current
    const open = expanded === m.id
    return (
      <li key={m.id} className={`grow-p ans-${status} ${open ? 'open' : ''}`}>
        <button className="grow-p-btn" onClick={() => setExpanded(open ? null : m.id)} aria-expanded={open}>
          <span className={`avatar sm ${m.user_id ? '' : 'pending'}`} style={{ '--c': m.profiles?.color || '#39424e' }}
            title={m.user_id ? undefined : 'Not on Jam-Meet yet'}>{initials(nameOf(m))}</span>
          <span className="grow-p-who">
            <b>{nameOf(m)}</b>
            <span className="dim tiny">{role || '\u00a0'}</span>
          </span>
          <span className="grow-p-ans">
            <span className={`ans ans-${status}`}>{cur ? ANSWER[cur.answer] : status === 'listed' ? 'Confirmed on call' : 'No answer'}</span>
            <span className="dim tiny">
              {cur ? `${fmtStamp(cur.said_at || cur.created_at)}${cur.source === 'chat' ? ' · chat' : ''}`
                : ''}
            </span>
          </span>
        </button>
        {e?.changedFrom && <span className="was">was {ANSWER[e.changedFrom]}</span>}
        {open && (
          <div className="gtrail">
            {e ? <AnswerList rows={[...e.history].reverse()} byId={byId} byUser={byUser} showName={false} />
              : <p className="dim tiny">{status === 'listed' ? 'Confirmed their availability to the bandleader on a call or in person. Nothing recorded in the app yet.' : 'No answer yet.'}</p>}
          </div>
        )}
      </li>
    )
  }

  return (
    <Modal title={gigTitle(gig)} onClose={onClose} wide>
      <div className="ghero">
        <div className={`ghero-date st-${gigPhase(gig).key}`}>
          <span>{gd.toLocaleDateString(undefined, { weekday: 'short' })}</span>
          <b>{gd.getDate()}</b>
          <span>{gd.toLocaleDateString(undefined, { month: 'short' })}</span>
        </div>
        <div className="ghero-main">
          <div className="row gap wrap">
            <span className={`gstatus st-${gigPhase(gig).key}`}>{gigPhase(gig).label}</span>
            <span className="ghero-count"><Clock size={12} /> {countdown}</span>
          </div>
          {gig.venue && <div className="ghero-venue"><MapPin size={13} /> {gig.venue}</div>}
          <div className="ghero-tally">
            {counts.in > 0 && <span className="ans ans-in">{counts.in} in</span>}
            {counts.maybe > 0 && <span className="ans ans-maybe">{counts.maybe} maybe</span>}
            {counts.listed > 0 && <span className="ans ans-listed">{counts.listed} confirmed on call</span>}
            {counts.out > 0 && <span className="ans ans-out">{counts.out} out</span>}
            {!counts.in && !counts.maybe && !counts.listed && !counts.out && <span className="dim tiny">No answers yet</span>}
          </div>
        </div>
        {canAdmin && (
          <div className="ghero-actions">
            <button className="icon-btn" title="Edit gig" onClick={onEdit}><Pencil size={14} /></button>
            <button className="icon-btn danger" title="Delete gig" onClick={async () => {
              if (!window.confirm(`Delete "${gigTitle(gig)}"? Its answers, setlist and notes go with it.`)) return
              try { await api.deleteGig(gig.id); onClose(); onChanged() } catch (e) { notify(e.message) }
            }}><Trash2 size={14} /></button>
          </div>
        )}
      </div>

      {d.summary.length > 0 && <p className="gsummary">{d.summary.join(' ')}</p>}

      {d.facts.some((f) => f.label !== 'Poll') && (
        <div className="gchips">
          {d.facts.filter((f) => f.label !== 'Poll').map((f, i) => {
            const Icon = factIcon[f.label] || CalendarDays
            return <span key={i} className="gchip" title={f.label}><Icon size={13} /><span><i>{f.label}</i> {f.value}</span></span>
          })}
        </div>
      )}

      {flags.length > 0 && (
        <ul className="gflags">
          {flags.map((f, i) => <li key={i} className={`gflag gflag-${f.tone}`}>{f.text}</li>)}
        </ul>
      )}

      <section className="panel">
        <h3>Who's playing</h3>
        {lineup.length === 0 && others.length === 0 && (
          <p className="dim tiny">No lineup or answers yet{d.facts.some((f) => f.label === 'Poll') ? ' (poll counts are below; WhatsApp polls don\'t record names)' : ''}.</p>
        )}
        <ul className="gpeople-rows">
          {lineup.map(personRow)}
          {d.open.map((o) => (
            <li key={`open-${o}`} className="grow-p grow-open">
              <span className="avatar sm">?</span>
              <span className="grow-p-who"><b>{o}</b><span className="dim tiny">open slot</span></span>
            </li>
          ))}
        </ul>
        {counts.listed > 0 && (
          <p className="dim tiny gnote">Confirmed on call = they confirmed their availability to the bandleader by phone or in person. They haven't answered in the app yet.</p>
        )}
        {others.length > 0 && (
          <>
            {lineup.length > 0 && <h4 className="gsub">Also answered</h4>}
            <ul className="gpeople-rows">{others.map(personRow)}</ul>
          </>
        )}
        {silent.length > 0 && (
          <p className="gsilent">
            <span className="dim tiny">Not answered yet ({silent.length}):</span>{' '}
            {silent.map((p) => nameOf(p.m)).join(', ')}
          </p>
        )}
        <AnswerBox gig={gig} members={members} byUser={byUser} myMembership={myMembership} profile={profile}
          canAdmin={canAdmin} notify={notify} onSaved={(mid) => { setExpanded(mid); onChanged() }} />
      </section>

      <PollCard gig={gig} poll={d.facts.find((f) => f.label === 'Poll')} members={members} profile={profile}
        canAdmin={canAdmin} notify={notify} onChanged={onChanged} />

      {d.schedule.length > 0 && (
        <section className="panel">
          <h3><Clock size={14} /> Run of show</h3>
          <ol className="gsched">
            {d.schedule.map((x, i) => <li key={i}><b>{x.t || '—'}</b><span>{x.what}</span></li>)}
          </ol>
        </section>
      )}

      <section className="panel">
        <h3><ListMusic size={14} /> Setlist {setlist.length > 0 && <span className="dim tiny">· {setlist.length} songs</span>}</h3>
        {editSet ? (
          <SetlistEditor gig={gig} songs={songs} notify={notify}
            onDone={() => { setEditSet(false); onChanged() }} onCancel={() => setEditSet(false)} />
        ) : (
          <>
            {setlist.length === 0 && <p className="dim tiny">No setlist yet.</p>}
            <ol className="gsetlist">
              {setlist.map((s) => {
                const r = songReadiness(s, members)
                const lane = LANES.find((l) => l.id === r.lane)
                const myP = (s.practice || []).find((p) => p.user_id === profile.id)
                return (
                  <li key={s.id}>
                    <button className="gsong" onClick={() => { onClose(); onOpenSong(s.id) }} title="Open to rehearse">
                      <span className="gsong-title">{s.title}</span>
                      <span className={`glane lane-${lane.tone}`}>{lane.label}{r.avg != null ? ` · ${r.avg.toFixed(1)}` : ''}</span>
                      <span className="dim tiny">You: {myP?.confidence != null ? `${myP.confidence}/10` : '—'}</span>
                      <Play size={13} />
                    </button>
                  </li>
                )
              })}
            </ol>
            {canAdmin && (
              <button className="btn btn-ghost tiny-btn" onClick={() => setEditSet(true)}>
                <Pencil size={13} /> {setlist.length ? 'Edit setlist' : 'Pick songs'}
              </button>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h3><History size={14} /> Story so far <span className="dim tiny">· who said what, when</span></h3>
        {story.length === 0 && <p className="dim tiny">Nothing recorded yet.</p>}
        {story.length > shownStory.length && (
          <button className="btn btn-ghost tiny-btn" onClick={() => setStoryAll(true)}>Show {story.length - shownStory.length} earlier</button>
        )}
        <ol className="gstory">
          {shownStory.map((it, i) => {
            const prev = shownStory[i - 1]
            const day = it.at ? it.at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''
            const prevDay = prev?.at ? prev.at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''
            return (
              <li key={i} className={`gstory-item ${it.kind === 'ans' ? `ans-${it.answer}` : ''}`}>
                <span className="gstory-day">{day !== prevDay ? day : ''}</span>
                <span className="gstory-dot" />
                <div className="gstory-body">
                  {it.kind === 'ans' ? (
                    <>
                      <div><span className={`ans ans-${it.answer}`}>{ANSWER[it.answer]}</span> <b>{it.names.join(', ')}</b>
                        <span className="dim tiny"> · {it.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{it.source === 'chat' ? ' · chat' : ''}</span></div>
                      {it.note && <div className="gstory-quote">“{it.note}”</div>}
                    </>
                  ) : (
                    <div>{it.who && <b className="gstory-who">{it.who}: </b>}{it.text}</div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <GigNotes gig={gig} profile={profile} canAdmin={canAdmin} notify={notify} />
    </Modal>
  )
}

/*
 * WhatsApp poll with names. Exports only carry vote counts, so owner/admins
 * copy the names from WhatsApp (poll → View votes). Each vote is saved as a
 * chat answer whose note starts with POLL_NOTE, dated to the poll's day.
 */
const POLL_NOTE = 'WhatsApp poll'
function pollFacts(gig, poll) {
  const m = poll?.value.match(/(\d+)\s*available\s*·\s*(\d+)\s*no\s*\((\d{1,2})\s+([A-Za-z]{3})/i)
  if (!m) return null
  const gd = parseDay(gig.gig_date)
  let day = new Date(`${m[3]} ${m[4]} ${gd.getFullYear()} 12:00`)
  if (Number.isNaN(day.getTime())) day = new Date()
  else if (day > gd) day.setFullYear(day.getFullYear() - 1)
  return { yes: +m[1], no: +m[2], on: `${m[3]} ${m[4]}`, at: day.toISOString() }
}

function PollCard({ gig, poll, members, profile, canAdmin, notify, onChanged }) {
  const facts = pollFacts(gig, poll)
  const [editing, setEditing] = useState(false)
  const [votes, setVotes] = useState({})
  const [busy, setBusy] = useState(false)
  if (!facts) return null

  // Latest poll vote per person (their other answers don't count here).
  const recorded = {}
  for (const a of gig.gig_answers || []) {
    if (a.source === 'chat' && a.note?.startsWith(POLL_NOTE) && a.membership_id) recorded[a.membership_id] = a.answer
  }
  const names = (ans) => members.filter((m) => recorded[m.id] === ans).map(nameOf)
  const yesNames = names('in'), noNames = names('out')
  const missingYes = Math.max(0, facts.yes - yesNames.length), missingNo = Math.max(0, facts.no - noNames.length)

  const open = () => { setVotes({ ...recorded }); setEditing(true) }
  const pickedYes = Object.values(votes).filter((v) => v === 'in').length
  const pickedNo = Object.values(votes).filter((v) => v === 'out').length
  const save = async () => {
    const rows = Object.entries(votes).filter(([mid, v]) => v && v !== recorded[mid]).map(([mid, v]) => ({
      gig_id: gig.id, membership_id: mid, answer: v, said_at: facts.at,
      note: `${POLL_NOTE} (${facts.on}): voted ${v === 'in' ? 'Available' : 'No'}`,
    }))
    if (!rows.length) { setEditing(false); return }
    setBusy(true)
    try { await api.addChatAnswers(rows, profile.id); setEditing(false); onChanged() }
    catch (e) { notify(e.message) } finally { setBusy(false) }
  }

  return (
    <section className="panel gpoll">
      <h3><BarChart3 size={14} /> WhatsApp poll <span className="dim tiny">· {facts.on}</span></h3>
      {!editing ? (
        <>
          <div className="gpoll-row">
            <span className="ans ans-in">{facts.yes} available</span>
            <span className="gpoll-names">
              {yesNames.join(', ')}{yesNames.length && missingYes ? ' · ' : ''}
              {missingYes > 0 && <span className="dim">{missingYes} not named yet</span>}
              {!facts.yes && <span className="dim">—</span>}
            </span>
          </div>
          <div className="gpoll-row">
            <span className="ans ans-out">{facts.no} no</span>
            <span className="gpoll-names">
              {noNames.join(', ')}{noNames.length && missingNo ? ' · ' : ''}
              {missingNo > 0 && <span className="dim">{missingNo} not named yet</span>}
              {!facts.no && <span className="dim">—</span>}
            </span>
          </div>
          {(missingYes > 0 || missingNo > 0) && (
            <p className="dim tiny">WhatsApp exports only keep the counts. {canAdmin ? 'Open the poll in WhatsApp → View votes, then add the names here.' : 'The owner or an admin can add the names.'}</p>
          )}
          {canAdmin && (
            <button className="btn btn-ghost tiny-btn" onClick={open}><Pencil size={13} /> {yesNames.length || noNames.length ? 'Edit names' : 'Add names from WhatsApp'}</button>
          )}
        </>
      ) : (
        <>
          <p className="dim tiny">In WhatsApp: open the poll → <b>View votes</b>. Tick each person here.</p>
          <ul className="gpoll-edit">
            {members.map((m) => (
              <li key={m.id}>
                <span>{nameOf(m)}</span>
                <span className="seg seg-3">
                  {[['in', 'Available'], ['out', 'No'], ['', '—']].map(([v, l]) => (
                    <button key={l} className={`ans-btn ${v ? `ans-${v}` : ''} ${(votes[m.id] || '') === v ? 'on' : ''}`}
                      disabled={!!recorded[m.id] && !v} title={recorded[m.id] && !v ? 'Saved votes stay on record; pick the other option to change it' : undefined}
                      onClick={() => setVotes({ ...votes, [m.id]: v })}>{l}</button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className={`tiny ${pickedYes > facts.yes || pickedNo > facts.no ? 'gwarn' : 'dim'}`}>
            Ticked {pickedYes} available (poll: {facts.yes}) · {pickedNo} no (poll: {facts.no})
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>Save votes</button>
          </div>
        </>
      )}
    </section>
  )
}

/** In / Maybe / Out for yourself (or, for owner/admins, anyone on the board). */
function AnswerBox({ gig, members, byUser, myMembership, profile, canAdmin, notify, onSaved }) {
  const state = answerState(gig)
  const [who, setWho] = useState(myMembership?.id || '')
  const [pick, setPick] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const whoState = state.get(who)
  useEffect(() => { setPick(whoState?.current?.answer || null); setNote('') }, [who]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!pick || !who) return
    const last = whoState?.current
    if (last && last.answer === pick && !note.trim()) { notify(`Already marked ${ANSWER[pick]}.`); return }
    setBusy(true)
    try { await api.answerGig(gig.id, who, pick, note.trim(), profile.id); setNote(''); onSaved(who) }
    catch (e) { notify(e.message) } finally { setBusy(false) }
  }
  const self = who === myMembership?.id
  return (
    <div className="ganswer">
      <div className="row gap wrap">
        <span className="ganswer-q">{self ? 'Are you in?' : 'Answer for'}</span>
        {canAdmin && (
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Whose answer">
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.user_id === profile.id ? 'Me' : nameOf(m)}{m.user_id ? '' : ' (not joined)'}</option>
            ))}
          </select>
        )}
      </div>
      <div className="seg seg-3" role="radiogroup" aria-label="Availability">
        {['in', 'maybe', 'out'].map((a) => (
          <button key={a} role="radio" aria-checked={pick === a}
            className={`ans-btn ans-${a} ${pick === a ? 'on' : ''}`} onClick={() => setPick(a)}>{ANSWER[a]}</button>
        ))}
      </div>
      {pick && (
        <div className="row gap">
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Reason or condition (optional)" />
          <button className="btn btn-primary" disabled={busy} onClick={save}>Save</button>
        </div>
      )}
      <span className="dim tiny">Every change is kept with its time.</span>
    </div>
  )
}

function AnswerList({ rows, byId, byUser, showName }) {
  return (
    <ol className="glog">
      {rows.map((a) => {
        const person = byId[a.membership_id]
        const setter = a.source !== 'chat' && a.set_by && a.set_by !== a.user_id ? byUser[a.set_by] : null
        return (
          <li key={a.id}>
            <span className={`ans ans-${a.answer}`}>{ANSWER[a.answer]}</span>
            <span>
              <span className="dim tiny">
                {showName && <b className="glog-name">{person ? nameOf(person) : (a.person_name || 'Someone')}</b>}
                {showName && ' · '}{fmtStamp(a.said_at || a.created_at)}
                {a.source === 'chat' && <span className="src-chat" title="Taken from the WhatsApp chat">in the chat</span>}
                {setter && ` · set by ${nameOf(setter)}`}
              </span>
              {a.note && <span className="glog-note">“{a.note}”</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function SetlistEditor({ gig, songs, notify, onDone, onCancel }) {
  const [ids, setIds] = useState(gig.gig_songs.map((g) => g.song_id))
  const [busy, setBusy] = useState(false)
  const toggle = (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  const move = (i, d) => setIds((cur) => {
    const next = [...cur]; const j = i + d
    if (j < 0 || j >= next.length) return cur
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })
  const chosen = ids.map((id) => songs.find((s) => s.id === id)).filter(Boolean)
  const rest = songs.filter((s) => !ids.includes(s.id))
  return (
    <div className="gset-edit">
      <p className="dim tiny">Tick songs in the order you'll play them. Use the arrows to reorder.</p>
      <ol className="gsetlist">
        {chosen.map((s, i) => (
          <li key={s.id} className="gset-row">
            <label className="row gap"><input type="checkbox" checked onChange={() => toggle(s.id)} /> {s.title}</label>
            <span className="row">
              <button className="icon-btn" onClick={() => move(i, -1)} aria-label={`Move ${s.title} up`}><ArrowUp size={13} /></button>
              <button className="icon-btn" onClick={() => move(i, 1)} aria-label={`Move ${s.title} down`}><ArrowDown size={13} /></button>
            </span>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <div className="gset-rest">
          {rest.map((s) => (
            <label key={s.id} className="row gap tiny">
              <input type="checkbox" checked={false} onChange={() => toggle(s.id)} /> {s.title}
            </label>
          ))}
        </div>
      )}
      {songs.length === 0 && <p className="dim tiny">This board has no songs yet. Add songs first.</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await api.setGigSetlist(gig.id, ids); onDone() } catch (e) { notify(e.message); setBusy(false) }
        }}>Save setlist</button>
      </div>
    </div>
  )
}

function GigNotes({ gig, profile, canAdmin, notify }) {
  const [notes, setNotes] = useState(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    api.fetchGigNotes(gig.id).then(setNotes).catch((e) => notify(e.message))
  }, [gig.id, notify])
  useEffect(() => { load() }, [load])

  const send = async () => {
    if (!body.trim()) return
    setBusy(true)
    try { await api.addGigNote(gig.id, profile.id, body.trim()); setBody(''); load() }
    catch (e) { notify(e.message) } finally { setBusy(false) }
  }

  return (
    <section className="panel">
      <h3><MessageSquare size={14} /> Notes for this gig</h3>
      <div className="comments">
        {!notes && <span className="dim tiny">Loading…</span>}
        {notes && notes.length === 0 && <span className="dim tiny">No notes yet. Timings, dress, travel, gear go here.</span>}
        {(notes || []).map((n) => (
          <div key={n.id} className="comment">
            <span className="avatar sm" style={{ '--c': n.profiles?.color || '#39424e' }}>{initials(n.profiles?.display_name || '?')}</span>
            <div className="comment-body">
              <div className="comment-head">
                <strong>{n.profiles?.display_name || 'Someone'}</strong>
                <span className="dim tiny">{fmtStamp(n.created_at)}</span>
                {(n.user_id === profile.id || canAdmin) && (
                  <button className="icon-btn danger tiny-btn" title="Delete note" onClick={async () => {
                    try { await api.deleteGigNote(n.id); load() } catch (e) { notify(e.message) }
                  }}><X size={11} /></button>
                )}
              </div>
              <p>{n.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="comment-input">
        <input value={body} placeholder="Add a note for this gig…" onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={send} aria-label="Send note"><Send size={14} /></button>
      </div>
    </section>
  )
}
