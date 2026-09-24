# Jam-Meet — Technical audit (2026-09-24)

First-session audit per the handoff brief. Read-only: no application code or live data was changed. Could not be verified from the audit sandbox: the live site, the live Supabase DB, and Google OAuth (outbound network to vercel.app / supabase.co is blocked).

## 🔴 A. Repo ↔ production reconciliation — the "pending" work is in the wrong place
Git history (only `main`, 3 commits, all via GitHub web upload):
- `246ce63` — original app under `src/`.
- `ad9da83` — **newer** `App.jsx`, `api.js`, `cache.js`, `styles.css` uploaded to the
  **repo root**, not `src/`.
- `eb5fcb9` — `ensureProfile` → `reconcile_profile` RPC, edited in **root** `api.js`.

Vite builds from `index.html → /src/main.jsx`, so the root files are **dead code**.
If Vercel builds from `main`, production is running the **old** `src/` code: no stem
cache, no revision-stamped upload paths, old upsert-on-id `ensureProfile`.

| Item | In repo? | Actually built? |
|---|---|---|
| `src/lib/cache.js` | only as root `cache.js` | ❌ |
| App.jsx cache wiring + parallel stem fetch + cache UI | root `App.jsx` | ❌ |
| rev-stamped stem paths (`<stemId>-<rev>.<ext>`) | root `api.js` | ❌ |
| `ensureProfile` → `reconcile_profile` | root `api.js` | ❌ |
| `supabase/migration-002-profile-reconcile.sql` | **absent** | — |
| `reconcile_profile` SQL function | **defined nowhere** in repo | unknown in live DB |

Root files use `src/`-relative imports (`'../supabaseClient'`, `'./lib/cache'`) — they
were clearly meant to overwrite `src/App.jsx`, `src/lib/api.js`, `src/lib/cache.js`,
`src/styles.css`.

**Danger:** moving root `api.js` into `src/lib/` *before* `reconcile_profile` exists in
the live DB breaks sign-in for every user ("Sign-in setup failed: …function not
found"). Migration must be reviewed and applied first, code second.

Could not verify (sandbox network blocks jammeet.vercel.app and Supabase): which
commit/deploy prod runs, whether it was deployed via Vercel CLI from a local folder,
and whether `reconcile_profile` exists in the live DB. **Owner questions listed in §E.**

## 🔴 B. Auth id-drift fix is probably incomplete / needs security review
1. `handle_new_user` trigger does `insert … on conflict (id) do nothing`. A new auth
   id with an existing email conflicts on **`profiles.email` unique**, not `id` → the
   trigger raises → **the `auth.users` insert itself fails** ("Database error saving
   new user") before the client's `ensureProfile` ever runs. A client-side RPC can't
   fix that; migration-002 must also change the trigger. Need to see its SQL.
2. `reconcile_profile(p_id, p_email, …)` is a client-callable RPC that repoints data
   by email. Unless it ignores the args and uses `auth.uid()` + the JWT's verified
   email, **any signed-in user could claim someone else's boards**. Must review.
3. `profiles.id → auth.users on delete cascade`: deleting a stale auth user
   cascades to profile → boards → songs/ratings/comments.
4. If `ensureProfile` fails, `profile` stays null → boards list shows "Loading…"
   forever and the avatar/sign-out button never renders. User is stuck with no way
   out (likely what the id-drift victims saw).

## 🟠 C. Confirmations / corrections to the owner's debt list
1. **App.jsx monolith** — confirmed (1,458 lines built; 1,511 in root version). ~20
   components in one file; `EditTracksModal` bypasses `api.js` and calls
   `supabase.storage` directly.
2. **No tests** — confirmed; also no lint config (despite `eslint-disable` comments),
   no `test` script, no CI.
3. **Auth** — confirmed, and worse than stated (§B).
4. **No observability** — confirmed. Errors surface only as 5s toasts or `alert()`.
5. **Silent invites** — confirmed.
6. **Audio scaling** — confirmed; plus 50 MB/file bucket cap means a 5-min 24-bit/48k
   stereo WAV (~86 MB) simply fails to upload.

## 🟡 D. Additional fragility the brief missed
- **Preview URLs can't do auth, and hit the live DB.** Supabase Redirect URLs likely
  only allow the prod domain, so Google sign-in on a Vercel preview bounces to prod.
  And previews use the same Supabase project → any click-testing on a preview writes
  real data. Also Vercel env vars may be scoped to Production only → preview shows
  the "Almost wired up" screen. Guardrail "verify on preview" needs owner setup.
- **Replace-audio order is unsafe**: deletes old storage object *before* uploading
  the new one; failed upload leaves the stem row pointing at a deleted file.
- **Storage leaks**: deleting a song/board cascades DB rows but never removes stem
  files from the bucket.
- **Partial song creation**: an upload failure mid-way leaves a song with some stems,
  no rollback.
- **Memory cache** (root `cache.js`): keyed by stem id only (another admin's replace
  isn't seen until refresh) and unbounded — decoded PCM is ~10 MB/min/stem, so a few
  8-stem songs can OOM a phone tab. `Promise.all` downloads all WAVs concurrently.
- **Loop/pass detection runs in `requestAnimationFrame`**: in a background tab (e.g.
  musician switches to a chord chart) rAF pauses → loop doesn't restart, pass isn't
  counted until they return. Seeking to the end also counts a "pass".
- **3-pass rating gate is UI-only** — `rateSong` isn't checked server-side (low).
- **RLS notes**: `profiles select using (true)` lets any signed-in user read every
  email; owner can `update` a membership's `user_id`/`email` (policy only checks
  `role`) — low risk, owner-only. Membership email uniqueness is case-sensitive while
  lookups are `lower()`.
- **No `.gitignore`** — web-upload workflow risks committing `node_modules`/`dist`/
  `.env`. README references `.env.example`, which doesn't exist. README uses
  `jam-meet.vercel.app`; live is `jammeet.vercel.app`.
- **No routing** — refresh loses your place; can't link a bandmate to a song.
- `schema.sql` is no longer the full source of truth once migration-002 is run.
- `main` is unprotected.

## E. Questions for the owner
1. How does prod deploy — Vercel Git integration on `main`, or CLI from a local folder?
   (Vercel → Deployments → latest → Source shows the commit.)
2. Has migration-002 been run on the live DB? Please add its SQL to the repo so it can
   be reviewed (esp. §B.1–2).
3. Are Vercel env vars enabled for **Preview**, and can `https://jammeet-*.vercel.app/**`
   be added to Supabase Redirect URLs?
4. Will you keep uploading via the GitHub web UI, or move to branches/PRs?

### Answers so far (2026-09-24)
1. Prod Source is `eb5fcb9` on `main` → Vercel Git integration. **Confirmed: prod runs
   the old `src/` code.**
2. **Corrected via the Supabase connector:** the original migration-002 *had* been
   applied to the live DB (an earlier manual query that returned "no rows" was
   misleading). Its live version:
   - `handle_new_user` already swallowed the email `unique_violation`, so sign-up was
     no longer failing. §B.1 was already fixed in prod.
   - 🔴 **`reconcile_profile` was exploitable.** It trusted the client's `p_id`/`p_email`
     and was executable by `anon`. Anyone holding the public anon key could move any
     user's boards, memberships, ratings and comments to another account and delete
     the victim's profile. A read-only integrity check (9 auth users = 9 profiles, no
     null emails, no membership/owner mismatches) showed **no sign of abuse**.
   - **Fixed 2026-09-24:** `supabase/migration-002-profile-reconcile.sql` (this PR)
     was applied to live, with the owner's explicit OK, as Supabase migration
     `migration_002_profile_reconcile_secure`. Verified afterwards: `anon` can no longer
     execute it, it is bound to `auth.uid()`, the trigger is present, and the
     profile/user counts are unchanged. The live app never called `reconcile_profile`,
     so users saw no change.
3. `VITE_SUPABASE_ANON_KEY` already shows "Production and Preview" in Vercel.
   Supabase Redirect URL for previews still to do:
   `https://jammeet-*-two-minutes-away.vercel.app/**`.
   Two **Netlify** sites (`peppy-donut-c84123`, `glowing-tarsier-c8030a`) also build
   this repo. The band only uses `jammeet.vercel.app`, so the owner will delete them.
4. Moving to branches + PRs (owner reviews on preview, merges on GitHub).

### Found while writing migration-002
- **Stage names reset on every page load.** `ensureProfile` upserts
  `display_name` from Google on each load, overwriting whatever the user saved in
  the profile popover. `reconcile_profile` only sets the name on first creation.
- Confirmed locally: `schema.sql`'s original `handle_new_user` aborts a same-email
  sign-up with `duplicate key value violates unique constraint "profiles_email_key"`.

### Supabase security advisor (2026-09-24, after the fix)
- Every `SECURITY DEFINER` function is executable by `anon`/`authenticated`. This is
  low risk: the trigger functions can't be called via RPC, the `is_*` helpers only
  answer about the caller, and `claim_invites` / `invite_member` / `increment_play`
  check `auth.uid()` internally. Suggested tidy-up (future migration-003, review
  first): `revoke execute … from anon` on all of them, since the app is sign-in only.
- "Leaked password protection disabled": not applicable (Google OAuth only).

---
## Proposed Phase 1 sequence (each step = its own branch/PR, preview-verified, merged only on approval)
0. **Reconcile** (blocked on owner answers §E): add migration-002 SQL to repo, review
   it (trigger fix + `auth.uid()`-bound RPC), owner applies it; *then* move root
   files into `src/`, delete root copies, add `.gitignore` + `.env.example`. Ship the
   cache/rev-path work and the auth fix as two separate PRs so either can be reverted.
1. **Test harness first** (before refactor): Vitest + React Testing Library + jsdom;
   unit tests for pure logic (`songReadiness`, `cleanTrackName`, `formatTime`,
   `parseKey`/`chordForBar`, cache LRU with `fake-indexeddb`); smoke render tests
   with `api` and `supabaseClient` mocked (setup screen, auth gate, boards home,
   board lanes). Add ESLint + GitHub Actions running lint/test/build.
2. **Split App.jsx** mechanically, behaviour-preserving: `src/lib/{songs,files}.js`
   (pure helpers), `src/components/` (Modal, Toasts, Wordmark, Header…),
   `src/features/{auth,boards,board,song}/`, SongView's mixer lifecycle into a
   `useMixer` hook. Move `EditTracksModal`'s direct storage call into `api.js`.
   Tests from step 1 must pass unchanged.
3. **Auth hardening**: sign-out always reachable; explicit error state when
   `ensureProfile` fails; retry.
4. **Error tracking**: Sentry (free tier) behind `VITE_SENTRY_DSN`, React error
   boundary, wrap `notify` errors — needs owner to create the project/DSN.
5. Small safe fixes surfaced here (replace-audio ordering, bounded memory cache) —
   listed, not done, unless approved.

