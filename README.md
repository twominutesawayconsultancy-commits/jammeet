# Jam-Meet

An async rehearsal room for bands. One Trello-style board per band; the owner
uploads multitrack stems per song; every member rehearses on their own
schedule — open a song, **mute your own instrument's track**, play along live
with the rest of the band, and after three full passes rate your confidence
1–10. Songs climb the board automatically:

**Unrehearsed** (no ratings) → **Woodshedding** (avg < 4) → **Tightening up** (4–7) → **Show-ready** (≥ 7)

This is *async* rehearsal — everyone alone, on their own time, against shared
stems. It is not live cross-city jamming (the internet's latency makes that a
different product entirely).

---

## Before you start: two kinds of URLs (the #1 setup mistake)

You will deal with two Supabase URLs and two Vercel URLs. **They look similar
and are not interchangeable.**

| What | Looks like | Where you use it |
|---|---|---|
| Supabase **dashboard** URL | `https://supabase.com/dashboard/project/abcd1234` | Only in your browser, to configure things. Never goes in the app. |
| Supabase **API** URL | `https://abcd1234.supabase.co` | Goes into the app as `VITE_SUPABASE_URL`, and into Google's OAuth settings. |
| Vercel **dashboard** URL | `https://vercel.com/yourname/jam-meet` | Only in your browser, to configure things. |
| Your **live app** URL | `https://jammeet.vercel.app` | What you share with the band, and what goes into Supabase's URL Configuration. |

If something asks for a URL and you're not sure which: dashboards contain
`supabase.com/dashboard` or `vercel.com`; the app/API ones end in
`.supabase.co` or `.vercel.app`.

---

## Step 1 — Create the Supabase project

1. Go to <https://supabase.com/dashboard> and sign up (free tier is fine).
2. Click **New project**. Name it `jam-meet`, pick a strong database password
   (you won't need it again for this guide), choose a region near your band.
3. Wait ~2 minutes for provisioning.

## Step 2 — Run the database schema

1. In the Supabase **dashboard**, open **SQL Editor** (left sidebar).
2. Open the file `supabase/schema.sql` from this project, copy **all** of it,
   paste it into the editor, and click **Run**.
3. You should see "Success. No rows returned". The script is idempotent — if
   you ever change it or aren't sure it ran, just run it again.

This creates every table, all row-level-security policies (which enforce the
owner/admin/member roles at the database level, not just in the UI), the
2-admin limit, the invite-claiming logic, and a **private** `stems` storage
bucket with a 50 MB per-file limit.

### Storage file-size limit (don't skip)

Supabase's **default upload limit is 50 MB project-wide, but the dashboard's
"global file size limit" can be set lower and some templates set it to 5 MB —
far too small for stems** (a 3-minute WAV is ~30 MB). Check it:

1. Dashboard → **Storage** → **Settings** (or Project Settings → Storage).
2. Set **Upload file size limit** to at least **50 MB**.

Tip for your band anyway: export stems as 192–320 kbps MP3 or M4A. They load
much faster and a full song's stems fit in a few MB each.

## Step 3 — Google sign-in

Jam-Meet uses "Continue with Google" only — no passwords to manage.

1. Go to <https://console.cloud.google.com/> → create a project (any name).
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the
   app name and your email, save. You can stay in "Testing" mode and add your
   bandmates' emails as test users, or publish it.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs — add exactly one:
     `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (that's your Supabase **API** URL + `/auth/v1/callback`. Find the API URL
     in Supabase dashboard → Project Settings → API → "Project URL".)
   - Create, then copy the **Client ID** and **Client secret**.
4. Back in the Supabase **dashboard** → **Authentication → Providers →
   Google**: toggle it on, paste the Client ID and secret, save.

## Step 4 — URL Configuration (skipping this = silent 403s)

This is the setup step people miss most. If it's wrong, sign-in *appears* to
work but the session never persists — every request runs as "anonymous" and
the app shows nothing (or 403 errors), with no obvious error message.

Supabase **dashboard** → **Authentication → URL Configuration**:

- **Site URL**: your live app URL, e.g. `https://jammeet.vercel.app`
  (no trailing slash).
- **Redirect URLs** — add all of these, wildcards included:
  - `https://jammeet.vercel.app/**`
  - `http://localhost:5173/**` (so local dev works too)

The `/**` wildcard matters: without it the OAuth redirect back into the app is
rejected and the session is dropped.

> You'll set this *after* Step 5 gives you your real Vercel URL — circle back.

## Step 5 — Deploy to Vercel

1. Put this project in a GitHub repository (upload the folder via
   <https://github.com/new> → "uploading an existing file" works fine).
2. Go to <https://vercel.com>, sign up with GitHub, click **Add New →
   Project**, and import the repo. Vercel auto-detects Vite — accept the
   defaults (build command `npm run build`, output `dist`).
3. Before clicking Deploy, expand **Environment Variables** and add:

   | Name | Value | Where to find it |
   |---|---|---|
   | `VITE_SUPABASE_URL` | `https://YOUR-PROJECT-REF.supabase.co` | Supabase dashboard → Project Settings → API → Project URL |
   | `VITE_SUPABASE_ANON_KEY` | `eyJhbGci…` (long) | Same page → Project API keys → `anon` `public` |

   (The `anon` key is safe to expose in a browser app — that's what row-level
   security is for. Never use the `service_role` key here.)
4. Deploy. Copy your live URL (e.g. `https://jammeet.vercel.app`) and go do
   **Step 4** with it now.
5. If you ever change env vars later: Vercel dashboard → your project →
   Settings → Environment Variables → edit → then **Deployments → Redeploy**
   (env vars are baked in at build time).

## Step 6 — First run

1. Open your live app URL and sign in with Google.
2. Create a board, then **Add song** with **"Auto-generate demo stems"** left
   on — Jam-Meet synthesizes playable 4-bar loops from the key and BPM you
   pick, so you can try the whole console (faders, mute/solo, VU meters,
   metronome, loop, play-counting, rating) before uploading any real audio.
3. To add real stems: **Add song → Upload real audio** and drag a whole folder
   of exported stems onto the drop zone. Each audio file becomes a track,
   auto-named from its filename (`03 - Bass DI.wav` → "Bass DI").
4. Invite the band: open the board → **Members** → invite by the email they'll
   use to sign in with Google. They see the board automatically on first login.
   Roles:
   - **Owner** (you): everything, plus deleting the board/songs, inviting,
     and promoting/demoting admins.
   - **Admin** (max 2): add songs; add/rename/replace/remove stems.
   - **Member**: rehearse, rate, comment.

## How rehearsal works

Open a song → the mixing console loads every stem in sync. Pull **M** (mute)
on your own instrument's channel, hit play, and perform your part live against
the band. A "pass" is counted whenever the transport runs the song to the end
(looping counts each lap). After **3 passes** the 1–10 confidence rating
unlocks. The song card moves lanes based on the **band average** of everyone's
latest rating.

## Local development

```bash
npm install
cp .env.example .env      # then paste your two values into .env
npm run dev               # http://localhost:5173
```

Make sure `http://localhost:5173/**` is in Supabase's Redirect URLs (Step 4).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Signed in but see no boards, or 403s everywhere | Step 4: Site URL / Redirect URLs wrong or missing `/**`. Fix, sign out, sign back in. |
| "Almost wired up" screen | Env vars missing or misspelled. Step 5.3, then redeploy. |
| Invited bandmate sees nothing | They must sign in with **the exact email** you invited. The invite is claimed automatically on their first login. |
| Upload fails around a few MB | Storage upload limit too low — Step 2's storage note. |
| `PGRST200` errors in the browser console | Schema not (fully) run. Re-run `supabase/schema.sql` — it's safe to re-run. |
| "A board can have at most 2 admins" | That's the enforced limit — demote one admin first. |
| Google shows "app not verified" | Your OAuth consent screen is in Testing mode. Add bandmates as test users, or publish the app. |

## What's in the box

```
index.html                 app shell + fonts
src/main.jsx               entry point
src/App.jsx                the whole UI (boards, lanes, console, modals)
src/styles.css             dark studio/console design system
src/supabaseClient.js      Supabase client from env vars
src/lib/audio.js           Web Audio: demo-stem synth, mixer, meters, metronome
src/lib/api.js             all database/storage calls
src/lib/cache.js           stem cache: decoded audio in memory + raw bytes in IndexedDB
supabase/schema.sql        tables, RLS, triggers, RPCs, storage — idempotent
supabase/migration-*.sql   later changes to an existing database (already in schema.sql)
```
