import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'data')
const dbPath = path.join(dataDir, 'canvas.db')
const assetsSrc = path.join(dataDir, 'assets')
const publicDir = path.join(root, 'public')
const assetsDest = path.join(publicDir, 'api', 'assets')
const snapshotPath = path.join(publicDir, 'snapshot.json')

function boardWeight(doc) {
  if (!doc || typeof doc !== 'object') return 0
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const top = Array.isArray(doc.elements) ? doc.elements.length : 0
  const nested = pages.reduce((n, p) => n + (Array.isArray(p?.elements) ? p.elements.length : 0), 0)
  return top + nested
}

if (!fs.existsSync(dbPath)) {
  console.error('No local board at data/canvas.db — run the app on this computer first.')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
try {
  db.pragma('wal_checkpoint(PASSIVE)')
} catch {
  /* readonly may skip checkpoint; WAL is still readable */
}

const rows = db.prepare('select email, doc from boards').all()
let best = null
for (const row of rows) {
  let doc
  try {
    doc = JSON.parse(row.doc)
  } catch {
    continue
  }
  const w = boardWeight(doc)
  if (!best || w > best.w) best = { email: row.email, doc, w }
}
db.close()

if (!best || best.w === 0) {
  console.error('Local database has no pages to publish.')
  process.exit(1)
}

fs.mkdirSync(assetsDest, { recursive: true })
if (fs.existsSync(assetsSrc)) {
  for (const name of fs.readdirSync(assetsSrc)) {
    const from = path.join(assetsSrc, name)
    if (!fs.statSync(from).isFile()) continue
    fs.copyFileSync(from, path.join(assetsDest, name))
  }
}

const snapshot = {
  email: best.email,
  exportedAt: new Date().toISOString(),
  doc: best.doc,
}
fs.writeFileSync(snapshotPath, JSON.stringify(snapshot))
console.log(`Exported ${best.email} (${best.w} items) → public/snapshot.json`)
console.log(`Copied images → public/api/assets`)
