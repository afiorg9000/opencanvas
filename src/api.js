const SESSION_KEY = 'open-canvas-session'

let remoteApi = null

/** True when the Express/SQLite API is reachable (local npm run, or a hosted Node server). */
export async function hasRemoteApi() {
  if (remoteApi !== null) return remoteApi
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    const data = await res.json()
    remoteApi = Boolean(res.ok && data?.ok)
  } catch {
    remoteApi = false
  }
  return remoteApi
}

export function isLocalSession(session = getSession()) {
  return Boolean(session?.token?.startsWith('local.'))
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data?.token || !data?.email) return null
    return data
  } catch {
    return null
  }
}

export function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text }
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}
