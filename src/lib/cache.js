// Stem caching, two layers deep.
//
//   Layer 1 — memory: decoded AudioBuffers for the MOST RECENTLY OPENED song
//             only, keyed by stem id + file path (so a stem replaced by another
//             admin is never served stale). Reopening the song you just closed
//             is instant (no download, no decode). Opening a different song
//             drops the previous one first, so memory never holds more than one
//             song, which the mixer is holding anyway while it plays.
//             Decoded audio is ~10 MB per stereo minute per stem, so a byte cap
//             smaller than one song would evict the song itself.
//   Layer 2 — IndexedDB: the raw downloaded bytes, same keys. Survives
//             refreshes, browser restarts, and days off. Skips the network;
//             still pays the decode. Two stores: `audio` holds the bytes and
//             `meta` holds {size, used}, so eviction and the size readout never
//             load hundreds of MB of audio into memory (fatal on phones).
//
// We key by stem id + path rather than URL because signed URLs carry a
// rotating token and would never match twice.

const DB_NAME = 'jam-meet-stems'
const AUDIO = 'audio'
const META = 'meta'
const DB_VERSION = 2
const MAX_BYTES = 600 * 1024 * 1024 // ~600 MB ceiling, least recently used evicted first

function keyFor(stemId, path) {
  return `${stemId}::${path || ''}`
}

// ---------- Layer 1: memory ----------

const memory = new Map() // keyFor(stemId, path) -> AudioBuffer

export function getMemory(stemId, path) {
  return memory.get(keyFor(stemId, path))
}

export function putMemory(stemId, path, buffer) {
  memory.set(keyFor(stemId, path), buffer)
}

/** Keep only these [stemId, path] entries; call when a song starts loading. */
export function retainOnly(entries) {
  const keep = new Set(entries.map(([stemId, path]) => keyFor(stemId, path)))
  for (const k of memory.keys()) if (!keep.has(k)) memory.delete(k)
}

export function clearMemory() {
  memory.clear()
}

/** Forget every decoded buffer for one stem (used when its audio is replaced). */
export function dropMemory(stemId) {
  for (const k of memory.keys()) if (k.startsWith(`${stemId}::`)) memory.delete(k)
}

// ---------- Layer 2: IndexedDB ----------

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // v1 kept bytes and bookkeeping in one store; start v2 clean.
      if (db.objectStoreNames.contains(AUDIO)) db.deleteObjectStore(AUDIO)
      if (db.objectStoreNames.contains(META)) db.deleteObjectStore(META)
      db.createObjectStore(AUDIO, { keyPath: 'key' })
      db.createObjectStore(META, { keyPath: 'key' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close() // let a newer tab upgrade
      resolve(db)
    }
    req.onerror = () => resolve(null) // private mode / storage blocked — degrade quietly
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function result(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
}

function done(transaction) {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true)
    transaction.onerror = () => resolve(false)
    transaction.onabort = () => resolve(false)
  })
}

/** Cheap check (no audio read) for whether a stem's bytes are on this device. */
export async function hasStored(stemId, path) {
  try {
    const db = await openDb()
    if (!db) return false
    const meta = db.transaction(META, 'readonly').objectStore(META)
    return !!(await result(meta.get(keyFor(stemId, path))))
  } catch {
    return false
  }
}

export async function getStored(stemId, path) {
  try {
    const db = await openDb()
    if (!db) return null
    const key = keyFor(stemId, path)
    const rec = await result(db.transaction(AUDIO, 'readonly').objectStore(AUDIO).get(key))
    if (!rec) return null
    // Keep eviction order fresh without rewriting the audio itself.
    db.transaction(META, 'readwrite').objectStore(META)
      .put({ key, size: rec.bytes.byteLength, used: Date.now() })
    return rec.bytes
  } catch {
    return null
  }
}

// Ask once for "persistent" storage so phone browsers don't quietly clear the
// cache under storage pressure. Browsers may say no; that's fine.
let persistAsked = false
function askToPersist() {
  if (persistAsked) return
  persistAsked = true
  try { navigator.storage?.persist?.().catch(() => {}) } catch { /* unsupported */ }
}

export async function putStored(stemId, path, bytes) {
  try {
    const db = await openDb()
    if (!db) return
    askToPersist()
    const key = keyFor(stemId, path)
    const t = db.transaction([AUDIO, META], 'readwrite')
    t.objectStore(AUDIO).put({ key, bytes })
    t.objectStore(META).put({ key, size: bytes.byteLength, used: Date.now() })
    if (await done(t)) scheduleEvict()
  } catch {
    // Quota exceeded or storage blocked — caching is an optimisation, not a
    // requirement. The app still works, just slower.
  }
}

// One eviction pass at a time, however many stems finish downloading at once.
let evictChain = Promise.resolve()
function scheduleEvict() {
  evictChain = evictChain.then(evictIfNeeded, evictIfNeeded)
}

async function evictIfNeeded() {
  try {
    const db = await openDb()
    if (!db) return
    const all = (await result(db.transaction(META, 'readonly').objectStore(META).getAll())) || []
    let total = all.reduce((n, r) => n + (r.size || 0), 0)
    if (total <= MAX_BYTES) return
    all.sort((a, b) => (a.used || 0) - (b.used || 0)) // least recently used first
    const t = db.transaction([AUDIO, META], 'readwrite')
    for (const rec of all) {
      if (total <= MAX_BYTES) break
      t.objectStore(AUDIO).delete(rec.key)
      t.objectStore(META).delete(rec.key)
      total -= rec.size || 0
    }
    await done(t)
  } catch { /* non-fatal */ }
}

/** Wipe every cached stem on this device. Exposed in the profile menu. */
export async function clearAll() {
  clearMemory()
  try {
    const db = await openDb()
    if (!db) return
    const t = db.transaction([AUDIO, META], 'readwrite')
    t.objectStore(AUDIO).clear()
    t.objectStore(META).clear()
    await done(t)
  } catch { /* non-fatal */ }
}

/** Total bytes cached on this device, for display. Reads sizes only. */
export async function cacheSize() {
  try {
    const db = await openDb()
    if (!db) return 0
    const all = (await result(db.transaction(META, 'readonly').objectStore(META).getAll())) || []
    return all.reduce((n, r) => n + (r.size || 0), 0)
  } catch {
    return 0
  }
}
