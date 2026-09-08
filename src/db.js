import { api, getSession } from './api.js'

export async function loadCanvas() {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
  const doc = await api('/api/canvas', { token: session.token })
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
  await api('/api/canvas', {
    method: 'PUT',
    token: session.token,
    body: { doc },
  })
}

export async function fetchProductPrice(url) {
  const session = getSession()
  if (!session) throw new Error('Not signed in.')
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
  return api('/api/fetch-image', {
    method: 'POST',
    token: session.token,
    body: { url },
  })
}
