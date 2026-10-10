/**
 * Product-page scraping shared by the local API (server/index.js) and the
 * Netlify functions that serve the published site.
 */

/** Browser-like headers; many shops refuse requests without them. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export function assertFetchableUrl(raw) {
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
export function upgradeImageUrl(raw) {
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

export function extractProductMeta(html, pageUrl) {
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
