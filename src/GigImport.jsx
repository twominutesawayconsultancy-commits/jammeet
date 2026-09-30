// GigImport.jsx — owner/admin import of gigs + availability answers from a
// WhatsApp chat. The chat itself never reaches Jam-Meet: the owner gives the
// export to Claude with CLAUDE_PROMPT, Claude returns a JSON list of facts, and
// this screen shows it for review. Only the ticked facts are saved.
import React, { useState, useMemo } from 'react'
import * as api from './lib/api'
import { Modal, memberName } from './App.jsx'
import { Copy, Check, FileUp } from 'lucide-react'

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
function parseImport(text) {
  let data
  try { data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) }
  catch { throw new Error('That isn\'t valid JSON. Paste exactly what Claude gave you.') }
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
        title: [g.city, g.kind].filter(Boolean).join(' · ') || 'Gig',
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
      })
    }
  }
  const names = new Map()
  for (const a of answers) names.set(norm(a.person), a.person)
  for (const g of gigs) for (const n of g.lineup) if (!names.has(norm(n))) names.set(norm(n), n.trim())
  return { gigs, answers, people: [...names.values()].sort((a, z) => a.localeCompare(z)) }
}

export default function GigImportModal({ board, members, gigs: existing, profile, notify, onClose, onDone }) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  // Review choices
  const [personMap, setPersonMap] = useState({}) // name → membership id | 'new' | 'skip'
  const [gigMap, setGigMap] = useState({}) // key → gig id | 'new' | 'skip'
  const [picked, setPicked] = useState({}) // answer id → bool

  const readFile = (f) => {
    if (!f) return
    const r = new FileReader()
    r.onload = () => setText(String(r.result || ''))
    r.readAsText(f)
  }

  const review = () => {
    let p
    try { p = parseImport(text) } catch (e) { notify(e.message); return }
    if (!p.gigs.length) { notify('No gigs found in that list.'); return }
    const pm = {}
    for (const n of p.people) {
      const hit = members.find((m) => norm(memberName(m)) === norm(n))
        || members.find((m) => firstWord(memberName(m)) === firstWord(n))
      pm[n] = hit ? hit.id : 'new'
    }
    const gm = {}
    for (const g of p.gigs) {
      const same = existing.filter((e) => e.gig_date === g.date)
      const hit = same.find((e) => norm(e.title) === norm(g.title)) || (same.length === 1 ? same[0] : null)
      gm[g.key] = hit ? hit.id : 'new'
    }
    setPersonMap(pm); setGigMap(gm); setParsed(p)
    setPicked(Object.fromEntries(p.answers.map((a) => [a.id, !isSaved(a, pm, gm)])))
  }

  // Same person, gig, answer and moment already on record → don't import twice.
  const isSaved = (a, pm = personMap, gm = gigMap) => {
    const gid = gm[a.gigKey], mid = pm[a.person]
    const gig = existing.find((e) => e.id === gid)
    if (!gig || !mid || mid === 'new' || mid === 'skip') return false
    return gig.gig_answers.some((x) => x.membership_id === mid && x.answer === a.answer
      && new Date(x.said_at).getTime() === new Date(a.said_at).getTime())
  }

  const counts = useMemo(() => {
    if (!parsed) return null
    const usable = (a) => picked[a.id] && gigMap[a.gigKey] !== 'skip' && personMap[a.person] !== 'skip'
    return {
      people: Object.values(personMap).filter((v) => v === 'new').length,
      gigs: Object.values(gigMap).filter((v) => v === 'new').length,
      answers: parsed.answers.filter(usable).length,
    }
  }, [parsed, picked, gigMap, personMap])

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
      const rows = parsed.answers
        .filter((a) => picked[a.id] && gm[a.gigKey] !== 'skip' && pm[a.person] !== 'skip')
        .map((a) => ({ gig_id: gm[a.gigKey], membership_id: pm[a.person], answer: a.answer, note: a.note, said_at: a.said_at }))
      await api.addChatAnswers(rows, profile.id)
      notify(`Imported: ${counts.people} people, ${counts.gigs} gigs, ${rows.length} answers.`)
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
          <li>In WhatsApp: open the band group → ⋮ / group name → <b>Export chat</b> → <b>Without media</b>.</li>
          <li>
            Open Claude (claude.ai), attach that file and paste this prompt:
            <button className="btn btn-ghost" onClick={async () => {
              try { await navigator.clipboard.writeText(CLAUDE_PROMPT); setCopied(true); setTimeout(() => setCopied(false), 2000) }
              catch { notify('Couldn\'t copy. Select the prompt below and copy it.') }
            }}>
              {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy prompt</>}
            </button>
            <details className="import-prompt"><summary className="dim tiny">Show prompt</summary><pre>{CLAUDE_PROMPT}</pre></details>
          </li>
          <li>Paste Claude's answer below (or upload it as a .json file). You'll check everything before it's saved.</li>
        </ol>
        <p className="dim tiny">
          The chat itself never comes to Jam-Meet. Only the gigs, answers and short quotes you tick are
          saved, and only members of this board can see them.
        </p>
        <textarea className="import-text" rows={8} value={text} onChange={(e) => setText(e.target.value)}
          placeholder='{ "gigs": { … }, "answers_from_chat": [ … ] }' />
        <div className="modal-actions">
          <label className="btn btn-ghost">
            <FileUp size={14} /> Upload .json
            <input type="file" accept=".json,application/json,text/plain" hidden onChange={(e) => readFile(e.target.files?.[0])} />
          </label>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={review}>Review</button>
        </div>
      </Modal>
    )
  }

  const gigByKey = Object.fromEntries(parsed.gigs.map((g) => [g.key, g]))
  return (
    <Modal title="Check before saving" onClose={onClose} wide>
      <section className="panel">
        <h3>People ({parsed.people.length})</h3>
        <p className="dim tiny">Match each name to someone on the board, or add them. New people get no email for now; add it later in Members and they join with their history.</p>
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
                  <option key={e.id} value={e.id}>Same as “{e.title}” (answers only)</option>
                ))}
                <option value="skip">Skip</option>
              </select>
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
                  {a.note && <span className="glog-note">“{a.note}”</span>}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <div className="modal-actions">
        <span className="dim tiny">
          Will add {counts.people} people, {counts.gigs} gigs, {counts.answers} answers. Answers can't be edited
          or deleted afterwards (that's what makes them proof).
        </span>
        <button className="btn btn-ghost" onClick={() => setParsed(null)}>Back</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  )
}

export { parseImport }
