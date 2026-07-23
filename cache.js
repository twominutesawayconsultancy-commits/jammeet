// Stem caching, two layers deep.
//
//   Layer 1 — memory: decoded AudioBuffers, keyed by stem id. Survives closing
//             and reopening a song within the same tab. Instant (no download,
//             no decode). Cleared on page refresh.
//   Layer 2 — IndexedDB: the raw downloaded bytes, keyed by stem id + a
//             fingerprint of the file path. Survives refreshes, browser
//             restarts, and days off. Skips the network; only pays decode.
//
// We key by stem id rather than URL because signed URLs carry a rotating token
// and would never match twice.

const DB_NAME = 'jam-meet-stems'
const STORE = 'audio'
const DB_VERSION = 1
const MAX_BYTES = 600 * 1024 * 1024 // ~600 MB ceiling, oldest evicted first

// ---------- Layer 1: memory ----------

const memory = new Map() // stemId -> AudioBuffer

export function getMemory(stemId) {
  return memory.get(stemId)
}

export function putMemory(stemId, buffer) {
  memory.set(stemId, buffer)
}

export function clearMemory() {
  memory.clear()
}

/** Forget one stem's decoded buffer (used when its audio is replaced). */
export function dropMemory(stemId) {
  memory.delete(stemId)
}

// ---------- Layer 2: IndexedDB ----------

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('used', 'used')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null) // private mode / quota denied — degrade quietly
  })
  return dbPromise
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

function keyFor(stemId, path) {
  return `${stemId}::${path || ''}`
}

export async function getStored(stemId, path) {
  try {
    const db = await openDb()
    if (!db) return null
    const store = tx(db, 'readonly')
    const rec = await new Promise((resolve) => {
      const r = store.get(keyFor(stemId, path))
      r.onsuccess = () => resolve(r.result || null)
      r.onerror = () => resolve(null)
    })
    if (!rec) return null
    touch(stemId, path) // fire and forget; keeps eviction order fresh
    return rec.bytes
  } catch {
    return null
  }
}

export async function putStored(stemId, path, bytes) {
  try {
    const db = await openDb()
    if (!db) return
    const store = tx(db, 'readwrite')
    store.put({
      key: keyFor(stemId, path),
      bytes,
      size: bytes.byteLength,
      used: Date.now(),
    })
    evictIfNeeded()
  } catch {
    // Quota exceeded or storage blocked — caching is an optimisation, not a
    // requirement. The app still works, just slower.
  }
}

async function touch(stemId, path) {
  try {
    const db = await openDb()
    if (!db) return
    const store = tx(db, 'readwrite')
    const r = store.get(keyFor(stemId, path))
    r.onsuccess = () => {
      const rec = r.result
      if (rec) { rec.used = Date.now(); store.put(rec) }
    }
  } catch { /* non-fatal */ }
}

async function evictIfNeeded() {
  try {
    const db = await openDb()
    if (!db) return
    const store = tx(db, 'readwrite')
    const all = await new Promise((resolve) => {
      const r = store.getAll()
      r.onsuccess = () => resolve(r.result || [])
      r.onerror = () => resolve([])
    })
    let total = all.reduce((n, r) => n + (r.size || 0), 0)
    if (total <= MAX_BYTES) return
    all.sort((a, b) => (a.used || 0) - (b.used || 0)) // oldest first
    const store2 = tx(await openDb(), 'readwrite')
    for (const rec of all) {
      if (total <= MAX_BYTES) break
      store2.delete(rec.key)
      total -= rec.size || 0
    }
  } catch { /* non-fatal */ }
}

/** Wipe every cached stem on this device. Exposed in the profile menu. */
export async function clearAll() {
  clearMemory()
  try {
    const db = await openDb()
    if (!db) return
    tx(db, 'readwrite').clear()
  } catch { /* non-fatal */ }
}

/** Total bytes cached on this device, for display. */
export async function cacheSize() {
  try {
    const db = await openDb()
    if (!db) return 0
    const store = tx(db, 'readonly')
    const all = await new Promise((resolve) => {
      const r = store.getAll()
      r.onsuccess = () => resolve(r.result || [])
      r.onerror = () => resolve([])
    })
    return all.reduce((n, r) => n + (r.size || 0), 0)
  } catch {
    return 0
  }
}
