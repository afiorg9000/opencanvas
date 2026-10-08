import cors from 'cors'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Database from 'better-sqlite3'

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

function countBoardContent(doc) {
  if (!doc || typeof doc !== 'object') return 0
  const els = Array.isArray(doc.elements) ? doc.elements.length : 0
  const blocks = Array.isArray(doc.blocks) ? doc.blocks.length : 0
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const nested = pages.reduce((n, p) => n + (Array.isArray(p?.elements) ? p.elements.length : 0), 0)
  return els + blocks + nested
}

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
      if (countBoardContent(prev) > 0 && countBoardContent(doc) === 0 && !req.body?.allowEmpty) {
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

function assertFetchableUrl(raw) {
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    throw new Error('Enter a valid product link.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Link must be http or https.')
  }
  const host = u.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('That link can’t be fetched.')
  }
  return u.toString()
}

function parseMoney(raw) {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw * 100) / 100
  const s = String(raw).replace(/,/g, '').trim()
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function priceFromJsonLd(node, depth = 0) {
  if (!node || depth > 8) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const p = priceFromJsonLd(item, depth + 1)
      if (p != null) return p
    }
    return null
  }
  if (typeof node !== 'object') return null

  const offer = node.offers || node.offer
  if (offer) {
    const fromOffer = priceFromJsonLd(offer, depth + 1)
    if (fromOffer != null) return fromOffer
  }

  const direct =
    parseMoney(node.price) ??
    parseMoney(node.lowPrice) ??
    parseMoney(node.highPrice) ??
    parseMoney(node.priceAmount)
  if (direct != null) return { price: direct, currency: node.priceCurrency || node.currency || null }

  if (node['@graph']) return priceFromJsonLd(node['@graph'], depth + 1)
  return null
}

function imageFromJsonLd(node, depth = 0) {
  if (!node || depth > 8) return null
  if (typeof node === 'string') {
    const s = node.trim()
    return /^https?:\/\//i.test(s) ? s : null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const img = imageFromJsonLd(item, depth + 1)
      if (img) return img
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.image) {
    const img = imageFromJsonLd(node.image, depth + 1)
    if (img) return img
  }
  if (node.contentUrl && /^https?:\/\//i.test(node.contentUrl)) return node.contentUrl
  if (node.url && /^https?:\/\//i.test(node.url)) {
    const type = String(node['@type'] || '').toLowerCase()
    if (type.includes('image')) return node.url
  }
  if (node['@graph']) return imageFromJsonLd(node['@graph'], depth + 1)
  return null
}

/** Collect every image URL from JSON-LD (including arrays), not just the first. */
function collectImagesFromJsonLd(node, out = [], depth = 0) {
  if (!node || depth > 10 || out.length > 40) return out
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node.trim())) out.push(node.trim())
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectImagesFromJsonLd(item, out, depth + 1)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.image) collectImagesFromJsonLd(node.image, out, depth + 1)
  if (node.contentUrl) collectImagesFromJsonLd(node.contentUrl, out, depth + 1)
  if (node.thumbnailUrl) collectImagesFromJsonLd(node.thumbnailUrl, out, depth + 1)
  if (node.url && String(node['@type'] || '').toLowerCase().includes('image')) {
    collectImagesFromJsonLd(node.url, out, depth + 1)
  }
  if (node['@graph']) collectImagesFromJsonLd(node['@graph'], out, depth + 1)
  return out
}

/** Rewrite common CDN thumbnail URLs to a larger/full version. */
function upgradeImageUrl(raw) {
  if (!raw) return raw
  let url = String(raw).trim()
  try {
    const u = new URL(url)
    let path = u.pathname
    // Shopify / many stores: file_100x.jpg, file_large.jpg
    path = path.replace(
      /_(?:pico|icon|thumb|small|compact|medium|large|grande|\d+x\d*|\d*x\d+)(?=\.[a-z0-9]+$)/i,
      ''
    )
    // Amazon media: image._SX300_SY300_.jpg → image.jpg
    path = path.replace(/\._[A-Z0-9,_]+_(?=\.)/, '')
    // Facebook/Instagram sized paths
    path = path.replace(/\/[sp]\d+x\d+\//i, '/')
    // Cloudinary transforms between upload/ and public id
    path = path.replace(/\/image\/upload\/(?:[^/]+\/)+(?=v\d+\/|[^/]+$)/, '/image/upload/')
    u.pathname = path
    // Strip size-y query params used by some CDNs (keep cache busters like v=)
    for (const key of [...u.searchParams.keys()]) {
      if (/^(w|h|width|height|resize|fit|crop|quality|q|auto|dpr|fm)$/i.test(key)) {
        u.searchParams.delete(key)
      }
    }
    url = u.toString()
  } catch {
    /* keep raw */
  }
  url = url.replace(/=s\d{2,4}(-c)?(?=$|[&#])/i, '=s2000$1')
  url = url.replace(/([?&])format=\d+w/i, '$1format=2500w')
  url = url.replace(/\/w=\d+/gi, '/w=2000')
  url = url.replace(/\/h=\d+/gi, '')
  return url
}

function scoreImageCandidate(url) {
  const s = String(url).toLowerCase()
  let score = 0
  if (/orig|original|full|master|large|xlarge|zoom|1500|1600|2000|2048|2500|3000/.test(s)) score += 8
  if (/\.(jpe?g|png|webp)(\?|$)/i.test(s)) score += 2
  if (/thumb|tiny|small|icon|sprite|logo|avatar|1x1|pixel|\b\d{2,3}x\d{2,3}\b/.test(s)) score -= 10
  if (/og|product|cdn|media|images/.test(s)) score += 1
  // Prefer longer paths (often higher-res assets)
  score += Math.min(6, Math.floor(s.length / 80))
  return score
}

function pickBestImage(candidates, pageUrl) {
  const seen = new Set()
  const ranked = []
  for (const raw of candidates) {
    if (!raw) continue
    let abs = resolveUrl(String(raw).trim(), pageUrl)
    if (!abs || !/^https?:\/\//i.test(abs)) continue
    abs = upgradeImageUrl(abs)
    if (seen.has(abs)) continue
    seen.add(abs)
    ranked.push({ url: abs, score: scoreImageCandidate(abs) })
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked[0]?.url || null
}

function firstMetaContent(html, properties) {
  for (const prop of properties) {
    const re1 = new RegExp(
      `(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
      'i'
    )
    const re2 = new RegExp(
      `content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
      'i'
    )
    const m = html.match(re1) || html.match(re2)
    if (m?.[1]) return m[1].trim()
  }
  return null
}

function allMetaContents(html, properties) {
  const out = []
  for (const prop of properties) {
    const re = new RegExp(
      `(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
      'gi'
    )
    let m
    while ((m = re.exec(html))) {
      out.push((m[1] || m[2] || '').trim())
    }
  }
  return out.filter(Boolean)
}

function resolveUrl(maybeRelative, pageUrl) {
  try {
    return new URL(maybeRelative, pageUrl).toString()
  } catch {
    return null
  }
}

function extractProductMeta(html, pageUrl) {
  let title =
    firstMetaContent(html, ['og:title', 'twitter:title']) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
    null
  if (title) title = title.slice(0, 140)

  const candidates = []
  candidates.push(
    ...allMetaContents(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'])
  )
  const linkImage = html.match(
    /<link[^>]+rel=["'](?:image_src|preload)["'][^>]+href=["']([^"']+)["']/i
  )
  if (linkImage?.[1]) candidates.push(linkImage[1])

  let price = null
  let currency = null
  let source = null

  const ldBlocks = [
    ...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ]
  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block[1].trim())
      candidates.push(...collectImagesFromJsonLd(data))
      if (price == null) {
        const found = priceFromJsonLd(data)
        if (found?.price != null) {
          price = found.price
          currency = found.currency || 'USD'
          source = 'json-ld'
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // Product-looking <img> tags (skip tiny icons)
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const src =
      tag.match(/\b(?:src|data-src|data-original|data-zoom-image|data-large_image)=["']([^"']+)["']/i)?.[1] ||
      tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1]?.split(',')?.pop()?.trim()?.split(/\s+/)?.[0]
    if (!src || src.startsWith('data:')) continue
    const cls = (tag.match(/\bclass=["']([^"']+)["']/i)?.[1] || '').toLowerCase()
    const alt = (tag.match(/\balt=["']([^"']+)["']/i)?.[1] || '').toLowerCase()
    if (/logo|icon|sprite|avatar|badge|pixel|tracking/.test(cls + alt + src)) continue
    if (/product|gallery|zoom|main|hero|media|primary|featured/.test(cls + alt + src)) {
      candidates.unshift(src)
    } else {
      candidates.push(src)
    }
  }

  if (price == null) {
    const metaPatterns = [
      [/property=["']og:price:amount["'][^>]*content=["']([^"']+)["']/i, /content=["']([^"']+)["'][^>]*property=["']og:price:amount["']/i],
      [/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i, /content=["']([^"']+)["'][^>]*property=["']product:price:amount["']/i],
      [/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i, /content=["']([^"']+)["'][^>]*itemprop=["']price["']/i],
      [/name=["']price["'][^>]*content=["']([^"']+)["']/i, /content=["']([^"']+)["'][^>]*name=["']price["']/i],
    ]
    for (const pair of metaPatterns) {
      for (const re of pair) {
        const m = html.match(re)
        const p = m ? parseMoney(m[1]) : null
        if (p != null) {
          price = p
          currency = 'USD'
          source = 'meta'
          break
        }
      }
      if (price != null) break
    }
  }

  if (price == null) {
    const jsonSnippets = [
      /"priceAmount"\s*:\s*"?(?:USD\s*)?([0-9]+(?:\.[0-9]+)?)"?/i,
      /"current_price"\s*:\s*"?(?:USD\s*)?([0-9]+(?:\.[0-9]+)?)"?/i,
      /"price"\s*:\s*"?(?:USD\s*)?([0-9]+(?:\.[0-9]+)?)"?/i,
      /data-price=["']([0-9]+(?:\.[0-9]+)?)["']/i,
    ]
    for (const re of jsonSnippets) {
      const m = html.match(re)
      const p = m ? parseMoney(m[1]) : null
      if (p != null && p > 0 && p < 100000) {
        price = p
        currency = 'USD'
        source = 'page'
        break
      }
    }
  }

  const image = pickBestImage(candidates, pageUrl)

  return { price, currency, title, image, source }
}

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
