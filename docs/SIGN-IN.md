# Google sign-in — settings runbook

Jam-Meet signs people in **only** with Google, through Supabase. If these settings
drift, people who are already logged in keep working, but **nobody new can join**
(and anyone who logs out is locked out). That is exactly what happened on
2026-09-29/30: every new sign-in failed with `Error 400: redirect_uri_mismatch`
until the redirect URI below was re-added in Google Cloud.

A daily automatic check (Claude routine "Jam-Meet sign-in watch") asks Google whether
these settings still line up and sends a phone notification if they don't.

## The values that must match

| Where | Setting | Value |
|---|---|---|
| Google Cloud → project `824944478129` → APIs & Services → Credentials → OAuth 2.0 Client | Client ID | `824944478129-mt83ilg1rpt27ujqcnonuj1p564ctvt1.apps.googleusercontent.com` |
| same client | **Authorized redirect URIs** | `https://ukbmynpcddkyjktvwdfr.supabase.co/auth/v1/callback` (exactly — no trailing slash) |
| same client | Authorized JavaScript origins | `https://jammeet.vercel.app` |
| Google Cloud → OAuth consent screen | Publishing status | **In production** (in "Testing" only listed test users can sign in) |
| Supabase → Authentication → Sign In / Providers → Google | Client ID / Secret | the client above (the Secret is never shared in chat) |
| Supabase → Authentication → URL Configuration | Site URL | `https://jammeet.vercel.app` |
| same page | Redirect URLs | `https://jammeet.vercel.app/**` and `https://*-two-minutes-away.vercel.app/**` (previews) |

## Don't

- Don't delete or edit a redirect URI in the Google Cloud client.
- Don't paste a different Client ID/Secret into Supabase unless that new client
  already has the redirect URI above.
- Don't reset the Client Secret in Google without pasting the new one into Supabase
  straight away.
- Don't delete the Google Cloud project or its OAuth client.

## Do

- Add a second trusted owner to the Google Cloud project, so access isn't lost.
- After any change to these settings, open https://jammeet.vercel.app in a private
  window and sign in once to prove it still works.

## Symptom → fix

| What people see | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | Supabase callback missing from the client's Authorized redirect URIs, or Supabase uses a different client | Add the redirect URI above to the client whose ID Supabase shows |
| `Error 401: invalid_client` / `deleted_client` | Client ID in Supabase is wrong or the client was deleted | Put the correct Client ID + Secret in Supabase (or create a new client with the values above) |
| `Access blocked: … has not completed the Google verification process` | Consent screen is in "Testing" | Publish the app ("In production") |
| Signing in on a preview link ends up on jammeet.vercel.app | Preview domain not in Supabase Redirect URLs | Add `https://*-two-minutes-away.vercel.app/**` |
| "Sign-in setup failed …" inside the app | Database side (profile/invite RPCs) | Ask Claude to check the Supabase logs |
