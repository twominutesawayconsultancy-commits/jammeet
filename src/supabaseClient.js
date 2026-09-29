import { createClient } from '@supabase/supabase-js'

// Woodshed = the test database ("Jam Meet - Woodshed", ref niluzclxingovirduisu).
// Its schema mirrors live. Vercel PREVIEW builds always use it, so testing a
// branch never touches the band's real boards. Production builds (and local
// dev) keep using the VITE_SUPABASE_* env vars exactly as before.
// The anon key is public by design; row-level security protects the data.
const WOODSHED_URL = 'https://niluzclxingovirduisu.supabase.co'
const WOODSHED_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pbHV6Y2x4aW5nb3ZpcmR1aXN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTg0MTQsImV4cCI6MjA5ODYzNDQxNH0.1Us5HmFhJug7E0ChvdmWnzIhb6BG1UasmDMCtxIhavo'

export const isStaging = __VERCEL_ENV__ === 'preview'

const url = isStaging ? WOODSHED_URL : import.meta.env.VITE_SUPABASE_URL
const anonKey = isStaging ? WOODSHED_ANON_KEY : import.meta.env.VITE_SUPABASE_ANON_KEY

// When env vars are missing we export null and the app renders a setup
// screen instead of crashing — friendlier for first-time deployers.
export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null
