import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { isStaging } from './supabaseClient'
import './styles.css'

// On preview deploys, a small fixed tag makes it obvious you're on test data.
function StagingTag() {
  if (!isStaging) return null
  return (
    <div
      style={{
        position: 'fixed', left: 12, bottom: 12, zIndex: 9999,
        padding: '4px 10px', borderRadius: 6, pointerEvents: 'none',
        background: '#f0954a', color: '#161a2b',
        font: '600 12px/1.4 system-ui, sans-serif', letterSpacing: '.04em',
      }}
    >
      TEST · Woodshed data
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <StagingTag />
  </React.StrictMode>
)
