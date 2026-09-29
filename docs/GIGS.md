# Gigs feature — handoff (as of 30 Sep 2026)

Start here if you're picking up the Gigs work. Band-specific research (the BKL
WhatsApp export, who's who, extracted gig list) lives in the owner's private
claude.ai Project "Gig Calendar Booking Manager", **not in this public repo**.
Never commit chat exports, phone numbers or quotes from the band's chat here.

## Goal
Replace "who said yes to which date?" arguments in the band's WhatsApp group
with a shared calendar on each Jam-Meet board:
- every gig on a calendar, with status (tentative / confirmed / cancelled)
- each member's availability: **In / Maybe / Out**, with a note
- a permanent, timestamped history of every answer change
  ("said In on 23 Mar 7:34pm, Out on 24 Mar 6:28pm") — this is the core ask
- the setlist for each gig, linked to the board's songs, so members rehearse
  that night's set in the existing console
- per-gig notes (timings, dress, travel, gear)

## Current state (branch `claude/staging-woodshed`, not merged)
- `supabase/migration-005-gigs.sql` — tables `gigs`, `gig_answers`
  (append-only: no update/delete policies), `gig_songs`, `gig_notes`, helper
  `gig_board()`. **Applied to Woodshed only. Not on live.**
- `src/Gigs.jsx` — Gigs tab: month calendar + agenda, "Everyone / My gigs"
  filter, gig sheet (who's in, "was X" flags, per-person history, answer log,
  owner/admin can answer on a member's behalf → recorded as "set by"), setlist
  editor + readiness per song, notes thread.
- `src/App.jsx` — Songs / Gigs switch on the board header; exports `Modal`,
  `initials`, `songReadiness`, `LANES` for Gigs.jsx.
- `src/lib/api.js` — `fetchGigs`, `createGig`, `updateGig`, `deleteGig`,
  `answerGig` (always inserts), `setGigSetlist`, `fetchGigNotes`,
  `addGigNote`, `deleteGigNote`.
- RLS verified on Woodshed by impersonating two users in a rolled-back
  transaction: outsiders see nothing; members answer only for themselves and
  can't fake `set_by`; only owner/admin create gigs, edit setlists, or answer
  for others; nobody can update or delete answers.
- `npm run build` passes. Not yet clicked through end-to-end in a browser.

## Staging (Woodshed)
- Vercel **preview** builds use the Woodshed Supabase project
  (`niluzclxingovirduisu`) — see `src/supabaseClient.js` (keyed on
  `VERCEL_ENV`, injected in `vite.config.js`). Production builds are unchanged
  and contain no Woodshed reference (verified by building both ways).
- Previews show a "TEST · Woodshed data" tag (`src/main.jsx`).
- Woodshed's schema was made identical to live on 29 Sep (columns, FKs,
  checks, functions verbatim, policies, triggers, indexes, bucket) plus
  migration-005. Keep it that way: every migration goes to Woodshed first.
- Woodshed has Google sign-in + preview redirect URLs configured.
- Preview URL for this branch:
  https://jammeet-git-claude-staging-woodshed-two-minutes-away.vercel.app
  (Vercel deployment protection: the viewer must be logged in to Vercel.
  To let bandmates test, turn off protection for previews or share a bypass link.)
- Free plan: Woodshed pauses after 1 week idle → "Restore project" in the dashboard.
- Woodshed has a test board "Arindam Sinha Collective" seeded with 19 real
  gigs from the band's chat (details + notes). Chat-era answers are stored as
  notes, not `gig_answers`, because those people have no accounts yet.

## Design decisions (and why)
- **Append-only answers.** Disputes are about what someone said earlier, so
  history must be tamper-proof. Current answer = latest row per user.
- **Members come from the board.** No separate roster; Jam-Meet memberships
  and Google sign-in already exist.
- **Setlist uses existing songs** so "is the set ready?" reuses `songReadiness`.
- **WhatsApp polls can't be imported with names**: the chat export keeps vote
  counts only. Availability must be captured in-app (or via a bot) to know who.

## Next steps (proposed, owner to prioritise)
1. Owner tests the preview; fix whatever they hit.
2. Before merging: apply migration-005 to **live** (owner's explicit OK), then
   merge the branch. Order: SQL first, code second.
3. Realtime updates (Supabase channel on gigs/gig_answers) so answers appear
   without refresh.
4. "Needs attention" view: gigs with open slots, lineup members answering
   Out/Maybe, same person on two gigs the same day.
5. Calendar feed (.ics per member) so gigs show in phone calendars.
6. WhatsApp import: upload a chat export → Claude API extracts gigs/changes →
   owner reviews before anything is saved. Partial dates must be anchored to
   the message date and flagged, never guessed.
7. Storage: live bucket is ~809 MB of the free 1 GB; ~300 MB looks orphaned
   (replaced stems). A full band set (~30 songs × ~35 MB) needs Supabase Pro
   ($25/mo) or MP3 stems / Cloudflare R2.
