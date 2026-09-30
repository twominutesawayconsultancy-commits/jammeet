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
 * Split a gig's details text into the lineup, the "From the chat" notes and
 * everything else (timings, dress, travel…). The chat importer writes
 * "Lineup: A (vocals), B (guitar)" and an indented "From the chat:" block;
 * the lineup is shown in "Who's in", so it's left out of the details text.
 */
function splitDetails(details) {
  const lineup = [], chat = [], rest = []
  let inChat = false
  for (const line of (details || '').split('\n')) {
    if (inChat && /^\s+\S/.test(line)) { chat.push(line.trim()); continue }
    inChat = false
    const lu = line.match(/^Lineup:\s*(.+)$/)
    if (lu) {
      for (const part of lu[1].split(/,\s*/)) {
        const m = part.match(/^(.*?)\s*(?:\(([^)]*)\))?$/)
        if (m && m[1]) lineup.push({ name: m[1].trim(), role: m[2]?.trim() || '' })
      }
    } else if (/^From the chat:\s*$/.test(line)) inChat = true
    else rest.push(line)
  }
  return { lineup, chat, rest: rest.join('\n').trim() }
}

const norm = (s) => (s || '').trim().toLowerCase()
/** Board member a lineup name refers to (full name, then first name). */
function findMember(members, name) {
  return members.find((m) => norm(nameOf(m)) === norm(name))
    || members.find((m) => norm(nameOf(m)).split(/\s+/)[0] === norm(name).split(/\s+/)[0])
}

/**
 * Everyone who matters for a gig, one row per board member:
 * status = their latest answer, or 'listed' (named in the lineup, no answer
 * yet), or 'none'. `clash` = in the lineup but answered Maybe/Out.
 */
function peopleFor(gig, members) {
  const state = answerState(gig)
  const listed = new Map()
  for (const l of splitDetails(gig.details).lineup) {
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
  c.listed && `${c.listed} listed`,
].filter(Boolean).join(' · ') || 'no answers yet'

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
                  <button key={g.id} className={`gpill st-${g.status}`} onClick={() => setOpenId(g.id)}
                    title={`${g.title} · ${STATUS[g.status]} · ${countLine(c)}`}>
                    {c.changed > 0 && <span className="gpill-flag" aria-label="answers changed">↺</span>}
                    {g.title}
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
                <strong>{g.title}{g.venue ? ` · ${g.venue}` : ''}</strong>
                <span className="dim tiny">
                  {countLine(c)}
                  {c.changed > 0 ? ` · ${c.changed} changed` : ''}
                  {g.gig_songs.length ? ` · ${g.gig_songs.length} songs` : ''}
                </span>
              </span>
              <span className="row gap">
                {mine && <span className={`ans ans-${mine}`}>You: {ANSWER[mine]}</span>}
                <span className={`gstatus st-${g.status}`}>{STATUS[g.status]}</span>
              </span>
            </button>
          )
        })}
      </div>

      {openGig && (
        <GigModal
          gig={openGig}
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
        <textarea rows={4} value={details} onChange={(e) => setDetails(e.target.value)}
          placeholder={'Soundcheck 4–6pm, band 9pm\nDress: formals, no blazers\nTravel: meet at Wilson\'s 2pm'} />
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

function GigModal({ gig, members, songs, profile, canAdmin, notify, onChanged, onClose, onEdit, onOpenSong }) {
  const byId = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members])
  const byUser = useMemo(() => Object.fromEntries(members.filter((m) => m.user_id).map((m) => [m.user_id, m])), [members])
  const myMembership = byUser[profile.id]
  const state = answerState(gig)
  const [expanded, setExpanded] = useState(null)
  const [who, setWho] = useState(myMembership?.id)
  const [pick, setPick] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [editSet, setEditSet] = useState(false)

  const whoState = state.get(who)
  useEffect(() => { setPick(whoState?.current?.answer || null); setNote('') }, [who]) // eslint-disable-line react-hooks/exhaustive-deps

  const [showAll, setShowAll] = useState(false)
  const order = { in: 0, maybe: 1, listed: 2, out: 3, none: 4 }
  const everyone = peopleFor(gig, members).sort((a, b) => order[a.status] - order[b.status])
  const counts = gigCounts(gig, members)
  const silent = everyone.filter((p) => p.status === 'none')
  const people = showAll ? everyone : everyone.filter((p) => p.status !== 'none')
  const clashes = everyone.filter((p) => p.clash)
  const { chat: chatNotes, rest: detailText } = splitDetails(gig.details)

  const saveAnswer = async () => {
    if (!pick) return
    const last = whoState?.current
    if (last && last.answer === pick && !note.trim()) { notify(`Already marked ${ANSWER[pick]}.`); return }
    setBusy(true)
    try {
      await api.answerGig(gig.id, who, pick, note.trim(), profile.id)
      setNote(''); setExpanded(who); onChanged()
    } catch (e) { notify(e.message) } finally { setBusy(false) }
  }

  const log = [...(gig.gig_answers || [])].reverse()
  const setlist = gig.gig_songs.map((gs) => songs.find((s) => s.id === gs.song_id)).filter(Boolean)

  return (
    <Modal title={gig.title} onClose={onClose} wide>
      <div className="gig-head">
        <div>
          <div className="gig-when">{fmtDay(gig.gig_date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
          {gig.venue && <div className="dim">{gig.venue}</div>}
        </div>
        <div className="row gap">
          <span className={`gstatus st-${gig.status}`}>{STATUS[gig.status]}</span>
          {canAdmin && <button className="btn btn-ghost" onClick={onEdit}><Pencil size={13} /> Edit</button>}
          {canAdmin && (
            <button className="icon-btn danger" title="Delete gig" onClick={async () => {
              if (!window.confirm(`Delete "${gig.title}"? Its answers, setlist and notes go with it.`)) return
              try { await api.deleteGig(gig.id); onClose(); onChanged() } catch (e) { notify(e.message) }
            }}><Trash2 size={14} /></button>
          )}
        </div>
      </div>
      {detailText && <p className="gig-details">{detailText}</p>}

      <div className="gig-grid">
        <section className="panel">
          <h3>Who's in <span className="dim tiny">· {countLine(counts)}</span></h3>
          <div className="gpeople">
            {people.map(({ m, e, status, role, clash }) => (
              <button key={m.id}
                className={`gperson ans-${status === 'listed' ? 'listed' : status} ${m.user_id ? '' : 'not-joined'} ${expanded === m.id ? 'open' : ''}`}
                onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                aria-expanded={expanded === m.id}
                title={m.user_id ? undefined : 'Not joined Jam-Meet yet'}>
                <span className="avatar sm" style={{ '--c': m.profiles?.color || '#39424e' }}>{initials(nameOf(m))}</span>
                <span>{nameOf(m)}{role && <i className="gperson-role"> {role}</i>}</span>
                <span className="gperson-ans">
                  {e ? `${ANSWER[e.current.answer]} · ${fmtShort(e.current.said_at || e.current.created_at)}`
                    : status === 'listed' ? 'Listed' : 'No answer'}
                </span>
                {e?.changedFrom && <span className="was">was {ANSWER[e.changedFrom]}</span>}
                {clash && <span className="gclash">in lineup</span>}
              </button>
            ))}
            {silent.length > 0 && (
              <button className="btn btn-ghost tiny-btn" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Hide' : `+${silent.length}`} not answered
              </button>
            )}
          </div>
          {counts.listed > 0 && (
            <p className="dim tiny">“Listed” = named in the bandleader's lineup but hasn't said In here yet.</p>
          )}
          {clashes.length > 0 && (
            <p className="galert">
              {clashes.map((p) => `${nameOf(p.m)} is in the lineup but said ${ANSWER[p.e.current.answer]}`).join('; ')}. Sort this out before the show.
            </p>
          )}
          {expanded && (
            <div className="gtrail">
              <strong>{nameOf(byId[expanded])}'s answers for this gig</strong>
              {state.get(expanded)
                ? <AnswerList rows={[...state.get(expanded).history].reverse()} byId={byId} byUser={byUser} showName={false} />
                : <p className="dim tiny">No answer yet.</p>}
            </div>
          )}

          <div className="ganswer">
            <div className="row gap wrap">
              {canAdmin ? (
                <label className="row gap tiny">
                  <span className="dim">Answer for</span>
                  <select value={who} onChange={(e) => setWho(e.target.value)}>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.user_id === profile.id ? 'Me' : nameOf(m)}{m.user_id ? '' : ' (not joined)'}</option>
                    ))}
                  </select>
                </label>
              ) : <span className="dim tiny">Your answer</span>}
            </div>
            <div className="seg seg-3" role="radiogroup" aria-label="Availability">
              {['in', 'maybe', 'out'].map((a) => (
                <button key={a} role="radio" aria-checked={pick === a}
                  className={`ans-btn ans-${a} ${pick === a ? 'on' : ''}`} onClick={() => setPick(a)}>
                  {ANSWER[a]}
                </button>
              ))}
            </div>
            <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason or condition (optional), e.g. only if we're back by 11pm" />
            <div className="row spread">
              <span className="dim tiny">Every change is kept with its time. Nothing is overwritten.</span>
              <button className="btn btn-primary" disabled={busy || !pick || !who} onClick={saveAnswer}>Save answer</button>
            </div>
          </div>
        </section>

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
                      <button className="gsong" onClick={() => { onClose(); onOpenSong(s.id) }}
                        title="Open to rehearse">
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
                <button className="btn btn-ghost" onClick={() => setEditSet(true)}>
                  <Pencil size={13} /> {setlist.length ? 'Edit setlist' : 'Pick songs'}
                </button>
              )}
            </>
          )}
        </section>
      </div>

      <section className="panel">
        <h3><History size={14} /> Answer log · who said what, when</h3>
        {log.length === 0
          ? <p className="dim tiny">No answers yet.</p>
          : <AnswerList rows={log} byId={byId} byUser={byUser} showName />}
      </section>

      {chatNotes.length > 0 && (
        <details className="panel gchat">
          <summary><h3><MessageSquare size={14} /> From the chat <span className="dim tiny">· {chatNotes.length}</span></h3></summary>
          <ul>{chatNotes.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </details>
      )}

      <GigNotes gig={gig} profile={profile} canAdmin={canAdmin} notify={notify} />
    </Modal>
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
