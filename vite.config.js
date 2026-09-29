import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // Vercel sets VERCEL_ENV at build time: 'production' | 'preview' | 'development'.
    // Empty for local builds. Used by src/supabaseClient.js to route preview
    // deploys to the Woodshed test database.
    __VERCEL_ENV__: JSON.stringify(process.env.VERCEL_ENV || ''),
  },
})
