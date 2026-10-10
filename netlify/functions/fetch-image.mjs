import { fetchImage, json, readTargetUrl } from '../lib/remote.js'

/** Published-site twin of POST /api/fetch-image: copy a remote picture so it can't break later. */
export default async (req) => {
  let url
  try {
    url = await readTargetUrl(req)
  } catch (err) {
    return json({ error: err.message || 'Invalid URL.' }, err.status || 400)
  }
  const got = await fetchImage(url)
  if (!got) return json({ error: 'Couldn’t download that image.' }, 422)
  return json({ url, image: got.image, imageDataUrl: got.imageDataUrl || got.image })
}
