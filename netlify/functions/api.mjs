import { getStore } from '@netlify/blobs'
import { createApi } from '../lib/cloud.js'

let handle = null

/** Cloud saving for the published site: the same /api routes as server/index.js. */
export default async (req) => {
  if (!handle) {
    const store = (name) => getStore({ name, consistency: 'strong' })
    const allowedEmails = String(process.env.ALLOWED_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    handle = createApi(
      { users: store('users'), sessions: store('sessions'), boards: store('boards'), assets: store('assets') },
      { allowedEmails }
    )
  }
  return handle(req)
}

// Committed board images in public/api/assets keep being served as static files.
export const config = { path: '/api/*', preferStatic: true }
