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

## Per-board switch (owner decision, 30 Sep 2026)
Gigs stay on ONE board only ("Arindam Sinha Collective") until the owner says
otherwise. `boards.gigs_enabled` (migration-006, default false) controls it:
- App: no Gigs tab and the original owner-only "Invite by email" on boards where
  it's off; add-by-name + Gigs only where it's on.
- Database: gigs can't be created and `add_band_person`/`update_band_person` refuse
  on boards where it's off; a trigger stops owners/admins flipping it via the API.
- Switch on by id in the SQL editor: `update boards set gigs_enabled = true where id = '…'`.
  Woodshed: on for the test board. Live (30 Sep 2026): 005+006 applied, on for
  "Arindam Sinha Collective" only; lockout verified on every other live board.
  **Owner rule: Gigs stay on this one board only. Never switch it on elsewhere
  without the owner's explicit OK.**

## Band roster + chat history (migration-006)
- **People without accounts.** Owner/admins add band members by name in Members;
  email optional. No email → placeholder `<name>-<hex>@no-email.invalid` (can't be a
  real address). Fix the name/email later (pencil icon); when that person signs in
  with the Google email, `claim_invites()` links them and their answers follow.
  RPCs: `add_band_person` (admins add members; only owner adds admins),
  `update_band_person` (unjoined rows only).
- **Answers per membership.** `gig_answers.membership_id` (user_id now optional).
  A trigger fills `membership_id`/`user_id`/`person_name` and forces `said_at = now()`
  for app answers, so members can't backdate. `person_name` keeps history readable if
  someone leaves (membership_id → null).
- **Chat answers.** `source = 'chat'`, `said_at` = when it was said in WhatsApp,
  `note` = short quote ("Name: …" if someone else reported it). Only owner/admins
  can insert them. Shown with an "in the chat" tag.
- **Import flow (privacy).** Gigs tab → "Import from chat". The owner exports the
  group, gives it to Claude with the in-app prompt (`CLAUDE_PROMPT`, GigImport.jsx),
  pastes back the JSON, maps names to members, ticks gigs/answers, saves. The raw
  chat never reaches Jam-Meet; re-importing skips answers already saved.
  JSON shape = the one in the prompt (`gigs` map + `answers_from_chat`).
- RLS tested on Woodshed (rolled-back transaction): admin adds people + chat answers;
  admin can't add admins; member can't answer for others, can't write chat answers,
  can't backdate, can't add/edit people; nobody can update answers; outsiders see nothing.

## Gig sheet (manager view, 30 Sep 2026)
Order, mobile-first: hero (big date block coloured by status, countdown, venue,
in/maybe/listed/out tally) → summary callout → fact chips (Travel, Dress, Venue,
Poll) → flags (open slots, lineup member said Maybe/Out, same people on a gig the
day before/after, unclear date) → Who's playing (lineup rows with role, latest
answer, when, chat/app; "Listed" = in lineup, no answer; open slots; also answered;
non-answerers folded) + "Are you in?" → Run of show → Setlist → Story so far (one
timeline of chat notes + answers, answers given together collapse into one entry,
chat notes already quoted by an answer are hidden) → Notes.
No schema: `parseDetails` (Gigs.jsx) reads labelled lines in `gigs.details`
(`Lineup:`, `Open:`, `Travel:`, `Dress:`, `Venue:`, `Poll:`, `Needs check:`, indented
`Schedule:` "time — what" and `From the chat:` blocks); unlabelled lines = summary.
The importer writes this format; the edit form shows the same hint.

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
2. Before merging: apply migration-005 then 006 to **live** (owner's explicit OK),
   then merge the branch. Order: SQL first, code second.
3. Realtime updates (Supabase channel on gigs/gig_answers) so answers appear
   without refresh.
4. "Needs attention" view: gigs with open slots, lineup members answering
   Out/Maybe, same person on two gigs the same day.
5. Calendar feed (.ics per member) so gigs show in phone calendars.
6. WhatsApp import v2: extract inside the app (edge function + Claude API key as a
   Supabase secret) instead of the copy-paste step. v1 (manual Claude step + review
   screen) is built.
7. Storage: live bucket is ~809 MB of the free 1 GB; ~300 MB looks orphaned
   (replaced stems). A full band set (~30 songs × ~35 MB) needs Supabase Pro
   ($25/mo) or MP3 stems / Cloudflare R2.
