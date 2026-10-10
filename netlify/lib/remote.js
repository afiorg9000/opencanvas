import { BROWSER_UA, assertFetchableUrl, upgradeImageUrl } from '../../server/product-meta.js'

// Base64 grows images by a third and function responses cap at 6 MB, so keep
// inline copies small; bigger images fall back to their original URL.
const MAX_INLINE_BYTES = 1_500_000
const MAX_IMAGE_BYTES = 8_000_000

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** Only this site may use the proxy, so it can't be borrowed by other pages. */
export function sameSite(req) {
  const self = new URL(req.url).host
  const from = req.headers.get('origin') || req.headers.get('referer')
  if (!from) return false
  try {
    return new URL(from).host === self
  } catch {
    return false
  }
}

/** Read `{ url }` from a POST body and validate it like the local API does. */
export async function readTargetUrl(req) {
  if (req.method !== 'POST') throw Object.assign(new Error('Use POST.'), { status: 405 })
  if (!sameSite(req)) throw Object.assign(new Error('Not allowed.'), { status: 403 })
  let body = null
  try {
    body = await req.json()
  } catch {
    /* handled below */
  }
  try {
    return assertFetchableUrl(body?.url)
  } catch (err) {
    throw Object.assign(err, { status: 400 })
  }
}

export async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!res.ok) return { ok: false, status: res.status, html: '' }
  return { ok: true, status: res.status, html: await res.text() }
}

/** Download an image and return it inline when small enough to send back. */
export async function fetchImage(imageUrl) {
  const candidates = [upgradeImageUrl(imageUrl), imageUrl].filter((u, i, arr) => u && arr.indexOf(u) === i)
  for (const candidate of candidates) {
    try {
      assertFetchableUrl(candidate)
      const res = await fetch(candidate, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: new URL(candidate).origin + '/',
        },
      })
      if (!res.ok) continue
      const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
      if (!mime.startsWith('image/')) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue
      const imageDataUrl = buf.length <= MAX_INLINE_BYTES ? `data:${mime};base64,${buf.toString('base64')}` : null
      return { image: candidate, imageDataUrl }
    } catch (err) {
      console.error('fetch image candidate', candidate, err.message || err)
    }
  }
  return null
}
