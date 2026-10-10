import { api, getSession, hasRemoteApi, isLocalSession } from './api.js'
import { blobToDataUrl, loadLocalBoard, localLoadCanvas, localSaveCanvas } from './local-backend.js'

function onThisComputer() {
  const host = location.hostname
  return host === '127.0.0.1' || host === 'localhost'
}

async function useLocalStore() {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  // This Mac’s boards live in SQLite. Never swap in an empty browser copy.
  if (onThisComputer()) return false
  if (isLocalSession(session)) return true
  return !(await hasRemoteApi())
}

export async function loadCanvas() {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  if (await useLocalStore()) {
    const doc = await localLoadCanvas(session.email)
    return normalize(doc)
  }
  try {
    const remote = await api('/api/canvas', { token: session.token })
    const backup = await loadLocalBoard(session.email)
    const pick = heavier(backup, remote)
    return normalize(pick)
  } catch (err) {
    const backup = await loadLocalBoard(session.email)
    if (heavier(backup, null)) return normalize(backup)
    throw err
  }
}

function boardWeight(doc) {
  if (!doc || typeof doc !== 'object') return 0
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const top = Array.isArray(doc.elements) ? doc.elements.length : 0
  return top + pages.reduce((n, p) => n + (Array.isArray(p?.elements) ? p.elements.length : 0), 0)
}

function heavier(a, b) {
  if (!a) return b
  if (!b) return a
  return boardWeight(a) >= boardWeight(b) ? a : b
}

function normalize(doc) {
  return {
    mode: doc.mode || null,
    blocks: doc.blocks || null,
    elements: doc.elements || [],
    pages: doc.pages || null,
    currentPageId: doc.currentPageId || null,
    view: doc.view || null,
    nextId: doc.nextId || (doc.elements?.length || doc.blocks?.length || 0) + 1,
    scale: doc.scale ?? 1,
    ox: doc.ox ?? 0,
    oy: doc.oy ?? 0,
    scrollTop: doc.scrollTop ?? 0,
  }
}

export async function saveCanvas(doc) {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  await localSaveCanvas(session.email, doc)
  if (await useLocalStore()) return
  await api('/api/canvas', {
    method: 'PUT',
    token: session.token,
    body: { doc },
  })
}

export async function fetchProductPrice(url) {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  if (await useLocalStore()) {
    // No Express API on the published site; a Netlify function reads the page instead.
    try {
      return await api('/.netlify/functions/fetch-product', { method: 'POST', body: { url } })
    } catch {
      return {
        url,
        price: null,
        currency: null,
        title: null,
        image: null,
        imageDataUrl: null,
        source: null,
        warning: 'Couldn’t fetch that product page',
      }
    }
  }
  return api('/api/fetch-product', {
    method: 'POST',
    token: session.token,
    body: { url },
  })
}

export async function fetchProduct(url) {
  return fetchProductPrice(url)
}

export async function fetchRemoteImage(url) {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  if (await useLocalStore()) {
    return { url, image: url, imageDataUrl: url }
  }
  return api('/api/fetch-image', {
    method: 'POST',
    token: session.token,
    body: { url },
  })
}

export async function uploadBoardImage(blob) {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  if (await useLocalStore()) return blobToDataUrl(blob)
  const res = await fetch('/api/assets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) throw new Error(data?.error || 'Couldn’t save image')
  if (!data?.src) throw new Error('Couldn’t save image')
  return data.src
}
