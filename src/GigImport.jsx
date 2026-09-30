// GigImport.jsx — owner/admin import of gigs + availability answers from a
// WhatsApp chat. Main path: upload the WhatsApp export (.txt or .zip) and
// lib/chatReader.js reads it ON THIS DEVICE with fixed rules — no AI, nothing
// sent anywhere. Backup path: paste the JSON Claude.ai returns for
// CLAUDE_PROMPT. Either way this screen shows the facts for review and only
// the ticked ones are saved.
import React, { useState, useMemo } from 'react'
import * as api from './lib/api'
import { readChat, looksLikeWhatsApp } from './lib/chatReader'
import { Modal, memberName } from './App.jsx'
import { Copy, Check, FileUp, AlertTriangle } from 'lucide-react'

// Which board member each WhatsApp name is, remembered on this device
// (WhatsApp shows names as saved in the uploader's phone, e.g. a nickname).
const aliasKey = (boardId) => `jm-chat-names:${boardId}`
const loadAliases = (boardId) => { try { return JSON.parse(localStorage.getItem(aliasKey(boardId)) || '{}') } catch { return {} } }
const saveAliases = (boardId, map) => { try { localStorage.setItem(aliasKey(boardId), JSON.stringify(map)) } catch { /* private mode */ } }

async function fileText(f) {
  if (/\.zip$/i.test(f.name) || f.type.includes('zip')) {
    const { unzipSync, strFromU8 } = await import('fflate')
    const files = unzipSync(new Uint8Array(await f.arrayBuffer()))
    const name = Object.keys(files).find((n) => /_chat\.txt$/i.test(n)) || Object.keys(files).find((n) => /\.txt$/i.test(n))
    if (!name) throw new Error('No chat .txt inside that zip.')
    return strFromU8(files[name])
  }
  return f.text()
}

export const CLAUDE_PROMPT = `I'm attaching our band's WhatsApp group export. Read it and give me ONLY a JSON object (no other text) listing our gigs and who said they were available, in this exact shape:

{
  "gigs": {
    "<YYYY-MM-DD>-<city-slug>": {
      "date": "YYYY-MM-DD",
      "city": "Pune",
      "venue": "optional",
      "kind": "optional, e.g. Wedding · 5-piece",
      "status": "confirmed | tentative | cancelled | played | unclear",
      "lineup": [{ "name": "Sam", "role": "guitar" }],
      "needs": ["Bassist"],
      "poll": "optional, e.g. 4 available · 2 no (23 Mar)",
      "dress": "optional", "travel": "optional", "summary": "optional, one line",
      "schedule": [{ "t": "4:00pm", "what": "Soundcheck" }],
      "chat": [{ "by": "Alex", "on": "23 Feb", "text": "short paraphrase" }]
    }
  },
  "answers_from_chat": [
    {
      "gig": "<the gig key above>",
      "person": "Sam",
      "history": [
        { "status": "in | maybe | out", "at": "<message timestamp, ISO 8601 with +05:30>", "said": "who wrote it", "quote": "their words, max 150 characters" }
      ]
    }
  ]
}

Rules:
- Use each person's real first name, not their WhatsApp saved name, and the same spelling every time.
- "at" is the exact time of the message where they said it. Keep every change (yes, then no, then maybe) as a separate history entry, oldest first.
- If someone else reports a person's answer, "said" is who wrote it.
- When the bandleader confirms a lineup (names or @mentions, e.g. "4th dec Goa: @A @B, need bassist"), add an "in" entry for EACH named person at that message's time, with "said" = the bandleader. If a later lineup for the same show drops someone, add an "out" entry for them at that later time.
- Replies like "busy", "nahi ho payega", "can't" are "out"; "locked", "confirm", "in", 🔒 are "in". If it's unclear which show a reply is about, don't add it; mention it in that gig's "summary".
- Partial dates ("22 ko", "15 feb 27"): anchor to the message date; if unsure, set status "unclear" and say why in "summary". Never guess.
- Poll votes don't show names in exports: put the counts in "poll", don't invent answers.
- No phone numbers, no money amounts, nothing personal beyond who is playing which show.`

const norm = (s) => (s || '').trim().toLowerCase()
const firstWord = (s) => norm(s).split(/\s+/)[0]
const fmtWhen = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '?' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const STATUS_MAP = { confirmed: 'confirmed', tentative: 'tentative', cancelled: 'cancelled', played: 'confirmed', unclear: 'tentative' }

/** Turn Claude's JSON into gigs / people / answers for review. Throws on bad input. */
function parseImport(input) {
  let data = input
  if (typeof input === 'string') {
    try { data = JSON.parse(input.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) }
    catch { throw new Error('That isn\'t valid JSON. Paste exactly what Claude gave you.') }
  }
  const rawGigs = Array.isArray(data.gigs)
    ? data.gigs.map((g, i) => [g.id || `${g.date}-${i}`, g])
    : Object.entries(data.gigs || {})
  const gigs = rawGigs
    .filter(([, g]) => /^\d{4}-\d{2}-\d{2}$/.test(g?.date || ''))
    .map(([key, g]) => {
      const lines = []
      if (g.status === 'unclear') lines.push('Needs check: date or booking unclear in the chat.')
      if (g.summary) lines.push(g.summary)
      if (g.lineup?.length) lines.push(`Lineup: ${g.lineup.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(', ')}`)
      if (g.needs?.length) lines.push(`Open: ${g.needs.join(', ')}`)
      if (g.poll) lines.push(`Poll: ${g.poll}`)
      if (g.dress) lines.push(`Dress: ${g.dress}`)
      if (g.travel) lines.push(`Travel: ${g.travel}`)
      if (g.schedule?.length) lines.push(`Schedule:\n${g.schedule.map((s) => `  ${s.t} — ${s.what}`).join('\n')}`)
      if (g.chat?.length) lines.push(`From the chat:\n${g.chat.map((c) => `  ${c.by}, ${c.on}: ${c.text}`).join('\n')}`)
      return {
        key,
        date: g.date,
        title: [g.city, ...(g.kind || '').split(/\s+·\s+/)]
          .filter((x, i, arr) => x && norm(x) !== 'unknown' && arr.findIndex((y) => norm(y) === norm(x)) === i)
          .join(' · ') || 'Gig',
        venue: g.venue || null,
        status: STATUS_MAP[g.status] || 'tentative',
        details: lines.join('\n') || null,
        lineup: (g.lineup || []).map((p) => p.name).filter(Boolean),
      }
    })
    .sort((a, z) => a.date.localeCompare(z.date))
  const gigKeys = new Set(gigs.map((g) => g.key))
  const answers = []
  for (const r of data.answers_from_chat || []) {
    if (!gigKeys.has(r.gig) || !r.person) continue
    for (const h of r.history || []) {
      if (!['in', 'maybe', 'out'].includes(h.status) || Number.isNaN(new Date(h.at).getTime())) continue
      const quote = (h.quote || '').trim()
      const said = h.said && norm(h.said) !== norm(r.person) ? `${h.said}: ` : ''
      answers.push({
        id: `${r.gig}|${r.person}|${h.at}|${h.status}`,
        gigKey: r.gig,
        person: r.person.trim(),
        answer: h.status,
        said_at: new Date(h.at).toISOString(),
        note: (said + quote).slice(0, 300) || null,
        uncertain: h.uncertain || null,
      })
    }
  }
  const names = new Map()
  for (const a of answers) names.set(norm(a.person), a.person)
  for (const g of gigs) for (const n of g.lineup) if (!names.has(norm(n))) names.set(norm(n), n.trim())
  return {
    gigs, answers, people: [...names.values()].sort((a, z) => a.localeCompare(z)),
    checks: (data.checks || []).filter((c) => c && c.text), fromChat: !!data.fromChat,
  }
}

export default function GigImportModal({ board, members, gigs: existing, profile, notify, onClose, onDone }) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  // Default: read messages after the newest chat answer already saved (else 1 Jan this year).
  const [since, setSince] = useState(() => {
    const last = existing.flatMap((g) => g.gig_answers || []).filter((a) => a.source === 'chat')
      .map((a) => a.said_at).sort().pop()
    return (last || `${new Date().getFullYear()}-01-01`).slice(0, 10)
  })
  const [statusPick, setStatusPick] = useState({}) // gig key → apply status change to existing gig
  // Review choices
  const [personMap, setPersonMap] = useState({}) // name → membership id | 'new' | 'skip'
  const [gigMap, setGigMap] = useState({}) // key → gig id | 'new' | 'skip'
  const [picked, setPicked] = useState({}) // answer id → bool

  const readFile = async (f) => {
    if (!f) return
    setReading(true)
    try {
      const t = await fileText(f)
      if (looksLikeWhatsApp(t)) {
        const found = readChat(t, { since: since ? new Date(`${since}T00:00:00`) : null })
        review({ ...found, fromChat: true })
      } else setText(t)
    } catch (e) { notify(`Couldn't read that file: ${e.message}`) } finally { setReading(false) }
  }

  const review = (input = text) => {
    let p
    try { p = parseImport(input) } catch (e) { notify(e.message); return }
    if (!p.gigs.length) { notify(p.fromChat ? 'Nothing new about gigs since that date.' : 'No gigs found in that list.'); return }
    const aliases = loadAliases(board.id)
    const pm = {}
    for (const n of p.people) {
      const known = aliases[n] && (aliases[n] === 'skip' || members.some((m) => m.id === aliases[n])) ? aliases[n] : null
      const hit = members.find((m) => norm(memberName(m)) === norm(n))
        || members.find((m) => firstWord(memberName(m)) === firstWord(n))
      pm[n] = known || (hit ? hit.id : 'new')
    }
    const gm = {}
    for (const g of p.gigs) {
      const same = existing.filter((e) => e.gig_date === g.date)
      const hit = same.find((e) => norm(e.title) === norm(g.title)) || (same.length === 1 ? same[0] : null)
      gm[g.key] = hit ? hit.id : 'new'
    }
    setPersonMap(pm); setGigMap(gm); setParsed(p)
    setPicked(Object.fromEntries(p.answers.map((a) => [a.id, !a.uncertain && !isSaved(a, pm, gm)])))
    setStatusPick(Object.fromEntries(p.gigs.map((g) => [g.key, true])))
  }

  // Same person, gig, answer and moment already on record → don't import twice.
  const isSaved = (a, pm = personMap, gm = gigMap) => {
    const gid = gm[a.gigKey], mid = pm[a.person]
    const gig = existing.find((e) => e.id === gid)
    if (!gig || !mid || mid === 'new' || mid === 'skip') return false
    return gig.gig_answers.some((x) => x.membership_id === mid && x.answer === a.answer
      && new Date(x.said_at).getTime() === new Date(a.said_at).getTime())
  }

  // A gig matched to an existing one whose status the chat changed (e.g. now cancelled).
  const statusChange = (g) => {
    const e = existing.find((x) => x.id === gigMap[g.key])
    return e && e.status !== g.status && g.status !== 'tentative' ? { from: e.status, to: g.status, id: e.id } : null
  }

  const counts = useMemo(() => {
    if (!parsed) return null
    const usable = (a) => picked[a.id] && gigMap[a.gigKey] !== 'skip' && personMap[a.person] !== 'skip'
    return {
      people: Object.values(personMap).filter((v) => v === 'new').length,
      gigs: Object.values(gigMap).filter((v) => v === 'new').length,
      answers: parsed.answers.filter(usable).length,
      statuses: parsed.gigs.filter((g) => statusChange(g) && statusPick[g.key]).length,
    }
  }, [parsed, picked, gigMap, personMap, statusPick]) // eslint-disable-line react-hooks/exhaustive-deps


  const save = async () => {
    setBusy(true)
    try {
      const pm = { ...personMap }
      for (const [name, v] of Object.entries(pm)) {
        if (v === 'new') pm[name] = await api.addBandPerson(board.id, name, null)
      }
      const gm = { ...gigMap }
      for (const g of parsed.gigs) {
        if (gm[g.key] !== 'new') continue
        const made = await api.createGig(board.id, profile.id, {
          gig_date: g.date, title: g.title, venue: g.venue, status: g.status, details: g.details,
        })
        gm[g.key] = made.id
      }
      for (const g of parsed.gigs) {
        const ch = statusChange(g)
        if (ch && statusPick[g.key]) await api.updateGig(ch.id, { status: ch.to })
      }
      const rows = parsed.answers
        .filter((a) => picked[a.id] && gm[a.gigKey] !== 'skip' && pm[a.person] !== 'skip')
        .map((a) => ({ gig_id: gm[a.gigKey], membership_id: pm[a.person], answer: a.answer, note: a.note, said_at: a.said_at }))
      await api.addChatAnswers(rows, profile.id)
      saveAliases(board.id, { ...loadAliases(board.id), ...pm })
      notify(`Imported: ${counts.people} people, ${counts.gigs} gigs, ${counts.statuses ? `${counts.statuses} status changes, ` : ''}${rows.length} answers.`)
      onDone()
    } catch (e) {
      notify(`Import stopped: ${e.message}. Anything saved before this stays; run it again and it skips what's already there.`)
      setBusy(false)
      onDone()
    }
  }

  if (!parsed) {
    return (
      <Modal title="Import gigs from the band chat" onClose={onClose} wide>
        <ol className="import-steps">
          <li>In WhatsApp: open the band group → ⋮ / group name → <b>Export chat</b> → <b>Without media</b>. Save the file.</li>
          <li>
            <label className="row gap tiny">
              <span>Read messages since</span>
              <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
            </label>
          </li>
          <li>
            <label className="btn btn-primary">
              <FileUp size={14} /> {reading ? 'Reading…' : 'Choose the export (.txt or .zip)'}
              <input type="file" accept=".txt,.zip,text/plain,application/zip" hidden disabled={reading}
                onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          </li>
        </ol>
        <p className="dim tiny">
          The chat is read on this device. It isn't uploaded or sent anywhere. You'll check everything
          before it's saved, and only the gigs, answers and short quotes you tick are kept (visible only to
          members of this board).
        </p>

        <details className="import-alt">
          <summary className="dim tiny">Other way: paste a list from Claude.ai</summary>
          <p className="dim tiny">
            For tricky stretches the reader misses: attach the export in Claude.ai with this prompt, then paste its answer here.
            {' '}<button className="btn btn-ghost tiny-btn" onClick={async () => {
              try { await navigator.clipboard.writeText(CLAUDE_PROMPT); setCopied(true); setTimeout(() => setCopied(false), 2000) }
              catch { notify('Couldn\'t copy. Select the prompt below and copy it.') }
            }}>
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy prompt</>}
            </button>
          </p>
          <details className="import-prompt"><summary className="dim tiny">Show prompt</summary><pre>{CLAUDE_PROMPT}</pre></details>
          <textarea className="import-text" rows={6} value={text} onChange={(e) => setText(e.target.value)}
            placeholder='{ "gigs": { … }, "answers_from_chat": [ … ] }' />
          <div className="modal-actions">
            <button className="btn btn-primary" disabled={!text.trim()} onClick={() => review()}>Review</button>
          </div>
        </details>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </Modal>
    )
  }

  const gigByKey = Object.fromEntries(parsed.gigs.map((g) => [g.key, g]))
  return (
    <Modal title="Check before saving" onClose={onClose} wide>
      <section className="panel">
        <h3>People ({parsed.people.length})</h3>
        <p className="dim tiny">
          {parsed.fromChat ? 'These are the names as saved in this phone. ' : ''}Match each name to someone on the board, or add them.
          {parsed.fromChat ? ' Your choices are remembered on this device for next time.' : ''} New people get no email for now; add it later in Members.
        </p>
        <div className="import-grid">
          {parsed.people.map((n) => (
            <label key={n} className="row gap tiny">
              <span className="import-name">{n}</span>
              <select value={personMap[n]} onChange={(e) => setPersonMap({ ...personMap, [n]: e.target.value })}>
                <option value="new">Add as new band member</option>
                {members.map((m) => <option key={m.id} value={m.id}>Is {memberName(m)}</option>)}
                <option value="skip">Skip (don't import)</option>
              </select>
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Gigs ({parsed.gigs.length})</h3>
        <div className="import-list">
          {parsed.gigs.map((g) => (
            <div key={g.key} className="import-row">
              <span className="tiny mono">{g.date}</span>
              <span className="import-title">{g.title} <span className={`gstatus st-${g.status}`}>{g.status}</span></span>
              <select value={gigMap[g.key]} onChange={(e) => setGigMap({ ...gigMap, [g.key]: e.target.value })}>
                <option value="new">Add as new gig</option>
                {existing.filter((e) => e.gig_date === g.date).map((e) => (
                  <option key={e.id} value={e.id}>Same as “{e.title}”</option>
                ))}
                <option value="skip">Skip</option>
              </select>
              {statusChange(g) && (
                <label className="row gap tiny import-status">
                  <input type="checkbox" checked={!!statusPick[g.key]} onChange={(e) => setStatusPick({ ...statusPick, [g.key]: e.target.checked })} />
                  Change status: {statusChange(g).from} → <b>{statusChange(g).to}</b>
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Answers ({parsed.answers.length})</h3>
        {parsed.answers.length === 0 && <p className="dim tiny">No named answers in this list.</p>}
        <div className="import-list">
          {parsed.answers.map((a) => {
            const off = gigMap[a.gigKey] === 'skip' || personMap[a.person] === 'skip'
            const saved = isSaved(a)
            return (
              <label key={a.id} className={`import-row ${off ? 'off' : ''}`}>
                <input type="checkbox" disabled={off} checked={!off && !!picked[a.id]}
                  onChange={(e) => setPicked({ ...picked, [a.id]: e.target.checked })} />
                <span className={`ans ans-${a.answer}`}>{a.answer}</span>
                <span className="import-title">
                  <b>{a.person}</b> · {gigByKey[a.gigKey]?.date} {gigByKey[a.gigKey]?.title}
                  <span className="dim tiny"> · said {fmtWhen(a.said_at)}{saved ? ' · already saved' : ''}</span>
                  {a.uncertain && <span className="import-check"><AlertTriangle size={12} /> {a.uncertain}</span>}
                  {a.note && <span className="glog-note">“{a.note}”</span>}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      {parsed.checks.length > 0 && (
        <section className="panel">
          <h3><AlertTriangle size={14} /> Worth a look <span className="dim tiny">· not saved</span></h3>
          <p className="dim tiny">Messages the reader couldn't be sure about. Fix these by hand if they matter.</p>
          <ul className="import-checks">
            {parsed.checks.map((c, i) => (
              <li key={i}><span className="dim tiny">{c.by} · {fmtWhen(c.at)}</span><span>“{c.text}”</span><span className="import-check">{c.reason}</span></li>
            ))}
          </ul>
        </section>
      )}

      <div className="modal-actions">
        <span className="dim tiny">
          Will add {counts.people} people, {counts.gigs} gigs, {counts.answers} answers{counts.statuses ? `, ${counts.statuses} status changes` : ''}. Answers can't be edited
          or deleted afterwards (that's what makes them proof).
        </span>
        <button className="btn btn-ghost" onClick={() => setParsed(null)}>Back</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  )
}

export { parseImport }
