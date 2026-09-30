// chatReader.js — reads a WhatsApp group export ON THE DEVICE, with fixed
// rules (no AI, no network). It turns the band's usual phrases into the same
// JSON the import review screen already understands:
//   { gigs: { key: {...} }, answers_from_chat: [...], checks: [...] }
// Anything it can't be sure of becomes a "check" (shown, never saved) or an
// answer marked `uncertain` (shown unticked), so a person always decides.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const CITIES = {
  bhopal: 'Bhopal', bpl: 'Bhopal', indore: 'Indore', mumbai: 'Mumbai', bombay: 'Mumbai', delhi: 'Delhi',
  goa: 'Goa', nagpur: 'Nagpur', kolkata: 'Kolkata', calcutta: 'Kolkata', bangalore: 'Bangalore',
  bengaluru: 'Bangalore', ahmedabad: 'Ahmedabad', pune: 'Pune', surat: 'Surat', etawah: 'Etawah',
  'jim corbett': 'Jim Corbett', maharashtra: 'Maharashtra', karjat: 'Karjat', jaipur: 'Jaipur',
  hyderabad: 'Hyderabad', chennai: 'Chennai', lucknow: 'Lucknow', udaipur: 'Udaipur', gwalior: 'Gwalior',
  jabalpur: 'Jabalpur', raipur: 'Raipur', rishikesh: 'Rishikesh', dehradun: 'Dehradun',
}
const KINDS = [
  [/\bwed(ding)?s?\b|\bshaadi\b|\bsangeet\b/i, 'Wedding'], [/\bclub\b/i, 'Club'],
  [/\bcorporate\b/i, 'Corporate'], [/\b(college|clg|fest)\b/i, 'College'], [/\bcafe\b/i, 'Cafe'],
]
const IN_RE = /(^|\s)(in|inn|i'?m in|count me in|available( hu| hoon| hai)?( mein| main)?|avail|lock(ed)?( hai)?|confirm(ed)?( hai)?|mera bhi confirm( hai)?)(\s|[.!]|$)|🔒|🔐|✅/i
const OUT_RE = /\b(busy|not available|unavailable|nahi ho( pa)?yega|nhi ho( pa)?yega|nahi aa( pa)?unga|can'?t|cannot|incapab\w*|incapib\w*|out)\b|❌/i
const MAYBE_RE = /\b(bata(u|o)nga|batata|bata dunga|maybe|pakka nahi|confirm kar(ke|ta|unga)|check kar(ke|ta|unga))\b/i
const CANCEL_RE = /\b(cancel(led)?|clear kar(do|o|de)|nahi hoga|nhi hoga|called off)\b/i
const MOVE_RE = /\b(\d{1,2})(st|nd|rd|th)?\s*(wala|ka|ki|vala)?\s*(show)?\s*(\d{1,2})(st|nd|rd|th)?\s*(ho ?g(a|y)a|hogya|shift)/i
const PHONE_RE = /\+?\d[\d\s-]{8,}\d/g

const pad = (n) => String(n).padStart(2, '0')
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const clean = (t) => (t || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(PHONE_RE, '[number]').trim()
const tidy = (t) => t.replace(/[\u2066-\u2069]/g, '').replace(/[ \t]*\n[ \t]*/g, ' · ').replace(/\s{2,}/g, ' ').trim()
const short = (t, n = 150) => { const x = tidy(t); return x.length > n ? `${x.slice(0, n - 1)}…` : x }
const onLabel = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** Split the export into messages (iOS "[d/m/y, time] Name: text" and Android "d/m/y, time - Name: text"). */
export function parseMessages(text) {
  const lines = text.replace(/\r/g, '').split('\n')
  const head = /^\u200e?\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202f]*([ap]\.?\s?m\.?)?\]?\s*(?:-\s*)?([^:]{1,60}?):\s?(.*)$/i
  const raw = []
  for (const line of lines) {
    const m = line.match(head)
    if (m) raw.push({ m, text: m[9] })
    else if (raw.length) raw[raw.length - 1].text += `\n${line}`
  }
  // Day/month order: India exports are d/m; switch only if a first field can't be a day.
  const monthFirst = raw.some((r) => +r.m[2] > 12) && !raw.some((r) => +r.m[1] > 12)
  return raw.map(({ m, text: t }) => {
    let [d, mo] = [+m[1], +m[2]]
    if (monthFirst) [d, mo] = [mo, d]
    let y = +m[3]; if (y < 100) y += 2000
    let h = +m[4]
    const ap = (m[7] || '').toLowerCase().replace(/[^apm]/g, '')
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    return { at: new Date(y, mo - 1, d, h, +m[5], +(m[6] || 0)), author: clean(m[8]), text: t }
  }).filter((x) => !Number.isNaN(x.at.getTime()))
}

/** Dates mentioned in a text, anchored to when it was said. Day-only numbers are returned separately. */
export function findDates(text, said) {
  const out = []
  const t = text.toLowerCase()
  const add = (day, mon, yr) => {
    let y = yr ? (+yr < 100 ? 2000 + +yr : +yr) : said.getFullYear()
    let d = new Date(y, mon, day, 12)
    if (!yr && d < new Date(said.getTime() - 45 * 86400000)) d = new Date(y + 1, mon, day, 12)
    if (d.getMonth() === mon && d.getDate() === day) out.push(d)
  }
  const mi = (s) => MONTHS.indexOf(s.slice(0, 3))
  let rest = t
  const eat = (re, fn) => { rest = rest.replace(re, (...m) => { fn(m); return ' '.repeat(m[0].length) }) }
  // "4-5 dec", "18-19-20 September", "4 & 5 Dec" (two numbers = a range, more = a list)
  eat(new RegExp(`\\b(\\d{1,2})((?:\\s*(?:-|–|&|,|and)\\s*\\d{1,2}){1,4})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}(?:\\s*'?(\\d{4}|\\d{2})\\b)?`, 'g'), (m) => {
    const days = [+m[1], ...m[2].split(/[^\d]+/).filter(Boolean).map(Number)]
    const list = days.length === 2 && days[1] > days[0] && days[1] - days[0] <= 3
      ? Array.from({ length: days[1] - days[0] + 1 }, (_, i) => days[0] + i) : days
    for (const d of list) add(d, mi(m[3]), m[4])
  })
  // "4th dec", "3th April of 2026", "15 feb 27", "8dec"
  eat(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}(?:\\s*(?:of\\s+)?'?(\\d{4}|\\d{2})\\b)?`, 'g'), (m) => add(+m[1], mi(m[2]), m[3]))
  // "April 3", "Dec 4th"
  eat(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'), (m) => add(+m[2], mi(m[1])))
  const seen = new Set()
  const dates = out.filter((d) => { const k = keyOf(d); if (seen.has(k)) return false; seen.add(k); return true })
  // "14 wala", "22 ko", "4th ki", "24 cancel", "19 sunday"
  const dayOnly = dates.length ? [] : [...rest.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(wala|vala|ko|ki|ka|cancel|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)].map((m) => +m[1]).filter((d) => d >= 1 && d <= 31)
  return { dates, dayOnly }
}

function describe(text) {
  const t = ` ${text.toLowerCase().replace(/[,|/]/g, ' ')} `
  let city = null
  for (const [k, v] of Object.entries(CITIES)) if (t.includes(` ${k} `)) { city = v; break }
  const kinds = KINDS.filter(([re]) => re.test(text)).map(([, k]) => k)
  const pc = text.match(/(\d)\s*[-/]?\s*(?:(\d)\s*)?(?:pc|piece)s?\b/i)
  if (pc) kinds.push(pc[2] ? `${pc[1]} or ${pc[2]}-piece` : `${pc[1]}-piece`)
  return { city, kind: kinds.join(' · ') || null }
}

function statusOf(text, isPoll) {
  if (CANCEL_RE.test(text)) return 'cancelled'
  if (/tentative|\bhold\b|%|almost|\?/i.test(text)) return 'tentative'
  if (/\bconfirm/i.test(text)) return 'confirmed'
  return isPoll ? 'tentative' : null
}

const mentionsIn = (text) => [...text.matchAll(/@\u2068([^\u2069]+)\u2069/g)].map((m) => clean(m[1]))
  .filter((n) => n && !/^\[number\]$/.test(n) && !/^\+?\d/.test(n))

/**
 * Read an export. `since` (Date, optional) keeps only what happened after it,
 * but the whole file is still read so replies can find the post they answer.
 */
export function readChat(text, { since = null } = {}) {
  // System lines (joins, media, deletions) start with an invisible mark on iOS;
  // Android writes "<Media omitted>" / "This message was deleted".
  const msgs = parseMessages(text).filter((m) => /POLL:/.test(m.text)
    || !(/^\u200e/.test(m.text) || /^<Media omitted>$|^This message was deleted\.?$|^You deleted this message\.?$/i.test(m.text.trim())))
  const polls = new Map()
  for (const m of msgs) if (/POLL:/.test(m.text)) polls.set(m.author, (polls.get(m.author) || 0) + 1)
  // The bandleader posts the polls; without polls, whoever posts the most dated messages.
  let leader = [...polls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  if (!leader) {
    const dated = new Map()
    for (const m of msgs) if (findDates(m.text, m.at).dates.length) dated.set(m.author, (dated.get(m.author) || 0) + 1)
    leader = [...dated.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  }

  const gigs = new Map() // key → gig
  const answers = new Map() // gigKey|person → history[]
  const checks = []
  const announcements = [] // { at, keys[] } for reply context
  const after = (d) => !since || d >= since

  const gigFor = (date) => {
    const k = keyOf(date)
    if (!gigs.has(k)) gigs.set(k, { date: k, city: null, kind: null, status: 'tentative', needs: [], chat: [], _touched: null })
    return gigs.get(k)
  }
  const note = (g, m, text) => {
    if (g.chat.length < 10 && !g.chat.some((c) => c.text === text)) g.chat.push({ by: m.author, on: onLabel(m.at), text })
  }
  const answer = (key, person, status, m, quote, extra = {}) => {
    const k = `${key}|${person}`
    const h = answers.get(k) || []
    if (h.length && h[h.length - 1].status === status && !extra.uncertain) return
    h.push({ status, at: m.at.toISOString(), said: m.author, quote: short(clean(quote)), ...extra })
    answers.set(k, h)
  }
  const resolveDayOnly = (day, m) => {
    const hits = [...gigs.values()].filter((g) => {
      const d = new Date(`${g.date}T12:00:00`)
      return d.getDate() === day && d > new Date(m.at.getTime() - 7 * 86400000) && d < new Date(m.at.getTime() + 150 * 86400000)
    })
    return hits.length === 1 ? new Date(`${hits[0].date}T12:00:00`) : null
  }

  for (const m of msgs) {
    const body = clean(m.text)
    const isPoll = /POLL:/.test(m.text)
    if (isPoll) {
      const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
      const q = lines.filter((l) => !/^POLL:/.test(l) && !/^OPTION:/i.test(l)).join(' ')
      const opts = lines.filter((l) => /^OPTION:/i.test(l)).map((l) => l.match(/^OPTION:\s*(.*?)\s*\((\d+) votes?\)/i)).filter(Boolean)
      const yes = opts.find((o) => /yes|available|avail|haan|in\b/i.test(o[1]))
      const no = opts.find((o) => /^no\b|not|nahi/i.test(o[1]))
      let { dates, dayOnly } = findDates(q, m.at)
      if (!dates.length && dayOnly.length) { const r = resolveDayOnly(dayOnly[0], m); if (r) dates = [r] }
      if (!dates.length) continue // polls about shirts, reels, daaru…
      const keys = []
      for (const d of dates) {
        const g = gigFor(d); keys.push(g.date)
        const desc = describe(q)
        g.city = g.city || desc.city; g.kind = g.kind || desc.kind
        const st = statusOf(q, true); if (st && g.status !== 'cancelled') g.status = st === 'tentative' && g.status === 'confirmed' ? 'confirmed' : st
        if (yes || no) g.poll = `${yes ? yes[2] : 0} available · ${no ? no[2] : 0} no (${onLabel(m.at)})`
        g._touched = g._touched || m.at
        g._last = m.at
        note(g, m, short(`POLL: ${q}`))
      }
      announcements.push({ at: m.at, keys, by: m.author })
      continue
    }

    // Split a message into segments, each starting at a line with a date.
    const segs = []
    for (const line of body.split('\n')) {
      const { dates, dayOnly } = findDates(line, m.at)
      let ds = dates
      if (!ds.length && dayOnly.length) { const r = resolveDayOnly(dayOnly[0], m); if (r) ds = [r] }
      if (ds.length || !segs.length) segs.push({ dates: ds, text: line, dayOnly: ds.length ? [] : dayOnly })
      else segs[segs.length - 1].text += `\n${line}`
    }
    const wholeStatus = statusOf(body, false)
    let announced = []
    for (const s of segs) {
      const text = s.text.trim()
      if (!text) continue
      const mv = text.match(MOVE_RE)
      if (mv) { if (after(m.at)) checks.push({ at: m.at.toISOString(), by: m.author, text: short(text), reason: `Looks like a date change (${mv[1]} → ${mv[5]}). Edit that gig's date by hand.` }); continue }
      if (!s.dates.length) {
        if (s.dayOnly.length && (CANCEL_RE.test(text) || (m.author === leader && !/\b(jam|jamming|setlist|rehearsal)\b/i.test(text) && /\b(show|gig|wedding|confirm|hold|block|query|event)\b/i.test(text))) && after(m.at)) {
          checks.push({ at: m.at.toISOString(), by: m.author, text: short(text), reason: `Mentions "${s.dayOnly[0]}" without a month.` })
        }
        continue
      }
      const mentions = mentionsIn(text)
      const segStatus = statusOf(text, false) || wholeStatus
      const fromLeader = m.author === leader
      const isJam = /\b(jam|jamming|jams|rehearsal|practice|riyaz|setlist)\b/i.test(text)
      const isGigPost = fromLeader && !isJam && (mentions.length || segStatus || /\b(hold|show|gig|wedding|club|event|pc|piece|block)\b/i.test(text))
      for (const d of s.dates) {
        const known = gigs.has(keyOf(d))
        if (!isGigPost && !known) continue
        const g = gigFor(d)
        if (isGigPost) {
          const desc = describe(text)
          g.city = (segStatus === 'confirmed' && desc.city) || g.city || desc.city; g.kind = g.kind || desc.kind
          if (segStatus === 'cancelled') g.status = 'cancelled'
          else if (segStatus === 'confirmed' && g.status !== 'cancelled') g.status = 'confirmed'
          const need = text.match(/\bneed(?:s|ed)?\s+(?:a\s+)?([a-z /]+?)(?:\s+player)?(?:[.!\n]|$)/i)
          if (need && !g.needs.includes(need[1].trim())) g.needs.push(need[1].trim().replace(/^\w/, (c) => c.toUpperCase()))
          g._touched = g._touched || m.at
          g._last = m.at
          announced.push(g.date)
          for (const who of mentions) answer(g.date, who, 'in', m, text)
          if (mentions.length) {
            // Someone on an earlier lineup for this gig but missing from this one.
            for (const [k, h] of answers) {
              const [gk, who] = k.split('|')
              const last = h[h.length - 1]
              if (gk === g.date && last.status === 'in' && last.said === m.author && !mentions.includes(who)) {
                answer(g.date, who, 'out', m, text, { uncertain: `Not in the newer lineup posted ${onLabel(m.at)}. Check if they were dropped.` })
              }
            }
          }
          note(g, m, short(text))
        } else if (!fromLeader) {
          // A member naming the date: In / Out / Maybe about that gig.
          const st = OUT_RE.test(text) ? 'out' : MAYBE_RE.test(text) ? 'maybe' : IN_RE.test(text) ? 'in' : null
          if (st) answer(g.date, m.author, st, m, text)
          note(g, m, short(text))
        }
      }
    }
    if (announced.length) { announcements.push({ at: m.at, keys: announced, by: m.author }); continue }

    // Short reply with no date: attach to the latest gig post in the last 36 hours.
    if (m.author === leader || body.length > 80 || segs.some((s) => s.dates.length)) continue
    const st = OUT_RE.test(body) ? 'out' : MAYBE_RE.test(body) ? 'maybe' : IN_RE.test(body) ? 'in' : null
    if (!st) continue
    // A follow-up ("Mera bhi confirm hai") settles a Maybe they gave in the last 10 days.
    const pending = [...answers.entries()].filter(([k, h]) => k.endsWith(`|${m.author}`)
      && h[h.length - 1].status === 'maybe' && m.at - new Date(h[h.length - 1].at) <= 10 * 86400000)
    const recent = announcements.filter((a) => m.at - a.at <= 36 * 3600000 && m.at >= a.at)
    if (pending.length === 1 && st !== 'maybe' && (!recent.length || /\b(bhi|confirm|final)\b/i.test(body))) {
      answer(pending[0][0].split('|')[0], m.author, st, m, body)
      continue
    }
    if (!recent.length) continue
    const last = recent[recent.length - 1]
    const nearby = recent.filter((a) => last.at - a.at <= 15 * 60000).flatMap((a) => a.keys)
    const keys = [...new Set(nearby)]
    if (keys.length === 1) answer(keys[0], m.author, st, m, body)
    else for (const k of keys) answer(k, m.author, st, m, body, { uncertain: `Sent after ${keys.length} gigs were posted together. Check which one it's about.` })
  }

  // Keep what's new since the cutoff (gigs first touched or answers given after it).
  const out = { gigs: {}, answers_from_chat: [], checks }
  const answerList = [...answers.entries()].map(([k, history]) => {
    const [gig, person] = k.split('|')
    return { gig, person, history: history.filter((h) => after(new Date(h.at))) }
  }).filter((a) => a.history.length)
  const wanted = new Set(answerList.map((a) => a.gig))
  for (const g of gigs.values()) {
    if (!(after(g._last || g._touched) || wanted.has(g.date))) continue
    const { _touched, _last, ...rest } = g
    out.gigs[`${g.date}-${(g.city || 'gig').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`] = { ...rest, city: g.city || (g.kind ? null : 'Gig') }
  }
  const keyByDate = Object.fromEntries(Object.entries(out.gigs).map(([k, g]) => [g.date, k]))
  out.answers_from_chat = answerList.filter((a) => keyByDate[a.gig]).map((a) => ({ ...a, gig: keyByDate[a.gig] }))
  out.leader = leader
  return out
}

/** True if a text looks like a WhatsApp export (so the importer can read it here). */
export const looksLikeWhatsApp = (text) =>
  /^\u200e?\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/m.test(text.slice(0, 2000))
