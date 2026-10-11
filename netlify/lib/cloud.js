import crypto from 'node:crypto'
import { assertFetchableUrl, extractProductMeta } from '../../server/product-meta.js'
import { fetchImage, fetchPage, json } from './remote.js'

/**
 * The published site's version of server/index.js: same /api routes, but the
 * board, logins and images live in Netlify Blobs instead of SQLite and disk.
 * `stores` is injected so the routes can be exercised without Netlify.
 */

const SESSION_DAYS = 90
const MAX_FAILED_LOGINS = 8
const LOCK_MINUTES = 15
const MAX_ASSET_BYTES = 6_000_000
const ASSET_RE = /^[a-f0-9]{16,64}\.(png|jpe?g|webp|gif|svg|avif)$/i

function emptyDoc() {
  return { elements: [], nextId: 1, scale: 1, ox: 0, oy: 0 }
}

/** Pages plus items on them (and legacy top-level elements/blocks). */
function boardWeight(doc) {
  if (!doc || typeof doc !== 'object') return 0
  const count = (list) => (Array.isArray(list) ? list.length : 0)
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  return count(doc.elements) + count(doc.blocks) + pages.length + pages.reduce((n, p) => n + count(p?.elements), 0)
}

function hashCode(code, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(code), salt, 32).toString('hex')
  return `${salt}:${hash}`
}

function verifyCode(code, stored) {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const next = crypto.scryptSync(String(code), salt, 32).toString('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'))
  } catch {
    return false
  }
}

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('svg')) return '.svg'
  if (m.includes('avif')) return '.avif'
  return '.jpg'
}

function extToMime(file) {
  const ext = file.split('.').pop().toLowerCase()
  return { png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'image/jpeg'
}

export function createApi(stores, { allowedEmails = [] } = {}) {
  /** The published board's owner may always sign up; others need ALLOWED_EMAILS. */
  async function canSignUp(email, origin) {
    if (allowedEmails.includes(email)) return true
    const snap = await publishedSnapshot(origin)
    return Boolean(snap?.email && snap.email.toLowerCase() === email)
  }

  async function publishedSnapshot(origin) {
    try {
      const res = await fetch(`${origin}/snapshot.json`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      const data = await res.json()
      return data?.doc && data?.email ? data : null
    } catch {
      return null
    }
  }

  async function emailFromAuth(req) {
    const header = req.headers.get('authorization') || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || !/^[a-f0-9]{48}$/.test(token)) return null
    const session = await stores.sessions.get(token, { type: 'json' })
    if (!session?.email) return null
    if (Date.now() - Date.parse(session.createdAt) > SESSION_DAYS * 864e5) {
      await stores.sessions.delete(token)
      return null
    }
    return session.email
  }

  async function storeAsset(buf, mime) {
    if (!buf?.length) throw new Error('Empty image.')
    if (buf.length > MAX_ASSET_BYTES) throw new Error('Image too large.')
    const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40)}${mimeToExt(mime)}`
    const existing = await stores.assets.getMetadata?.(file)
    if (!existing) await stores.assets.set(file, buf, { metadata: { mime } })
    return `/api/assets/${file}`
  }

  /** Move inline data-URL images into the asset store so the board JSON stays small. */
  async function externalizeImages(doc) {
    async function convert(list) {
      if (!Array.isArray(list)) return list
      return Promise.all(
        list.map(async (e) => {
          if (!e || e.type !== 'image' || typeof e.src !== 'string' || !e.src.startsWith('data:')) return e
          const m = e.src.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i)
          if (!m) return e
          try {
            return { ...e, src: await storeAsset(Buffer.from(m[2].replace(/\s/g, ''), 'base64'), m[1]) }
          } catch {
            return e
          }
        })
      )
    }
    const next = { ...doc }
    if (Array.isArray(doc.elements)) next.elements = await convert(doc.elements)
    if (Array.isArray(doc.blocks)) next.blocks = await convert(doc.blocks)
    if (Array.isArray(doc.pages)) {
      next.pages = await Promise.all(
        doc.pages.map(async (p) => (p && Array.isArray(p.elements) ? { ...p, elements: await convert(p.elements) } : p))
      )
    }
    return next
  }

  async function readBody(req) {
    try {
      return await req.json()
    } catch {
      return {}
    }
  }

  const routes = {
    'GET /api/health': async () => json({ ok: true }),

    'POST /api/login': async (req, { origin }) => {
      const body = await readBody(req)
      const email = String(body?.email || '').trim().toLowerCase()
      const code = String(body?.code || '')
      if (!email || !email.includes('@')) return json({ error: 'Enter a valid email.' }, 400)
      if (code.length < 4) return json({ error: 'Code must be at least 4 characters.' }, 400)

      const user = await stores.users.get(email, { type: 'json' })
      if (!user) {
        if (!(await canSignUp(email, origin))) {
          return json({ error: 'This board is private. Use the owner’s email.' }, 403)
        }
        await stores.users.setJSON(email, { codeHash: hashCode(code), createdAt: new Date().toISOString() })
      } else {
        if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
          return json({ error: 'Too many wrong codes. Try again in a few minutes.' }, 429)
        }
        if (!verifyCode(code, user.codeHash)) {
          const failed = (user.failed || 0) + 1
          const locked = failed >= MAX_FAILED_LOGINS
          await stores.users.setJSON(email, {
            ...user,
            failed: locked ? 0 : failed,
            lockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 6e4).toISOString() : null,
          })
          return json({ error: 'Wrong code for that email.' }, 401)
        }
        if (user.failed || user.lockedUntil) await stores.users.setJSON(email, { ...user, failed: 0, lockedUntil: null })
      }

      const token = crypto.randomBytes(24).toString('hex')
      await stores.sessions.setJSON(token, { email, createdAt: new Date().toISOString() })
      return json({ token, email })
    },

    'POST /api/logout': async (req) => {
      const header = req.headers.get('authorization') || ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (token) await stores.sessions.delete(token)
      return json({ ok: true })
    },

    'GET /api/me': async (req) => {
      const email = await emailFromAuth(req)
      return email ? json({ email }) : json({ error: 'Not signed in.' }, 401)
    },

    'GET /api/canvas': async (req, { origin }) => {
      const email = await emailFromAuth(req)
      if (!email) return json({ error: 'Not signed in.' }, 401)
      const doc = await stores.boards.get(email, { type: 'json' })
      if (doc) return json(doc)
      // First cloud visit: start from the board published from your computer.
      const snap = await publishedSnapshot(origin)
      if (snap && snap.email.toLowerCase() === email) {
        await stores.boards.setJSON(email, snap.doc)
        return json(snap.doc)
      }
      return json(emptyDoc())
    },

    'PUT /api/canvas': async (req) => {
      const email = await emailFromAuth(req)
      if (!email) return json({ error: 'Not signed in.' }, 401)
      const body = await readBody(req)
      const doc = body?.doc
      if (!doc || typeof doc !== 'object') return json({ error: 'Missing canvas document.' }, 400)
      const prev = await stores.boards.get(email, { type: 'json' })
      // Guard against reload races wiping a full board with an empty one.
      if (prev && boardWeight(prev) > 0 && boardWeight(doc) === 0 && !body?.allowEmpty) {
        return json({ error: 'Refusing to overwrite your board with an empty canvas. Refresh to reload.' }, 409)
      }
      const stored = await externalizeImages(doc)
      await stores.boards.setJSON(email, stored)
      return json({ ok: true, elements: Array.isArray(stored.elements) ? stored.elements.length : 0 })
    },

    'POST /api/assets': async (req) => {
      const email = await emailFromAuth(req)
      if (!email) return json({ error: 'Not signed in.' }, 401)
      try {
        const buf = Buffer.from(await req.arrayBuffer())
        const mime = String(req.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
        return json({ src: await storeAsset(buf, mime.startsWith('image/') ? mime : 'image/jpeg') })
      } catch (err) {
        return json({ error: err.message || 'Couldn’t save image.' }, 400)
      }
    },

    'POST /api/fetch-product': fetchProductRoute,
    'POST /api/fetch-price': fetchProductRoute,

    'POST /api/fetch-image': async (req) => {
      const email = await emailFromAuth(req)
      if (!email) return json({ error: 'Not signed in.' }, 401)
      let url
      try {
        url = assertFetchableUrl((await readBody(req))?.url)
      } catch (err) {
        return json({ error: err.message || 'Invalid URL.' }, 400)
      }
      const got = await fetchImage(url)
      if (!got) return json({ error: 'Couldn’t download that image.' }, 422)
      // Keep a copy so the picture survives if the original goes away.
      let src = got.image
      if (got.imageDataUrl) {
        const m = got.imageDataUrl.match(/^data:([^;]+);base64,(.*)$/)
        if (m) src = await storeAsset(Buffer.from(m[2], 'base64'), m[1]).catch(() => got.image)
      }
      return json({ url, image: src, imageDataUrl: got.imageDataUrl || src })
    },
  }

  async function fetchProductRoute(req) {
    const email = await emailFromAuth(req)
    if (!email) return json({ error: 'Not signed in.' }, 401)
    let url
    try {
      url = assertFetchableUrl((await readBody(req))?.url)
    } catch (err) {
      return json({ error: err.message || 'Invalid URL.' }, 400)
    }
    const empty = { url, price: null, currency: null, title: null, image: null, imageDataUrl: null, source: null }
    try {
      const page = await fetchPage(url)
      if (!page.ok) return json({ ...empty, warning: `Couldn’t read that page (${page.status})` })
      const meta = extractProductMeta(page.html, url)
      let image = meta.image
      let imageDataUrl = null
      if (meta.image) {
        const got = await fetchImage(meta.image)
        if (got?.imageDataUrl) {
          const m = got.imageDataUrl.match(/^data:([^;]+);base64,(.*)$/)
          image = m ? await storeAsset(Buffer.from(m[2], 'base64'), m[1]).catch(() => got.image) : got.image
          imageDataUrl = got.imageDataUrl
        } else if (got) {
          image = got.image
        }
      }
      return json({ url, price: meta.price, currency: meta.currency, title: meta.title, image, imageDataUrl, source: meta.source })
    } catch (err) {
      console.error('fetch-product', err)
      return json({ ...empty, warning: 'Couldn’t fetch that product page' })
    }
  }

  async function serveAsset(file) {
    if (!ASSET_RE.test(file)) return new Response(null, { status: 404 })
    const hit = await stores.assets.getWithMetadata(file, { type: 'arrayBuffer' })
    if (!hit) return new Response(null, { status: 404 })
    return new Response(hit.data, {
      headers: {
        'Content-Type': hit.metadata?.mime || extToMime(file),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }

  return async function handle(req) {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '')
    try {
      if (req.method === 'GET' && path.startsWith('/api/assets/')) {
        return await serveAsset(decodeURIComponent(path.slice('/api/assets/'.length)))
      }
      const route = routes[`${req.method} ${path}`]
      if (!route) return json({ error: 'Not found.' }, 404)
      return await route(req, { origin: url.origin })
    } catch (err) {
      console.error('api', req.method, path, err)
      return json({ error: 'Something went wrong. Try again.' }, 500)
    }
  }
}
