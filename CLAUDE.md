# CLAUDE.md — Jam-Meet

Jam-Meet ("Jammit On") is an async band-rehearsal web app. One board per band; the
owner uploads multitrack stems per song; each member opens a song, mutes their own
instrument, plays along, and after 3 full passes rates confidence 1–10. Songs sort
into lanes by band-average rating: Unrehearsed → Woodshedding (<4) → Tightening up
(4–<7) → Show-ready (≥7). The band average is over every joined member —
not-yet-rated counts as 0 (`songReadiness(song, members)`).

> ⚠️ **This app is LIVE with real users.** Protecting the running app beats every
> other goal. See Guardrails.

See `docs/AUDIT.md` for the current technical audit, open owner questions, and the
proposed Phase 1 sequence.

## Stack & coordinates
- Vite 5 + React 18 SPA, Web Audio API, lucide-react, plain CSS. Plain JS/JSX, no TS.
- Supabase: Postgres + RLS + Auth (Google OAuth only) + Storage.
  Project ref `ukbmynpcddkyjktvwdfr` (`https://ukbmynpcddkyjktvwdfr.supabase.co`).
- Vercel auto-deploys the `main` branch; every branch gets a preview URL.
- Live app: https://jammeet.vercel.app (the only URL the band uses).
- Env vars (baked in at build time): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
  Missing vars → `supabase` is `null` → app renders `SetupScreen`.

## Commands
```bash
npm install
npm run dev      # http://localhost:5173 (needs .env with the two vars)
npm run build    # must pass before any change is called done
```
No test, lint, or CI setup exists yet (Phase 1 adds them).

## Layout
```
index.html                 shell + Google Fonts; loads /src/main.jsx
src/main.jsx               React entry (StrictMode)
src/App.jsx                the ENTIRE UI (~1,530 lines): auth, boards, lanes, console, modals
src/styles.css             dark studio/console design system
src/supabaseClient.js      client from env vars (or null)
src/lib/api.js             ALL database + storage calls
src/lib/audio.js           demo-stem synth, Mixer, VU metering, metronome, formatTime
src/lib/cache.js           stem cache (memory LRU + IndexedDB)
supabase/schema.sql        tables, RLS, triggers, RPCs, storage bucket — idempotent
supabase/migration-002-profile-reconcile.sql   secure reconcile_profile (live since 2026-09-24)
supabase/migration-003-owner-rating.sql        practice.rated_by + rate_for_member (owner rates for a member)
supabase/migration-004-admin-edits.sql         admins edit boards; owner/admins moderate + edit notes (edit_comment)
docs/AUDIT.md              technical audit + owner answers
```

## Architecture
- **Routing** is in-memory state in `App` (`{name:'home'|'board', boardId, songId}`);
  no URL routing.
- **Data layer:** every Supabase call goes through `src/lib/api.js`; each call does
  `throwIf(error)`. UI catches and reports via `notify(msg)` (toasts).
  `fetchBoardBundle` loads board + members(+profiles) + songs(+stems, practice,
  comment count) in one go; components call `refresh()` after mutations.
- **Security model is RLS**, not key secrecy (anon key is public by design). Helpers
  `is_member`, `is_admin`, `is_owner`, `song_board` are `SECURITY DEFINER` to avoid
  policy recursion. Roles: owner / admin (max 2, trigger-enforced) / member.
  Owner + admins: edit board (name/tagline/accent), songs (title/key/sig/BPM), stems,
  and any note (edit via `edit_comment`, delete). Owner only: delete board/songs, invite.
  Owner membership is created by the `handle_new_board` trigger; profiles by
  `handle_new_user` (plus client `ensureProfile`). Invites are `memberships` rows with
  null `user_id`, claimed by `claim_invites()` on login.
- **Stems:** `source='demo'` stems store no audio — synthesized in-browser from the
  song's key/BPM/signature (`synthDemoStems`). `source='upload'` stems live in the
  private `stems` bucket at `<boardId>/<songId>/<stemId>-<rev>.<ext>` (older uploads
  lack `-<rev>`; a replace always writes a new path, busting caches), fetched via
  1-hour signed URLs. Storage RLS derives permissions from the first path segment
  (board id) — keep that path scheme.
- **Mixer** (`audio.js`): one shared `AudioContext`; per-track gain + analyser;
  sample-synced start with 80 ms lead; `update()` is driven by the SongView rAF loop
  and handles looping, metronome lookahead, and pass detection.
- **Play counting:** a pass = transport reaching the end (each loop lap counts) →
  `increment_play` RPC. Rating unlocks at 3 passes (UI-enforced only); a check-in
  prompt asks for a rating at 3, 6, 9, 15, then every 5 passes (`isRatingMilestone`).
  The board owner can rate for a member via `rate_for_member` (migration-003);
  `practice.rated_by` records who set the score (owner-set → "owner" tag).
- **Instruments:** `profiles.instrument` holds a comma-separated pick from `INSTRUMENTS`
  plus any typed via "Other…"
  (App.jsx); unknown legacy values are kept and shown as extra chips.
- **Stem cache** (`src/lib/cache.js`): decoded AudioBuffers in memory for the most
  recently opened song only (`retainOnly` at load start; decoded audio is ~10 MB per
  stereo minute per stem, so never byte-cap below one song) + raw bytes in IndexedDB
  (~600 MB LRU; `audio` store for bytes, `meta` store for size/used — never `getAll`
  the audio store), all keyed by `stemId::storage_path`.

## Conventions
- Function components + hooks; 2-space indent, no semicolons, single quotes.
- New DB/storage calls go in `api.js`, never inline `supabase.*` in components.
- Performance-critical UI (meters, timecode) writes to DOM refs from rAF, not state.
- SQL in `supabase/` must be idempotent (`create or replace`, `if not exists`,
  `drop policy if exists`). New changes go in numbered `migration-NNN-*.sql` files.
- The owner has historically committed via GitHub web upload; check for stray files.

## Guardrails
- **Never push to `main`.** Work on a branch; merge only on explicit owner approval.
- **One shared database, no staging.** Preview deploys and local dev hit the live
  Supabase project — clicking around on a preview writes real data. Google sign-in on
  previews may bounce to prod unless the preview domain is in Supabase Redirect URLs.
- **Schema changes:** propose migration SQL for explicit review. Don't run it against
  live yourself unless the owner explicitly OKs that specific migration in the session
  (a Supabase connector may be attached; read-only queries are fine). Never run
  destructive SQL on live data. Deploy order is
  always SQL first, then code that depends on it.
- Verify with real builds/tests (`npm run build`, plus tests once they exist), not
  assumptions. Phase 1 refactors must be behaviour-preserving.
- State plainly what could not be verified (live credentials, real browser audio,
  OAuth round-trips).
- Phase 2 features are driven by real band feedback — no speculative roadmap.
