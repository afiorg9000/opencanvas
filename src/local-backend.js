const USERS_KEY = 'open-canvas-local-users'
const SNAPSHOT_APPLIED_KEY = 'open-canvas-applied-snapshot'
const SNAPSHOT_DIRTY_KEY = 'open-canvas-dirty'
const BOARD_KEY = (email) => `open-canvas-local-board:${email}`
const IDB_NAME = 'open-canvas'
const IDB_STORE = 'kv'

let snapshotPromise = null

function emptyDoc() {
  return { elements: [], nextId: 1, scale: 1, ox: 0, oy: 0 }
}

function boardWeight(doc) {
  if (!doc || typeof doc !== 'object') return 0
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const top = Array.isArray(doc.elements) ? doc.elements.length : 0
  const nested = pages.reduce((n, p) => n + (Array.isArray(p?.elements) ? p.elements.length : 0), 0)
  return top + nested
}

function heavier(a, b) {
  if (!a || boardWeight(a) === 0) return b && boardWeight(b) > 0 ? b : a || b
  if (!b || boardWeight(b) === 0) return a
  return boardWeight(a) >= boardWeight(b) ? a : b
}

let idbPromise = null

/** One shared connection; opening a new one on every save leaks them. */
function openIdb() {
  if (!idbPromise) {
    idbPromise = openIdbOnce().catch((err) => {
      idbPromise = null
      throw err
    })
  }
  return idbPromise
}

function openIdbOnce() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('No IndexedDB'))
      return
    }
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  try {
    const db = await openIdb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

async function idbSet(key, value) {
  const db = await openIdb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(IDB_STORE).put(value, key)
  })
}

export async function getPublishedSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = (async () => {
      const url = `${import.meta.env.BASE_URL}snapshot.json`
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) return null
        const data = await res.json()
        if (!data?.doc || !data?.email) return null
        return data
      } catch {
        return null
      }
    })()
  }
  return snapshotPromise
}

function readUsers() {
  try {
    const data = JSON.parse(localStorage.getItem(USERS_KEY) || '{}')
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users))
}

async function hashCode(email, code) {
  const bytes = new TextEncoder().encode(`${email}\0${code}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function localLogin(email, code) {
  if (!email || !email.includes('@')) throw new Error('Enter a valid email.')
  if (String(code).length < 4) throw new Error('Code must be at least 4 characters.')
  const users = readUsers()
  const hash = await hashCode(email, code)
  if (!users[email]) {
    users[email] = { hash, createdAt: new Date().toISOString() }
    writeUsers(users)
  } else if (users[email].hash !== hash) {
    throw new Error('Wrong code for that email.')
  }
  return { token: `local.${crypto.randomUUID()}`, email }
}

function readLocalStorageBoard(email) {
  try {
    const raw = localStorage.getItem(BOARD_KEY(email))
    if (!raw) return null
    const doc = JSON.parse(raw)
    return doc && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

export async function loadLocalBoard(email) {
  const idbDoc = await idbGet(BOARD_KEY(email))
  const lsDoc = readLocalStorageBoard(email)
  const picked = heavier(idbDoc, lsDoc)
  return picked && boardWeight(picked) > 0 ? picked : emptyDoc()
}

export async function localLoadCanvas(email) {
  const snap = await getPublishedSnapshot()
  const local = await loadLocalBoard(email)
  const dirty = localStorage.getItem(SNAPSHOT_DIRTY_KEY) === '1'
  const localHasWork = boardWeight(local) > 0

  const applied = localStorage.getItem(SNAPSHOT_APPLIED_KEY)
  const snapNewer = Boolean(snap?.exportedAt && snap.exportedAt !== applied)

  // Edits made in this browser stay. A new export only replaces a copy that
  // hasn't been edited here, so publishing from your computer still shows up.
  if (localHasWork && (dirty || !snapNewer)) return local

  if (snap?.doc) {
    // Store it too, or the next reload would fall back to the older copy here.
    await writeLocalBoard(email, snap.doc).catch(() => {})
    localStorage.removeItem(SNAPSHOT_DIRTY_KEY)
    if (snap.exportedAt) localStorage.setItem(SNAPSHOT_APPLIED_KEY, snap.exportedAt)
    return snap.doc
  }
  return local
}

async function writeLocalBoard(email, doc) {
  let lsOk = false
  try {
    localStorage.setItem(BOARD_KEY(email), JSON.stringify(doc))
    lsOk = true
  } catch {
    /* storage quota — IndexedDB is the real store on Netlify */
  }
  try {
    await idbSet(BOARD_KEY(email), doc)
  } catch (err) {
    if (!lsOk) throw new Error('Couldn’t save in this browser.')
  }
}

export async function localSaveCanvas(email, doc) {
  localStorage.setItem(SNAPSHOT_DIRTY_KEY, '1')
  await writeLocalBoard(email, doc)
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Couldn’t save image'))
    reader.readAsDataURL(blob)
  })
}
