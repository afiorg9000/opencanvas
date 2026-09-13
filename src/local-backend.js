const USERS_KEY = 'open-canvas-local-users'
const BOARD_KEY = (email) => `open-canvas-local-board:${email}`

function emptyDoc() {
  return { elements: [], nextId: 1, scale: 1, ox: 0, oy: 0 }
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

export function localLoadCanvas(email) {
  try {
    const raw = localStorage.getItem(BOARD_KEY(email))
    if (!raw) return emptyDoc()
    const doc = JSON.parse(raw)
    return doc && typeof doc === 'object' ? doc : emptyDoc()
  } catch {
    return emptyDoc()
  }
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
