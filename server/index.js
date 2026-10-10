import cors from 'cors'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Database from 'better-sqlite3'
import { assertFetchableUrl, extractProductMeta, upgradeImageUrl } from './product-meta.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const assetsDir = path.join(dataDir, 'assets')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(assetsDir, { recursive: true })

const db = new Database(path.join(dataDir, 'canvas.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  create table if not exists users (
    email text primary key,
    code_hash text not null,
    created_at text not null
  );
  create table if not exists sessions (
    token text primary key,
    email text not null references users(email) on delete cascade,
    created_at text not null
  );
  create table if not exists boards (
    email text primary key references users(email) on delete cascade,
    doc text not null,
    updated_at text not null
  );
`)

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

/** Pages plus items on them (and legacy top-level elements/blocks). */
function boardWeight(doc) {
  if (!doc || typeof doc !== 'object') return 0
  const count = (list) => (Array.isArray(list) ? list.length : 0)
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  return (
    count(doc.elements) +
    count(doc.blocks) +
    pages.length +
    pages.reduce((n, p) => n + count(p?.elements), 0)
  )
}

function emptyDoc() {
  return { elements: [], nextId: 1, scale: 1, ox: 0, oy: 0 }
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

/** Move inline data-URL images onto disk so the board JSON stays small. */
function externalizeImageDataUrls(doc) {
  if (!doc || typeof doc !== 'object') return { doc, changed: false }

  function convertList(list, typeKey = 'type') {
    if (!Array.isArray(list)) return { list, changed: false }
    let changed = false
    const next = list.map((e) => {
      if (!e || e[typeKey] !== 'image' || typeof e.src !== 'string') return e
      if (!e.src.startsWith('data:')) return e
      const match = e.src.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i)
      if (!match) return e
      try {
        const mime = match[1]
        const buf = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
        if (!buf.length || buf.length > 8_000_000) return e
        const src = storeAssetBuffer(buf, mime)
        changed = true
        return { ...e, src }
      } catch {
        return e
      }
    })
    return { list: next, changed }
  }

  let changed = false
  let next = { ...doc }
  if (Array.isArray(doc.elements)) {
    const r = convertList(doc.elements, 'type')
    if (r.changed) {
      next.elements = r.list
      changed = true
    }
  }
  if (Array.isArray(doc.blocks)) {
    const r = convertList(doc.blocks, 'type')
    if (r.changed) {
      next.blocks = r.list
      changed = true
    }
  }
  if (Array.isArray(doc.pages)) {
    next.pages = doc.pages.map((p) => {
      if (!p || !Array.isArray(p.elements)) return p
      const r = convertList(p.elements, 'type')
      if (r.changed) changed = true
      return { ...p, elements: r.list }
    })
  }
  return { doc: changed ? next : doc, changed }
}

function readBoardDoc(email) {
  const row = db.prepare('select doc from boards where email = ?').get(email)
  if (!row) return emptyDoc()
  try {
    const parsed = JSON.parse(row.doc)
    const { doc, changed } = externalizeImageDataUrls(parsed)
    if (changed) {
      db.prepare(
        `insert into boards (email, doc, updated_at) values (?, ?, ?)
         on conflict(email) do update set doc = excluded.doc, updated_at = excluded.updated_at`
      ).run(email, JSON.stringify(doc), new Date().toISOString())
    }
    return doc
  } catch {
    return emptyDoc()
  }
}

function getEmailFromAuth(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return null
  const row = db.prepare('select email from sessions where token = ?').get(token)
  return row?.email || null
}

function storeAssetBuffer(buf, mime) {
  if (!buf?.length) throw new Error('Empty image.')
  if (buf.length > 8_000_000) throw new Error('Image too large.')
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40)
  const file = `${hash}${mimeToExt(mime)}`
  const fp = path.join(assetsDir, file)
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf)
  return `/api/assets/${file}`
}

const app = express()
app.use(cors())

app.post('/api/assets', express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
  const email = getEmailFromAuth(req)
  if (!email) return res.status(401).json({ error: 'Not signed in.' })
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || [])
    const mime = String(req.headers['content-type'] || 'image/jpeg').split(';')[0].trim()
    const src = storeAssetBuffer(buf, mime.startsWith('image/') ? mime : 'image/jpeg')
    res.json({ src })
  } catch (err) {
    res.status(400).json({ error: err.message || 'Couldn’t save image.' })
  }
})

app.use(express.json({ limit: '100mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/assets/:file', (req, res) => {
  const file = path.basename(String(req.params.file || ''))
  if (!/^[a-f0-9]{16,64}\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file)) {
    return res.status(404).end()
  }
  const fp = path.join(assetsDir, file)
  if (!fs.existsSync(fp)) return res.status(404).end()
  res.sendFile(fp)
})

/** First visit with an email creates the account; later visits need the same code. */
app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  const code = String(req.body?.code || '')
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Enter a valid email.' })
  }
  if (code.length < 4) {
    return res.status(400).json({ error: 'Code must be at least 4 characters.' })
  }

  const existing = db.prepare('select email, code_hash from users where email = ?').get(email)
  if (!existing) {
    db.prepare('insert into users (email, code_hash, created_at) values (?, ?, ?)').run(
      email,
      hashCode(code),
      new Date().toISOString()
    )
  } else if (!verifyCode(code, existing.code_hash)) {
    return res.status(401).json({ error: 'Wrong code for that email.' })
  }

  const token = crypto.randomBytes(24).toString('hex')
  db.prepare('insert into sessions (token, email, created_at) values (?, ?, ?)').run(
    token,
    email,
    new Date().toISOString()
  )

  res.json({ token, email })
})

app.post('/api/logout', (req, res) => {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token) db.prepare('delete from sessions where token = ?').run(token)
  res.json({ ok: true })
})

app.get('/api/me', (req, res) => {
  const email = getEmailFromAuth(req)
  if (!email) return res.status(401).json({ error: 'Not signed in.' })
  res.json({ email })
})

app.get('/api/canvas', (req, res) => {
  const email = getEmailFromAuth(req)
  if (!email) return res.status(401).json({ error: 'Not signed in.' })
  res.json(readBoardDoc(email))
})

app.put('/api/canvas', (req, res) => {
  const email = getEmailFromAuth(req)
  if (!email) return res.status(401).json({ error: 'Not signed in.' })
  const doc = req.body?.doc
  if (!doc || typeof doc !== 'object') {
    return res.status(400).json({ error: 'Missing canvas document.' })
  }

  const existing = db.prepare('select doc from boards where email = ?').get(email)
  if (existing) {
    try {
      const prev = JSON.parse(existing.doc)
      // Guard against reload races wiping a full board with an empty one.
      // Count every page: the top-level `elements` is only the open page, so an
      // empty page, a cleared page or the library view must not look like a wipe.
      if (boardWeight(prev) > 0 && boardWeight(doc) === 0 && !req.body?.allowEmpty) {
        return res.status(409).json({
          error: 'Refusing to overwrite your board with an empty canvas. Refresh to reload.',
        })
      }
    } catch {
      /* ignore corrupt previous */
    }
  }

  const { doc: stored } = externalizeImageDataUrls(doc)
  db.prepare(
    `insert into boards (email, doc, updated_at) values (?, ?, ?)
     on conflict(email) do update set doc = excluded.doc, updated_at = excluded.updated_at`
  ).run(email, JSON.stringify(stored), new Date().toISOString())
  res.json({ ok: true, elements: Array.isArray(stored.elements) ? stored.elements.length : 0 })
})

async function fetchImageToAsset(imageUrl) {
  const candidates = [upgradeImageUrl(imageUrl), imageUrl].filter(
    (u, i, arr) => u && arr.indexOf(u) === i
  )
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: new URL(candidate).origin + '/',
        },
      })
      if (!response.ok) continue
      const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
      if (!mime.startsWith('image/')) continue
      const buf = Buffer.from(await response.arrayBuffer())
      if (!buf.length || buf.length > 8_000_000) continue
      const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40)
      const file = `${hash}${mimeToExt(mime)}`
      const fp = path.join(assetsDir, file)
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf)
      const src = `/api/assets/${file}`
      // Keep a data URL only for modest images so older clients still work
      const imageDataUrl =
        buf.length <= 1_500_000 ? `data:${mime};base64,${buf.toString('base64')}` : null
      return { src, imageDataUrl, image: candidate }
    } catch (err) {
      console.error('fetch image candidate', candidate, err.message || err)
    }
  }
  return null
}

async function fetchImageDataUrl(imageUrl) {
  const stored = await fetchImageToAsset(imageUrl)
  if (!stored) return null
  if (stored.imageDataUrl) return stored.imageDataUrl
  // Large images: return asset path as a pseudo-data marker handled by client via `image`
  return null
}

async function handleFetchProduct(req, res) {
  const email = getEmailFromAuth(req)
  if (!email) return res.status(401).json({ error: 'Not signed in.' })

  let url
  try {
    url = assertFetchableUrl(req.body?.url)
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid URL.' })
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!response.ok) {
      // Many shops block scrapers — still return the URL so the client can save the link
      return res.json({
        url,
        price: null,
        currency: null,
        title: null,
        image: null,
        imageDataUrl: null,
        source: null,
        warning: `Couldn’t read that page (${response.status})`,
      })
    }
    const html = await response.text()
    const meta = extractProductMeta(html, url)
    let imageDataUrl = null
    let imageSrc = meta.image
    if (meta.image) {
      try {
        const stored = await fetchImageToAsset(meta.image)
        if (stored) {
          imageSrc = stored.src
          imageDataUrl = stored.imageDataUrl || stored.src
        }
      } catch (err) {
        console.error('product image', err)
      }
    }
    res.json({
      url,
      price: meta.price,
      currency: meta.currency,
      title: meta.title,
      image: imageSrc,
      imageDataUrl,
      source: meta.source,
    })
  } catch (err) {
    console.error('fetch-product', err)
    // Soft-fail: valid URL but unreachable — client can still keep the link
    res.json({
      url,
      price: null,
      currency: null,
      title: null,
      image: null,
      imageDataUrl: null,
      source: null,
      warning: 'Couldn’t fetch that product page',
    })
  }
}

app.post('/api/fetch-product', handleFetchProduct)
app.post('/api/fetch-price', handleFetchProduct)

app.post('/api/fetch-image', async (req, res) => {
  const email = getEmailFromAuth(req)
  if (!email) return res.status(401).json({ error: 'Not signed in.' })

  let url
  try {
    url = assertFetchableUrl(req.body?.url)
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid URL.' })
  }

  try {
    const stored = await fetchImageToAsset(url)
    if (!stored) {
      return res.status(422).json({ error: 'Couldn’t download that image.' })
    }
    res.json({
      url,
      image: stored.src,
      imageDataUrl: stored.imageDataUrl || stored.src,
    })
  } catch (err) {
    console.error('fetch-image', err)
    res.status(502).json({ error: 'Couldn’t download that image.' })
  }
})

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'
const distDir = path.join(__dirname, '..', 'dist')
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, host, () => {
  console.log(`Open Canvas on http://${host}:${port}`)
})
