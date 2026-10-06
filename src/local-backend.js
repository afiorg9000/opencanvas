const USERS_KEY = 'open-canvas-local-users'
const SNAPSHOT_APPLIED_KEY = 'open-canvas-applied-snapshot'
const BOARD_KEY = (email) => `open-canvas-local-board:${email}`

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

function readLocalBoard(email) {
  try {
    const raw = localStorage.getItem(BOARD_KEY(email))
    if (!raw) return emptyDoc()
    const doc = JSON.parse(raw)
    return doc && typeof doc === 'object' ? doc : emptyDoc()
  } catch {
    return emptyDoc()
  }
}

export async function localLoadCanvas(email) {
  const snap = await getPublishedSnapshot()
  const local = readLocalBoard(email)
  if (!snap?.doc) return local

  const applied = localStorage.getItem(SNAPSHOT_APPLIED_KEY)
  const snapNewer = snap.exportedAt && snap.exportedAt !== applied
  // Only take the published copy when it's a fresh export or this browser has
  // nothing yet — otherwise edits made here would be replaced on every reload.
  if (snapNewer || boardWeight(local) === 0) {
    if (snap.exportedAt) localStorage.setItem(SNAPSHOT_APPLIED_KEY, snap.exportedAt)
    localStorage.setItem(BOARD_KEY(email), JSON.stringify(snap.doc))
    return snap.doc
  }
  return local
}

export function localSaveCanvas(email, doc) {
  localStorage.setItem(BOARD_KEY(email), JSON.stringify(doc))
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Couldn’t save image'))
    reader.readAsDataURL(blob)
  })
}
