import { extractProductMeta } from '../../server/product-meta.js'
import { fetchImage, fetchPage, json, readTargetUrl } from '../lib/remote.js'

/** Published-site twin of POST /api/fetch-product: picture, title and price for a shop link. */
export default async (req) => {
  let url
  try {
    url = await readTargetUrl(req)
  } catch (err) {
    return json({ error: err.message || 'Invalid URL.' }, err.status || 400)
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
      if (got) {
        image = got.image
        imageDataUrl = got.imageDataUrl
      }
    }
    return json({ url, price: meta.price, currency: meta.currency, title: meta.title, image, imageDataUrl, source: meta.source })
  } catch (err) {
    console.error('fetch-product', err)
    return json({ ...empty, warning: 'Couldn’t fetch that product page' })
  }
}
