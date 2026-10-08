import { loadCanvas, saveCanvas, fetchProduct, fetchRemoteImage, uploadBoardImage } from './db.js'

/**
 * Boot the vertically scrolling canvas for a signed-in user.
 * Returns { reset } so auth can tear down on sign-out.
 */
export function startCanvas(user) {
  const viewport = document.getElementById('viewport')
  const world = document.getElementById('world')
  const elToolbar = document.getElementById('elToolbar')
  const emptyState = document.getElementById('empty')
  const zoomLabel = document.getElementById('zoomLabel')
  const saveDot = document.getElementById('saveDot')

  let scale = 1
  let elements = []
  let pages = []
  let currentPageId = null
  let viewMode = 'library'
  let selectedIds = []
  let cropState = null
  let nextId = 1
  let lastPointerWorld = { x: 120, y: 120 }
  let saveTimer = null
  let gesture = null
  let disposed = false
  let booted = false
  let hydrated = false
  let removingBg = false
  let findingPrice = false
  let applyingHistory = false
  const undoStack = []
  const redoStack = []
  const HISTORY_LIMIT = 12

  const undoBtn = document.getElementById('undoBtn')
  const redoBtn = document.getElementById('redoBtn')
  const noteBtn = document.getElementById('noteBtn')
  const titleBtn = document.getElementById('titleBtn')
  const linkBtn = document.getElementById('linkBtn')
  const homeBtn = document.getElementById('homeBtn')
  const addPageBtn = document.getElementById('addPageBtn')
  const pageTitleInput = document.getElementById('pageTitleInput')
  const libraryEl = document.getElementById('library')
  const libraryGrid = document.getElementById('libraryGrid')
  const appShell = document.getElementById('appShell')
  const containerBtn = document.getElementById('containerBtn')
  const organizeBtn = document.getElementById('organizeBtn')
  const magnetBtn = document.getElementById('magnetBtn')
  const cartBtn = document.getElementById('cartBtn')
  const cartBadge = document.getElementById('cartBadge')
  const cartPanel = document.getElementById('cartPanel')
  const cartBody = document.getElementById('cartBody')
  const cartClose = document.getElementById('cartClose')
  const guides = document.getElementById('guides')
  let marqueeEl = document.getElementById('marquee')
  if (!marqueeEl) {
    marqueeEl = document.createElement('div')
    marqueeEl.id = 'marquee'
    marqueeEl.hidden = true
    world.appendChild(marqueeEl)
  }
  let selFrame = document.getElementById('selFrame')
  if (!selFrame) {
    selFrame = document.createElement('div')
    selFrame.id = 'selFrame'
    selFrame.hidden = true
    const handle = document.createElement('div')
    handle.className = 'sel-scale-handle'
    handle.title = 'Drag to scale group'
    selFrame.appendChild(handle)
    world.appendChild(selFrame)
  }

  let magnetOn = true
  let cartOpen = false
  let clipboardItems = []
  let pasteGeneration = 0
  const SNAP = 14
  const GRID = 8
  const CLIP_MARK = '__openCanvas'
  const CLIP_STORE = 'openCanvas.clipboard'

  const uid = () => 'e' + nextId++
  const gid = () => 'g' + nextId++
  const pageUid = () => 'p' + nextId++
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const primaryId = () => selectedIds[selectedIds.length - 1] || null
  const isSelected = (id) => selectedIds.includes(id)

  function toWorld(sx, sy) {
    const vr = viewport.getBoundingClientRect()
    return {
      x: (sx - vr.left + viewport.scrollLeft) / scale,
      y: (sy - vr.top + viewport.scrollTop) / scale,
    }
  }

  const byId = (id) => world.querySelector(`[data-id="${id}"]`)
  const model = (id) => elements.find((e) => e.id === id)
  const isTextLike = (e) => e?.type === 'text' || e?.type === 'title' || e?.type === 'flow'

  function normalizeUrl(raw) {
    let t = String(raw || '').trim()
    if (!t) return ''
    // Unwrap common paste junk: <url>, markdown [text](url), quotes
    const md = t.match(/\((https?:\/\/[^)\s]+)\)/i)
    if (md) t = md[1]
    t = t.replace(/^<|>$/g, '').replace(/^["']|["']$/g, '').trim()
    const found = t.match(/https?:\/\/[^\s<>"'）]+/i) || t.match(/\bwww\.[^\s<>"']+/i)
    if (found) t = found[0]
    t = t.replace(/[),.;!?]+$/g, '')
    if (/^mailto:/i.test(t)) return t
    if (!/^https?:\/\//i.test(t)) t = 'https://' + t
    try {
      const u = new URL(t)
      if (!u.hostname || /[&?#/]/.test(u.hostname) || !u.hostname.includes('.')) return ''
      return u.toString()
    } catch {
      return ''
    }
  }

  function openExternalLink(href, ev) {
    if (ev) {
      ev.preventDefault()
      ev.stopPropagation()
    }
    const url = normalizeUrl(href)
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  function parsePrice(raw) {
    const n = parseFloat(String(raw ?? '').replace(/[^0-9.]/g, ''))
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
  }

  function formatMoney(n) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n || 0)
  }

  function hostLabel(href) {
    try {
      return new URL(href).hostname.replace(/^www\./, '')
    } catch {
      return href
    }
  }

  function stripHtml(html) {
    const d = document.createElement('div')
    d.innerHTML = html || ''
    return (d.textContent || '').trim()
  }

  function itemLabel(e) {
    if (e.type === 'container') {
      ensureContainerBlocks(e)
      const text = (e.blocks || [])
        .map((b) => stripHtml(b.html))
        .filter(Boolean)
        .join(' ')
      return (text || 'Doc').replace(/\s+/g, ' ').slice(0, 72)
    }
    if (isTextLike(e)) {
      const live = byId(e.id)?.querySelector('.content')?.innerText?.trim()
      const t = live || stripHtml(e.html) || stripHtml(e.title)
      const fallback = e.type === 'title' ? 'Title' : 'Note'
      return (t || fallback).replace(/\s+/g, ' ').slice(0, 72)
    }
    if (e.type === 'image') return e.label || 'Image'
    return 'Item'
  }

  function cartItems(status) {
    return collectElements().filter((e) => e.cartStatus === status && e.type !== 'container')
  }

  function collectElements() {
    if (viewMode === 'page') return elements
    const out = []
    for (const p of pages) {
      for (const e of p.elements || []) out.push(e)
    }
    return out
  }

  function locateElement(id) {
    const live = model(id)
    if (live) return live
    for (const p of pages) {
      const e = (p.elements || []).find((x) => x.id === id)
      if (e) return e
    }
    return null
  }

  /** Product links always live in the cart (unless saved for later). */
  function syncLinkedToCart(e) {
    if (!e || e.type === 'container') return
    if (e.href) {
      if (e.cartStatus !== 'later') e.cartStatus = 'cart'
      if (!e.qty) e.qty = 1
    }
  }

  function syncAllLinkedToCart() {
    for (const e of collectElements()) syncLinkedToCart(e)
    updateCartBadge()
    if (cartOpen) renderCart()
  }

  function cartCount() {
    return cartItems('cart').length
  }

  function cartTotal() {
    return cartItems('cart').reduce((sum, e) => sum + (Number(e.price) || 0) * (e.qty || 1), 0)
  }

  function updateCartBadge() {
    const n = cartCount()
    cartBadge.textContent = String(n)
    cartBadge.hidden = n === 0
    cartBtn.classList.toggle('on', cartOpen)
  }

  function setCartOpen(open) {
    cartOpen = open
    cartPanel.hidden = !open
    updateCartBadge()
    if (open) renderCart()
  }

  function toggleCart() {
    setCartOpen(!cartOpen)
  }

  function closeCart() {
    setCartOpen(false)
  }

  function looksLikeUrl(raw) {
    const t = String(raw || '').trim()
    return /^https?:\/\//i.test(t) || /^www\./i.test(t) || /^spotify:/i.test(t)
  }

  function parseSpotifyUrl(raw) {
    const t = String(raw || '').trim()
    if (!t) return null
    const pack = (kind, id) => {
      if (!['playlist', 'track', 'album', 'artist', 'episode', 'show'].includes(kind)) return null
      if (!/^[a-zA-Z0-9]{11,34}$/.test(id)) return null
      return {
        kind,
        id,
        href: `https://open.spotify.com/${kind}/${id}`,
        embed: `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`,
      }
    }
    const uri = t.match(/^spotify:(playlist|track|album|artist|episode|show):([a-zA-Z0-9]+)$/i)
    if (uri) return pack(uri[1].toLowerCase(), uri[2])
    try {
      const u = new URL(normalizeUrl(t))
      if (!/(^|\.)spotify\.com$/i.test(u.hostname)) return null
      const parts = u.pathname.split('/').filter(Boolean)
      let i = 0
      if (parts[0]?.startsWith('intl-')) i = 1
      if (parts[i] === 'embed') i += 1
      return pack(String(parts[i] || '').toLowerCase(), String(parts[i + 1] || '').split('?')[0])
    } catch {
      return null
    }
  }

  function spotifyEmbedSrc(e) {
    const kind = String(e?.kind || '').toLowerCase()
    const id = String(e?.spotifyId || '').trim()
    if (kind && id) return `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`
    const raw = String(e?.embed || '').trim()
    if (!raw) return ''
    try {
      const u = new URL(raw)
      u.searchParams.set('utm_source', 'generator')
      u.searchParams.delete('theme')
      return u.toString()
    } catch {
      return raw
    }
  }

  function parseGifUrl(raw) {
    const t = String(raw || '').trim()
    if (!t) return null
    let u
    try {
      u = new URL(normalizeUrl(t))
    } catch {
      return null
    }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    const path = u.pathname || ''

    if (/\.(gif)(\?|$)/i.test(path) || /[?&](?:format|fm)=gif\b/i.test(u.search)) {
      return { kind: 'file', src: u.toString(), href: u.toString() }
    }

    if (host === 'giphy.com' || host.endsWith('.giphy.com')) {
      const parts = path.split('/').filter(Boolean)
      const embedIdx = parts.indexOf('embed')
      const mediaIdx = parts.indexOf('media')
      const gifsIdx = parts.indexOf('gifs')
      let id = null
      if (embedIdx >= 0 && parts[embedIdx + 1]) id = parts[embedIdx + 1]
      else if (mediaIdx >= 0 && parts[mediaIdx + 1]) id = parts[mediaIdx + 1]
      else if (gifsIdx >= 0 && parts[gifsIdx + 1]) {
        const slug = parts[gifsIdx + 1].replace(/\.gif$/i, '')
        id = slug.split('-').pop()
      } else if (parts.length === 1) id = parts[0].replace(/\.gif$/i, '')
      id = String(id || '').split('?')[0]
      if (/^[a-zA-Z0-9]{4,32}$/.test(id)) {
        return {
          kind: 'giphy',
          id,
          href: `https://giphy.com/gifs/${id}`,
          src: `https://media.giphy.com/media/${id}/giphy.gif`,
          embed: `https://giphy.com/embed/${id}`,
        }
      }
    }

    if (host === 'tenor.com' || host.endsWith('.tenor.com')) {
      const embed = path.match(/\/embed\/(\d+)/)
      const view = path.match(/-gif-(\d+)/i) || path.match(/\/view\/[^/]*?(\d+)\s*$/)
      const id = (embed?.[1] || view?.[1] || '').trim()
      if (/^\d{4,18}$/.test(id)) {
        return {
          kind: 'tenor',
          id,
          href: u.toString(),
          embed: `https://tenor.com/embed/${id}`,
        }
      }
      if (/\.(gif|mp4|webm)(\?|$)/i.test(path)) {
        return { kind: 'file', src: u.toString(), href: u.toString() }
      }
    }

    return null
  }

  function looksLikeImageUrl(text) {
    try {
      const u = new URL(normalizeUrl(text))
      if (/\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(u.pathname)) return true
      if (/\/(?:image|images|img|media|cdn|static)\//i.test(u.pathname) && !/\.html?$/i.test(u.pathname)) {
        return /format=|\.cdn\.|cloudfront|cloudinary|shopify|imgix|giphy|tenor/i.test(u.href)
      }
      if (parseGifUrl(text)) return true
      return false
    } catch {
      return false
    }
  }

  async function ensureShopFields(e, { needLink = true, needPrice = true } = {}) {
    if (needLink && !e.href) {
      const u = prompt('Link to this item', 'https://')
      if (u == null) return false
      e.href = normalizeUrl(u)
      if (!e.href) {
        flashSave('Add a link first')
        return false
      }
      syncLinkedToCart(e)
    }
    if (needPrice && (e.price == null || e.price === '') && e.href) {
      await enrichElementFromLink(e.id, { quietFail: true, priceOnly: true })
    }
    return true
  }

  async function enrichElementFromLink(id, { quietFail = false, priceOnly = false } = {}) {
    const e = model(id)
    if (!e || !e.href) {
      if (!quietFail) flashSave('Add a product link first')
      return null
    }
    if (findingPrice) return null
    findingPrice = true
    if (isSelected(id)) buildToolbar()
    flashSave(priceOnly ? 'Finding price…' : 'Fetching product…', 5000)
    try {
      const data = await fetchProduct(e.href)
      let got = false
      if (data?.price != null) {
        e.price = data.price
        got = true
      }
      if (data?.title && (e.type === 'image' || !priceOnly)) {
        e.label = data.title
      }
      if (!priceOnly && e.type === 'image') {
        const nextSrc = data?.imageDataUrl || data?.image
        if (nextSrc) {
          e.src = nextSrc
          got = true
        }
      }
      syncLinkedToCart(e)
      render(e)
      if (isSelected(id)) buildToolbar()
      renderCart()
      scheduleSave()
      if (data?.price != null) {
        flashSave(`Found ${formatMoney(data.price)}`)
        return data
      }
      if (got) {
        flashSave('Updated from link')
        return data
      }
      if (data?.warning) {
        if (!quietFail) flashSave(data.warning + ' — link kept', 3200)
        return data
      }
      if (!quietFail) flashSave('No price found on that page — edit it in the cart', 3200)
      else flashSave('No price found — you can edit it in the cart', 3200)
      return data
    } catch (err) {
      console.error(err)
      if (!quietFail) flashSave(err.message || 'Couldn’t fetch product', 3200)
      else flashSave('Couldn’t fetch price — edit it in the cart', 3200)
      return null
    } finally {
      findingPrice = false
      if (isSelected(id)) buildToolbar()
    }
  }

  function findPriceForElement(id, opts) {
    return enrichElementFromLink(id, { ...opts, priceOnly: true })
  }

  function addSpotifyFromUrl(rawUrl, wx, wy) {
    const spotify = parseSpotifyUrl(rawUrl)
    if (!spotify) {
      flashSave('Need a Spotify link')
      return null
    }
    if (viewMode !== 'page') createLibraryPage()
    const compact = spotify.kind === 'track' || spotify.kind === 'episode'
    const w = 352
    const h = compact ? 152 : 352
    const x = (wx ?? lastPointerWorld.x) - w / 2
    const y = Math.max(0, (wy ?? lastPointerWorld.y) - 24)
    const e = {
      id: uid(),
      type: 'spotify',
      x: Math.max(0, x),
      y,
      w,
      h,
      href: spotify.href,
      embed: spotify.embed,
      kind: spotify.kind,
      spotifyId: spotify.id,
    }
    elements.push(e)
    render(e)
    select(e.id)
    scheduleSave()
    flashSave('Spotify card added')
    return e
  }

  function addGifFromUrl(rawUrl, wx, wy) {
    const gif = parseGifUrl(rawUrl)
    if (!gif) {
      flashSave('Need a GIF, Giphy, or Tenor link')
      return null
    }
    if (viewMode !== 'page') createLibraryPage()
    const x = wx ?? lastPointerWorld.x
    const y = wy ?? lastPointerWorld.y
    if (gif.embed) {
      const w = 360
      const h = 280
      const e = {
        id: uid(),
        type: 'gif',
        x: Math.max(0, x - w / 2),
        y: Math.max(0, y - 24),
        w,
        h,
        href: gif.href,
        embed: gif.embed,
        kind: gif.kind,
        gifId: gif.id,
      }
      elements.push(e)
      render(e)
      select(e.id)
      scheduleSave()
      flashSave('GIF added')
      return e
    }
    flashSave('Adding GIF…')
    if (!gif.src) {
      flashSave('Couldn’t embed that GIF')
      return null
    }
    return createImageFromSrc(gif.src, x, y, {
      href: gif.href || gif.src,
      label: 'GIF',
      maxW: 480,
    }).then((e) => {
      flashSave('GIF added')
      return e
    })
  }

  async function addProductFromUrl(rawUrl, wx, wy) {
    if (parseSpotifyUrl(rawUrl)) return addSpotifyFromUrl(rawUrl, wx, wy)
    if (parseGifUrl(rawUrl)) return addGifFromUrl(rawUrl, wx, wy)
    const url = normalizeUrl(rawUrl)
    if (!url) {
      flashSave('Need a full product URL (https://…)')
      return null
    }
    if (findingPrice) return null
    findingPrice = true
    flashSave('Fetching product…', 6000)
    const x = wx ?? 48 + viewport.scrollLeft / scale + 220
    const y = wy ?? 90 + viewport.scrollTop / scale + 180
    try {
      let data = { url, price: null, title: null, imageDataUrl: null, image: null }
      try {
        data = await fetchProduct(url)
      } catch (err) {
        console.error(err)
        flashSave('Couldn’t read that page — adding link only', 3200)
      }
      let e = null
      const imageSrc = data.imageDataUrl || data.image || null
      if (imageSrc) {
        e = await createImageFromSrc(imageSrc, x, y, {
          href: url,
          price: data.price ?? null,
          label: data.title || null,
          maxW: 780,
        })
      } else {
        const title = data.title || hostLabel(url)
        e = createText(x - 140, y - 40, `<b>${escapeHtml(title)}</b>`)
        e.href = url
        if (data.price != null) e.price = data.price
        syncLinkedToCart(e)
        render(e)
        select(e.id)
        scheduleSave()
      }
      updateCartBadge()
      const bits = []
      if (imageSrc) bits.push('image')
      if (data.price != null) bits.push(formatMoney(data.price))
      bits.push('cart')
      flashSave(`Added · ${bits.join(' · ')}`)
      setCartOpen(true)
      return e
    } catch (err) {
      console.error(err)
      flashSave(err.message || 'Couldn’t add that link', 3200)
      return null
    } finally {
      findingPrice = false
    }
  }

  let nextBlockId = 1
  const blockUid = () => 'b' + nextBlockId++

  function newBlock(kind = 'p', html = '') {
    return { id: blockUid(), kind, html: html || '' }
  }

  function htmlToBlocks(html) {
    if (!html || !String(html).trim()) return [newBlock('p', '')]
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    const blocks = []
    const pushNodes = (nodes) => {
      for (const child of nodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent || ''
          if (t.trim()) blocks.push(newBlock('p', escapeHtml(t)))
          continue
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue
        const tag = child.nodeName
        if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
          blocks.push(newBlock('h1', child.innerHTML))
        } else if (tag === 'UL') {
          for (const li of child.querySelectorAll(':scope > li')) {
            blocks.push(newBlock('bullet', li.innerHTML))
          }
        } else if (tag === 'OL') {
          for (const li of child.querySelectorAll(':scope > li')) {
            blocks.push(newBlock('number', li.innerHTML))
          }
        } else if (tag === 'HR') {
          blocks.push(newBlock('divider'))
        } else if (tag === 'IMG') {
          const src = child.getAttribute('src')
          if (src) {
            const ib = newBlock('image')
            ib.src = src
            blocks.push(ib)
          }
        } else if (tag === 'BR') {
          blocks.push(newBlock('p', ''))
        } else if (tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE') {
          if (child.querySelector('ul,ol,h1,h2,h3,hr')) pushNodes(child.childNodes)
          else blocks.push(newBlock('p', child.innerHTML))
        } else {
          blocks.push(newBlock('p', child.outerHTML))
        }
      }
    }
    pushNodes(wrap.childNodes)
    return blocks.length ? blocks : [newBlock('p', '')]
  }

  function ensureContainerBlocks(e) {
    if (!e || e.type !== 'container') return
    if (Array.isArray(e.blocks) && e.blocks.length) {
      for (const b of e.blocks) {
        if (!b.id) b.id = blockUid()
        if (!b.kind) b.kind = b.src ? 'image' : 'p'
        if (b.html == null) b.html = ''
        const n = Number(String(b.id).replace(/\D/g, ''))
        if (n >= nextBlockId) nextBlockId = n + 1
      }
      return
    }
    e.blocks = htmlToBlocks(e.html || '')
    delete e.html
  }

  function syncContainerBlocks(e) {
    if (!e || e.type !== 'container') return
    ensureContainerBlocks(e)
    const root = byId(e.id)?.querySelector('.blocks')
    if (!root) return
    for (const row of root.querySelectorAll('.block')) {
      const id = row.dataset.blockId
      const b = e.blocks.find((x) => x.id === id)
      if (!b) continue
      if (b.kind === 'divider' || b.kind === 'image') continue
      const body = row.querySelector('.block-body')
      if (body) b.html = body.innerHTML
    }
    e.html = blocksToHtml(e.blocks)
  }

  function blocksToHtml(blocks) {
    return (blocks || [])
      .map((b) => {
        if (b.kind === 'h1') return `<h2>${b.html || ''}</h2>`
        if (b.kind === 'bullet') return `<ul><li>${b.html || ''}</li></ul>`
        if (b.kind === 'number') return `<ol><li>${b.html || ''}</li></ol>`
        if (b.kind === 'divider') return '<hr>'
        if (b.kind === 'image' && b.src) {
          return `<img src="${String(b.src).replace(/"/g, '&quot;')}" alt="">`
        }
        return `<p>${b.html || ''}</p>`
      })
      .join('')
  }

  function placeholderForKind(kind) {
    if (kind === 'h1') return 'Heading'
    if (kind === 'bullet') return 'List'
    if (kind === 'number') return 'List'
    return "Type '/' for commands"
  }

  function caretAtStart(el) {
    const sel = window.getSelection()
    if (!sel?.isCollapsed || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) return false
    const range = sel.getRangeAt(0)
    const pre = range.cloneRange()
    pre.selectNodeContents(el)
    pre.setEnd(range.startContainer, range.startOffset)
    return pre.toString().length === 0
  }

  function caretAtEnd(el) {
    const sel = window.getSelection()
    if (!sel?.isCollapsed || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) return false
    const range = sel.getRangeAt(0)
    const pre = range.cloneRange()
    pre.selectNodeContents(el)
    pre.setEnd(range.startContainer, range.startOffset)
    return pre.toString().length === (el.textContent || '').length
  }

  function splitHtmlAtCaret(body) {
    const sel = window.getSelection()
    if (!sel?.rangeCount || !body) return { before: body.innerHTML, after: '' }
    const range = sel.getRangeAt(0)
    if (!body.contains(range.startContainer)) return { before: body.innerHTML, after: '' }
    const beforeRange = document.createRange()
    beforeRange.selectNodeContents(body)
    beforeRange.setEnd(range.startContainer, range.startOffset)
    const afterRange = document.createRange()
    afterRange.selectNodeContents(body)
    afterRange.setStart(range.endContainer, range.endOffset)
    const b = document.createElement('div')
    const a = document.createElement('div')
    b.appendChild(beforeRange.cloneContents())
    a.appendChild(afterRange.cloneContents())
    return { before: b.innerHTML, after: a.innerHTML }
  }

  function placeCaretAtOffset(el, offset) {
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    let left = Math.max(0, offset)
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walk.nextNode()
    if (!node) {
      range.selectNodeContents(el)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    while (node) {
      const len = node.textContent.length
      if (left <= len) {
        range.setStart(node, left)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      left -= len
      node = walk.nextNode()
    }
    placeCaretAtEnd(el)
  }

  function slashQuery(body) {
    const plain = (body?.textContent || '').replace(/\u00a0/g, ' ')
    const m = plain.match(/^\/([^\n]*)$/)
    return m ? m[1] : null
  }

  function fileToBoardSrc(fileOrBlob) {
    const preview = URL.createObjectURL(fileOrBlob)
    persistPastedBlob(preview, fileOrBlob)
    return preview
  }

  function swapImageSrc(from, to) {
    if (!from || !to || from === to) return
    let hit = false
    for (const e of elements) {
      if (e.type === 'image' && e.src === from) {
        e.src = to
        render(e)
        hit = true
      }
      if (e.type === 'container' && Array.isArray(e.blocks)) {
        let blockHit = false
        for (const b of e.blocks) {
          if (b.kind === 'image' && b.src === from) {
            b.src = to
            blockHit = true
          }
        }
        if (blockHit) {
          render(e)
          hit = true
        }
      }
    }
    if (hit) scheduleSave()
    if (from.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(from)
      } catch {
        /* ignore */
      }
    }
  }

  function persistPastedBlob(preview, fileOrBlob) {
    uploadBoardImage(fileOrBlob)
      .then((src) => swapImageSrc(preview, src))
      .catch((err) => console.error(err))
  }

  function focusBlock(containerId, blockId) {
    requestAnimationFrame(() => {
      const body = byId(containerId)?.querySelector(
        `.block[data-block-id="${blockId}"] .block-body`
      )
      body?.focus()
      placeCaretAtEnd(body)
    })
  }

  /** Paste into the invisible writing column: image takes a line, typing continues under it. */
  async function insertSrcIntoFlow(afterLine, src) {
    if (!afterLine || !src) return null
    const x = afterLine.x
    let y = afterLine.y + flowLineHeight(afterLine) + 12
    if (afterLine.kind === 'p' && !stripHtml(afterLine.html || '').trim()) {
      y = afterLine.y
      byId(afterLine.id)?.remove()
      elements = elements.filter((el) => el.id !== afterLine.id)
      selectedIds = selectedIds.filter((id) => id !== afterLine.id)
    }
    const dims = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth || 420, h: img.naturalHeight || 420 })
      img.onerror = () => reject(new Error('Couldn’t read image'))
      img.src = src
    })
    const w = Math.min(FLOW_W, dims.w)
    const h = (w * dims.h) / dims.w
    y = flowYPastImages(x, y, FLOW_W, h)
    const e = {
      id: uid(),
      type: 'image',
      x,
      y,
      w,
      h,
      src,
      z: maxZ() + 1,
      inFlow: true,
    }
    elements.push(e)
    render(e)
    const next = createFlowLine(x, e.y + e.h + FLOW_GAP, { kind: 'p', focus: true })
    scheduleSave()
    return next
  }

  async function insertImagesIntoFlow(afterLine, files) {
    if (!afterLine || !files?.length) return
    let line = afterLine
    for (const file of files) {
      if (!file) continue
      try {
        const src = fileToBoardSrc(file)
        line = (await insertSrcIntoFlow(line, src)) || line
      } catch (err) {
        console.error(err)
      }
    }
    flashSave(files.length === 1 ? 'Image added' : 'Images added')
  }

  /** Put pictures on their own line in a Doc; text continues in the block below. */
  async function insertImagesIntoDoc(containerId, afterBlockId, files) {
    const e = model(containerId)
    if (!e || !files?.length) return
    ensureContainerBlocks(e)
    let after = afterBlockId
    let focusId = null
    for (const file of files) {
      if (!file) continue
      try {
        const src = fileToBoardSrc(file)
        const imgBlock = newBlock('image')
        imgBlock.src = src
        const textBlock = newBlock('p', '')
        let idx = e.blocks.findIndex((b) => b.id === after)
        if (idx < 0) idx = e.blocks.length - 1
        const cur = e.blocks[idx]
        if (cur && cur.kind === 'p' && !stripHtml(cur.html)) {
          // Empty line → image here, keep typing on the next line
          e.blocks.splice(idx, 1, imgBlock, textBlock)
        } else {
          e.blocks.splice(idx + 1, 0, imgBlock, textBlock)
        }
        after = textBlock.id
        focusId = textBlock.id
      } catch (err) {
        console.error(err)
      }
    }
    render(e)
    select(containerId)
    scheduleSave()
    if (focusId) focusBlock(containerId, focusId)
    flashSave(files.length === 1 ? 'Image added' : 'Images added')
  }

  function activeDocEdit() {
    const body = document.activeElement?.classList?.contains('block-body')
      ? document.activeElement
      : null
    const row = body?.closest?.('.block')
    const el = body?.closest?.('.el.container')
    if (!el?.dataset?.id) return null
    return {
      containerId: el.dataset.id,
      blockId: row?.dataset?.blockId || null,
    }
  }

  const BLOCK_TYPES = [
    { kind: 'p', label: 'Text', hint: 'Just start writing with plain text.', icon: 'Aa', aliases: ['text', 'paragraph', 'plain'] },
    { kind: 'h1', label: 'Heading 1', hint: 'Big section heading.', icon: 'H₁', aliases: ['heading', 'title', 'h1', 'h2'] },
    { kind: 'bullet', label: 'Bulleted list', hint: 'Create a simple bulleted list.', icon: '•', aliases: ['bullet', 'ul', 'list', 'unordered'] },
    { kind: 'number', label: 'Numbered list', hint: 'Create a list with numbering.', icon: '1.', aliases: ['number', 'numbered', 'ol', 'ordered'] },
    { kind: 'divider', label: 'Divider', hint: 'Visually divide blocks.', icon: '—', aliases: ['divider', 'line', 'hr', 'sep'] },
  ]

  function closeBlockMenu() {
    document.getElementById('blockMenu')?.remove()
  }

  function openBlockMenu(containerId, blockId, anchorEl, { query = '', insertAfter = false, flow = false } = {}) {
    closeBlockMenu()
    const q = String(query || '').trim().toLowerCase()
    const items = BLOCK_TYPES.filter((it) => {
      if (!q) return true
      const hay = [it.label, it.hint, it.kind, ...(it.aliases || [])].join(' ').toLowerCase()
      return hay.includes(q) || it.label.toLowerCase().startsWith(q)
    })
    if (!items.length) return

    const menu = document.createElement('div')
    menu.id = 'blockMenu'
    menu.className = 'block-menu'
    menu.dataset.containerId = containerId
    menu.dataset.blockId = blockId
    if (insertAfter) menu.dataset.insertAfter = '1'

    const head = document.createElement('div')
    head.className = 'block-menu-head'
    head.textContent = q ? 'Filter' : 'Basic blocks'
    menu.appendChild(head)

    let active = 0
    const buttons = []
    const paint = () => {
      buttons.forEach((btn, i) => btn.classList.toggle('active', i === active))
    }
    const choose = (it) => {
      closeBlockMenu()
      if (flow) {
        setFlowKind(containerId, it.kind)
        return
      }
      if (insertAfter) {
        const nb = insertBlockAfter(containerId, blockId, it.kind === 'divider' ? 'divider' : it.kind)
        if (nb && it.kind === 'divider') {
          insertBlockAfter(containerId, nb.id, 'p')
        }
        return
      }
      setBlockKind(containerId, blockId, it.kind)
    }

    for (const it of items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'block-menu-item'
      btn.innerHTML = `<span class="block-menu-icon" aria-hidden="true">${it.icon}</span><span class="block-menu-copy"><strong>${it.label}</strong><span>${it.hint}</span></span>`
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        choose(it)
      })
      btn.addEventListener('mouseenter', () => {
        active = buttons.indexOf(btn)
        paint()
      })
      menu.appendChild(btn)
      buttons.push(btn)
    }
    paint()

    menu.tabIndex = -1
    menu.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        active = (active + 1) % buttons.length
        paint()
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        active = (active - 1 + buttons.length) % buttons.length
        paint()
      } else if (ev.key === 'Enter') {
        ev.preventDefault()
        buttons[active]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        closeBlockMenu()
      }
    })

    document.body.appendChild(menu)

    // Prefer caret position; fall back to block row
    let left = 80
    let top = 120
    try {
      const sel = window.getSelection()
      if (sel?.rangeCount) {
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        if (rect && (rect.width || rect.height || rect.top)) {
          left = rect.left
          top = rect.bottom + 8
        } else if (anchorEl) {
          const r = anchorEl.getBoundingClientRect()
          left = r.left
          top = r.bottom + 6
        }
      } else if (anchorEl) {
        const r = anchorEl.getBoundingClientRect()
        left = r.left
        top = r.bottom + 6
      }
    } catch {
      /* ignore */
    }
    const mw = 288
    const mh = menu.offsetHeight || 280
    menu.style.left = Math.max(8, Math.min(left, window.innerWidth - mw - 8)) + 'px'
    menu.style.top = Math.max(8, Math.min(top, window.innerHeight - mh - 8)) + 'px'
  }

  function setBlockKind(containerId, blockId, kind) {
    const e = model(containerId)
    if (!e) return
    ensureContainerBlocks(e)
    const b = e.blocks.find((x) => x.id === blockId)
    if (!b) return
    if (kind === 'divider') {
      b.kind = 'divider'
      b.html = ''
      const idx = e.blocks.findIndex((x) => x.id === blockId)
      const next = newBlock('p', '')
      e.blocks.splice(idx + 1, 0, next)
      render(e)
      fitContainerHeight(e)
      scheduleSave()
      focusBlock(containerId, next.id)
      return
    }
    if (b.kind === 'divider' || b.kind === 'image') b.html = ''
    b.kind = kind
    // Clear slash command residue
    const plain = String(b.html || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\u00a0/g, ' ')
    if (/^\/[^\n]*$/.test(plain.trim())) b.html = ''
    render(e)
    fitContainerHeight(e)
    scheduleSave()
    focusBlock(containerId, blockId)
  }

  function placeCaretAtEnd(el) {
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function insertBlockAfter(containerId, blockId, kind = 'p', html = '') {
    const e = model(containerId)
    if (!e) return null
    ensureContainerBlocks(e)
    const idx = e.blocks.findIndex((b) => b.id === blockId)
    const nb = newBlock(kind, html)
    e.blocks.splice(idx < 0 ? e.blocks.length : idx + 1, 0, nb)
    render(e)
    fitContainerHeight(e)
    scheduleSave()
    if (kind !== 'divider' && kind !== 'image') focusBlock(containerId, nb.id)
    return nb
  }

  function insertBlockBefore(containerId, blockId, kind = 'p', html = '') {
    const e = model(containerId)
    if (!e) return null
    ensureContainerBlocks(e)
    const idx = e.blocks.findIndex((b) => b.id === blockId)
    const nb = newBlock(kind, html)
    e.blocks.splice(idx < 0 ? 0 : idx, 0, nb)
    render(e)
    fitContainerHeight(e)
    scheduleSave()
    if (kind !== 'divider' && kind !== 'image') focusBlock(containerId, nb.id)
    return nb
  }

  function removeBlock(containerId, blockId, { focusPrev = true } = {}) {
    const e = model(containerId)
    if (!e) return
    ensureContainerBlocks(e)
    if (e.blocks.length <= 1) {
      const only = e.blocks[0]
      if (only) {
        only.kind = 'p'
        only.html = ''
        delete only.src
        render(e)
        fitContainerHeight(e)
        scheduleSave()
        focusBlock(containerId, only.id)
      }
      return
    }
    const idx = e.blocks.findIndex((b) => b.id === blockId)
    if (idx < 0) return
    e.blocks.splice(idx, 1)
    render(e)
    fitContainerHeight(e)
    scheduleSave()
    if (focusPrev) {
      const prev = e.blocks[Math.max(0, idx - 1)]
      focusBlock(containerId, prev.id)
    }
  }

  function mergeIntoPrevious(containerId, blockId, trailingHtml) {
    const e = model(containerId)
    if (!e) return false
    ensureContainerBlocks(e)
    const idx = e.blocks.findIndex((b) => b.id === blockId)
    if (idx <= 0) return false
    const prev = e.blocks[idx - 1]
    const cur = e.blocks[idx]
    if (!prev || !cur) return false
    if (prev.kind === 'image' || prev.kind === 'divider') {
      e.blocks.splice(idx - 1, 1)
      render(e)
      fitContainerHeight(e)
      scheduleSave()
      focusBlock(containerId, blockId)
      return true
    }
    const joinAt = stripHtml(prev.html || '').length
    prev.html = (prev.html || '') + (trailingHtml || cur.html || '')
    e.blocks.splice(idx, 1)
    render(e)
    fitContainerHeight(e)
    scheduleSave()
    requestAnimationFrame(() => {
      const body = byId(containerId)?.querySelector(`.block[data-block-id="${prev.id}"] .block-body`)
      placeCaretAtOffset(body, joinAt)
    })
    return true
  }

  function reorderBlock(containerId, blockId, toIndex) {
    const e = model(containerId)
    if (!e) return
    ensureContainerBlocks(e)
    const from = e.blocks.findIndex((b) => b.id === blockId)
    if (from < 0) return
    let target = clamp(toIndex, 0, e.blocks.length - 1)
    if (from === target) return
    const [item] = e.blocks.splice(from, 1)
    if (from < target) target -= 1
    e.blocks.splice(target, 0, item)
    render(e)
    fitContainerHeight(e)
    scheduleSave()
  }

  function focusNeighborBlock(containerId, blockId, dir) {
    const e = model(containerId)
    if (!e) return
    ensureContainerBlocks(e)
    let idx = e.blocks.findIndex((b) => b.id === blockId)
    if (idx < 0) return
    idx += dir
    while (idx >= 0 && idx < e.blocks.length) {
      const b = e.blocks[idx]
      if (b.kind !== 'divider' && b.kind !== 'image') {
        focusBlock(containerId, b.id)
        return
      }
      idx += dir
    }
  }

  function tryMarkdownShortcut(containerId, block, body) {
    const plain = (body.textContent || '').replace(/\u00a0/g, ' ')
    const map = [
      { re: /^#$/, kind: 'h1' },
      { re: /^-$/, kind: 'bullet' },
      { re: /^\*$/, kind: 'bullet' },
      { re: /^1\.$/, kind: 'number' },
      { re: /^---$/, kind: 'divider' },
      { re: /^\*\*\*$/, kind: 'divider' },
    ]
    for (const { re, kind } of map) {
      if (re.test(plain.trim())) {
        body.innerHTML = ''
        block.html = ''
        setBlockKind(containerId, block.id, kind)
        return true
      }
    }
    return false
  }

  function bindBlockRow(containerId, row, block) {
    const handle = row.querySelector('.block-handle')
    const addBtn = row.querySelector('.block-add')
    const body = row.querySelector('.block-body')
    handle?.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      select(containerId)
      closeBlockMenu()
      gesture = {
        kind: 'block-reorder',
        containerId,
        blockId: block.id,
        sy: ev.clientY,
        lastY: ev.clientY,
      }
      row.classList.add('dragging')
      viewport.setPointerCapture(ev.pointerId)
    })
    addBtn?.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      select(containerId)
      openBlockMenu(containerId, block.id, addBtn, { insertAfter: true })
    })
    if (!body) {
      // Divider / image: click focuses nearby text
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.block-handle, .block-add')) return
        insertBlockAfter(containerId, block.id, 'p')
      })
      return
    }
    body.addEventListener('input', () => {
      const e = model(containerId)
      if (!e) return
      ensureContainerBlocks(e)
      const b = e.blocks.find((x) => x.id === block.id)
      if (!b) return
      b.html = body.innerHTML
      const q = slashQuery(body)
      if (q !== null) {
        openBlockMenu(containerId, block.id, row, { query: q })
      } else {
        closeBlockMenu()
      }
      scheduleSave({ soft: true })
      fitContainerHeight(model(containerId))
    })
    body.addEventListener('keydown', (ev) => {
      const e = model(containerId)
      if (!e) return
      ensureContainerBlocks(e)
      const b = e.blocks.find((x) => x.id === block.id)
      if (!b) return
      const menuOpen = Boolean(document.getElementById('blockMenu'))

      if (menuOpen && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter')) {
        const menu = document.getElementById('blockMenu')
        if (ev.key === 'Enter' && slashQuery(body) !== null) {
          ev.preventDefault()
          menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return
        }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault()
          menu?.dispatchEvent(new KeyboardEvent('keydown', { key: ev.key, bubbles: true }))
          return
        }
      }

      if (ev.key === ' ' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        if (tryMarkdownShortcut(containerId, b, body)) {
          ev.preventDefault()
          return
        }
      }

      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        closeBlockMenu()
        // Empty list → exit to paragraph (Notion)
        if ((b.kind === 'bullet' || b.kind === 'number') && !body.textContent.trim()) {
          b.kind = 'p'
          b.html = ''
          render(e)
          fitContainerHeight(e)
          scheduleSave()
          focusBlock(containerId, b.id)
          return
        }
        const { before, after } = splitHtmlAtCaret(body)
        const beforeEmpty = !stripHtml(before).trim()
        const afterHas = Boolean(stripHtml(after).trim())
        // Enter at start → empty block above (Notion)
        if (beforeEmpty && afterHas) {
          b.html = body.innerHTML
          insertBlockBefore(containerId, block.id, 'p', '')
          return
        }
        b.html = before
        const nextKind = b.kind === 'bullet' || b.kind === 'number' ? b.kind : 'p'
        insertBlockAfter(containerId, block.id, nextKind, after)
        return
      }

      if (ev.key === 'Backspace') {
        const plain = body.textContent || ''
        if (caretAtStart(body)) {
          if (!plain.trim()) {
            ev.preventDefault()
            mergeIntoPrevious(containerId, block.id, '')
            return
          }
          if (b.kind === 'h1' || b.kind === 'bullet' || b.kind === 'number') {
            ev.preventDefault()
            b.kind = 'p'
            render(e)
            fitContainerHeight(e)
            scheduleSave()
            focusBlock(containerId, b.id)
            return
          }
          ev.preventDefault()
          mergeIntoPrevious(containerId, block.id, body.innerHTML)
          return
        }
      }

      if (ev.key === 'ArrowUp' && caretAtStart(body) && !menuOpen) {
        ev.preventDefault()
        focusNeighborBlock(containerId, block.id, -1)
        return
      }
      if (ev.key === 'ArrowDown' && caretAtEnd(body) && !menuOpen) {
        ev.preventDefault()
        focusNeighborBlock(containerId, block.id, 1)
        return
      }

      if (ev.key === 'Escape') closeBlockMenu()
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === '/') {
        ev.preventDefault()
        openBlockMenu(containerId, block.id, row)
      }
    })
    body.addEventListener('blur', () => {
      const e = model(containerId)
      if (!e) return
      syncContainerBlocks(e)
      setTimeout(() => {
        if (!document.getElementById('blockMenu')?.contains(document.activeElement)) {
          /* keep menu until click outside */
        }
      }, 0)
    })
  }

  function renderContainerBlocks(e, node) {
    ensureContainerBlocks(e)
    let root = node.querySelector('.blocks')
    if (!root) {
      root = document.createElement('div')
      root.className = 'blocks'
      const bar = node.querySelector('.drag-bar')
      const rh = node.querySelector('.resize-handle')
      if (bar && rh) bar.after(root)
      else node.appendChild(root)
    }
    // Rebuild if structure drifted (kind/count/ids)
    const existing = [...root.querySelectorAll(':scope > .block')]
    const same =
      existing.length === e.blocks.length &&
      existing.every((row, i) => row.dataset.blockId === e.blocks[i].id && row.dataset.kind === e.blocks[i].kind)
    if (!same) {
      const activeId = document.activeElement?.closest?.('.block')?.dataset?.blockId
      const sel = window.getSelection()
      let caret = null
      if (activeId && document.activeElement?.classList?.contains('block-body')) {
        caret = { id: activeId, offset: sel?.anchorOffset ?? 0 }
      }
      root.innerHTML = ''
      for (const b of e.blocks) {
        const row = document.createElement('div')
        row.className = 'block'
        row.dataset.blockId = b.id
        row.dataset.kind = b.kind
        // Notion order: + then ⠿ on the left of the block
        const controls = document.createElement('div')
        controls.className = 'block-controls'
        const addBtn = document.createElement('button')
        addBtn.type = 'button'
        addBtn.className = 'block-add'
        addBtn.title = 'Click to add below'
        addBtn.innerHTML =
          '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
        addBtn.tabIndex = -1
        const handle = document.createElement('button')
        handle.type = 'button'
        handle.className = 'block-handle'
        handle.title = 'Drag to rearrange'
        handle.innerHTML =
          '<svg viewBox="0 0 10 16" width="10" height="14" aria-hidden="true"><circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="7" cy="8" r="1.2" fill="currentColor"/><circle cx="3" cy="13" r="1.2" fill="currentColor"/><circle cx="7" cy="13" r="1.2" fill="currentColor"/></svg>'
        handle.tabIndex = -1
        controls.append(addBtn, handle)
        row.appendChild(controls)
        if (b.kind === 'divider') {
          const line = document.createElement('div')
          line.className = 'block-divider'
          row.appendChild(line)
        } else if (b.kind === 'image') {
          const wrap = document.createElement('div')
          wrap.className = 'block-image'
          const img = document.createElement('img')
          img.draggable = false
          if (b.src) img.src = b.src
          wrap.appendChild(img)
          row.appendChild(wrap)
        } else {
          const body = document.createElement('div')
          body.className = 'block-body'
          body.contentEditable = 'true'
          body.spellcheck = true
          body.dataset.placeholder = placeholderForKind(b.kind)
          body.innerHTML = b.html || ''
          row.appendChild(body)
        }
        root.appendChild(row)
        bindBlockRow(e.id, row, b)
      }
      // Click empty page area → keep typing at the end
      root.onclick = (ev) => {
        if (ev.target !== root) return
        ensureContainerBlocks(e)
        const last = e.blocks[e.blocks.length - 1]
        if (last && last.kind === 'p') focusBlock(e.id, last.id)
        else {
          const nb = newBlock('p', '')
          e.blocks.push(nb)
          render(e)
          scheduleSave()
          focusBlock(e.id, nb.id)
        }
      }
      if (caret) {
        const body = root.querySelector(`.block[data-block-id="${caret.id}"] .block-body`)
        if (body && document.activeElement?.closest?.('.el')?.dataset?.id === e.id) {
          body.focus()
        }
      }
    } else {
      for (let i = 0; i < e.blocks.length; i++) {
        const b = e.blocks[i]
        const row = existing[i]
        if (b.kind === 'divider') continue
        if (b.kind === 'image') {
          const img = row.querySelector('img')
          if (img && b.src && img.getAttribute('src') !== b.src) img.src = b.src
          continue
        }
        const body = row.querySelector('.block-body')
        if (!body) continue
        if (document.activeElement === body) {
          b.html = body.innerHTML
        } else if (body.innerHTML !== (b.html || '')) {
          body.innerHTML = b.html || ''
        }
        body.dataset.placeholder = placeholderForKind(b.kind)
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }


  function addProductAtView() {
    const next = prompt('Product link', 'https://')
    if (next == null || !String(next).trim()) return
    addProductFromUrl(next)
  }

  async function editElementLink(id) {
    const e = model(id)
    if (!e || e.type === 'container') return
    const next = prompt('Link URL', e.href || 'https://')
    if (next == null) return
    e.href = normalizeUrl(next)
    if (!e.href) {
      e.href = null
      e.cartStatus = null
      e.price = null
    } else {
      e.price = null
      syncLinkedToCart(e)
    }
    render(e)
    if (isSelected(id)) buildToolbar()
    renderCart()
    updateCartBadge()
    scheduleSave()
    if (e.href) {
      await enrichElementFromLink(id, { priceOnly: e.type !== 'image' })
      setCartOpen(true)
    }
  }

  async function addToCart(id) {
    const e = locateElement(id)
    if (!e || e.type === 'container') return
    if (!(await ensureShopFields(e))) return
    syncLinkedToCart(e)
    e.cartStatus = 'cart'
    if (!e.qty) e.qty = 1
    render(e)
    if (isSelected(id)) buildToolbar()
    renderCart()
    updateCartBadge()
    scheduleSave()
    flashSave(e.price != null ? `Added · ${formatMoney(e.price)}` : 'Added to cart')
    setCartOpen(true)
  }

  async function moveToLater(id) {
    const e = locateElement(id)
    if (!e) return
    if (!(await ensureShopFields(e, { needPrice: false }))) return
    if (!e.href) {
      flashSave('Add a link first')
      return
    }
    e.cartStatus = 'later'
    render(e)
    if (isSelected(id)) buildToolbar()
    renderCart()
    updateCartBadge()
    scheduleSave()
    flashSave('Saved for later')
  }

  function removeFromCart(id) {
    const e = locateElement(id)
    if (!e) return
    // Links belong in the cart — clearing cart also clears the product link
    e.cartStatus = null
    e.href = null
    render(e)
    if (isSelected(id)) buildToolbar()
    renderCart()
    updateCartBadge()
    scheduleSave()
  }

  function formatInlineLink() {
    const url = prompt('Link URL', 'https://')
    if (url == null) return
    const href = normalizeUrl(url)
    if (!href) return
    document.execCommand('createLink', false, href)
    scheduleSave({ soft: true })
  }

  function updateElementMeta(node, e) {
    let meta = node.querySelector('.el-meta')
    const hasLink = Boolean(e.href)
    const hasPrice = e.price != null && e.price !== ''
    const inCart = e.cartStatus === 'cart' || e.cartStatus === 'later'
    if (!hasLink && !hasPrice && !inCart) {
      meta?.remove()
      node.classList.remove('has-meta')
      return
    }
    if (!meta) {
      meta = document.createElement('div')
      meta.className = 'el-meta'
      node.appendChild(meta)
    }
    meta.innerHTML = ''
    if (hasLink) {
      const a = document.createElement('a')
      a.href = e.href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = hostLabel(e.href)
      a.title = e.href
      a.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation()
      })
      a.addEventListener('click', (ev) => openExternalLink(e.href, ev))
      meta.appendChild(a)
    }
    if (hasPrice) {
      const p = document.createElement('span')
      p.className = 'el-price'
      p.textContent = formatMoney(e.price)
      meta.appendChild(p)
    }
    if (inCart) {
      const tag = document.createElement('span')
      tag.className = 'el-cart-tag'
      tag.textContent = e.cartStatus === 'later' ? 'Later' : 'In cart'
      meta.appendChild(tag)
    }
    node.classList.toggle('has-meta', e.type === 'text')
  }

  function renderCartRow(e, section) {
    const row = document.createElement('div')
    row.className = 'cart-row'

    if (e.type === 'image' && e.src) {
      const img = document.createElement('img')
      img.className = 'cart-thumb'
      img.src = e.src
      img.alt = ''
      row.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className = 'cart-thumb placeholder'
      ph.textContent = e.type === 'text' ? 'Note' : 'Item'
      row.appendChild(ph)
    }

    const main = document.createElement('div')
    main.className = 'cart-row-main'

    const title = document.createElement('div')
    title.className = 'cart-row-title'
    title.textContent = itemLabel(e)
    main.appendChild(title)

    if (e.href) {
      const a = document.createElement('a')
      a.className = 'cart-row-link'
      a.href = e.href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = hostLabel(e.href)
      a.title = e.href
      a.addEventListener('click', (ev) => openExternalLink(e.href, ev))
      main.appendChild(a)
    } else {
      const missing = document.createElement('button')
      missing.type = 'button'
      missing.textContent = 'Add link'
      missing.addEventListener('click', () => editElementLink(e.id))
      main.appendChild(missing)
    }

    const meta = document.createElement('div')
    meta.className = 'cart-row-meta'
    const priceInput = document.createElement('input')
    priceInput.className = 'cart-price-input'
    priceInput.type = 'text'
    priceInput.inputMode = 'decimal'
    priceInput.placeholder = '$0.00'
    priceInput.value = e.price != null ? String(e.price) : ''
    priceInput.addEventListener('change', () => {
      const parsed = parsePrice(priceInput.value)
      if (parsed == null && priceInput.value.trim() !== '') {
        flashSave('Enter a valid price')
        priceInput.value = e.price != null ? String(e.price) : ''
        return
      }
      e.price = parsed
      render(e)
      renderCart()
      scheduleSave()
    })
    meta.appendChild(priceInput)
    if (e.href) {
      const findBtn = document.createElement('button')
      findBtn.type = 'button'
      findBtn.textContent = findingPrice ? 'Finding…' : 'Find price'
      findBtn.disabled = findingPrice
      findBtn.addEventListener('click', () => findPriceForElement(e.id))
      meta.appendChild(findBtn)
    }
    main.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'cart-row-actions'
    if (section === 'cart') {
      const later = document.createElement('button')
      later.type = 'button'
      later.textContent = 'Save for later'
      later.addEventListener('click', () => moveToLater(e.id))
      actions.appendChild(later)
    } else {
      const toCart = document.createElement('button')
      toCart.type = 'button'
      toCart.textContent = 'Move to cart'
      toCart.addEventListener('click', () => addToCart(e.id))
      actions.appendChild(toCart)
    }
    const find = document.createElement('button')
    find.type = 'button'
    find.textContent = 'Find on board'
    find.addEventListener('click', () => {
      const owner = pages.find((p) => (p.elements || []).some((x) => x.id === e.id))
      if (owner && (viewMode !== 'page' || currentPageId !== owner.id)) {
        openLibraryPage(owner.id)
      }
      select(e.id)
      const node = byId(e.id)
      if (node) {
        const top = Math.max(0, e.y * scale - 80)
        viewport.scrollTo({ top, behavior: 'smooth' })
      }
    })
    actions.appendChild(find)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger'
    remove.textContent = 'Remove link'
    remove.title = 'Remove from cart and clear the product link'
    remove.addEventListener('click', () => removeFromCart(e.id))
    actions.appendChild(remove)
    main.appendChild(actions)

    row.appendChild(main)
    return row
  }

  function renderCart() {
    if (!cartOpen) {
      updateCartBadge()
      return
    }
    cartBody.innerHTML = ''

    const cartSection = document.createElement('section')
    const cartTitle = document.createElement('div')
    cartTitle.className = 'cart-section-title'
    cartTitle.textContent = 'In cart'
    cartSection.appendChild(cartTitle)

    const inCart = cartItems('cart')
    if (!inCart.length) {
      const empty = document.createElement('div')
      empty.className = 'cart-empty'
      empty.textContent = 'Nothing here yet. Select a note or image and tap Add to cart.'
      cartSection.appendChild(empty)
    } else {
      for (const e of inCart) cartSection.appendChild(renderCartRow(e, 'cart'))
      const total = document.createElement('div')
      total.className = 'cart-total'
      total.innerHTML = `<span>Total</span><span>${formatMoney(cartTotal())}</span>`
      cartSection.appendChild(total)
    }
    cartBody.appendChild(cartSection)

    const laterSection = document.createElement('section')
    const laterTitle = document.createElement('div')
    laterTitle.className = 'cart-section-title'
    laterTitle.textContent = 'Saved for later'
    laterSection.appendChild(laterTitle)
    const later = cartItems('later')
    if (!later.length) {
      const empty = document.createElement('div')
      empty.className = 'cart-empty'
      empty.textContent = 'Move cart items here to keep shopping without losing them.'
      laterSection.appendChild(empty)
    } else {
      for (const e of later) laterSection.appendChild(renderCartRow(e, 'later'))
    }
    cartBody.appendChild(laterSection)
    updateCartBadge()
  }

  function elSize(e) {
    if (e.type === 'image' || e.type === 'container' || e.type === 'spotify' || e.type === 'gif') return { w: e.w, h: e.h }
    const node = byId(e.id)
    if (e.type === 'flow') {
      return { w: e.width || FLOW_W, h: node?.offsetHeight || (e.kind === 'h1' ? 52 : 34) }
    }
    const fallbackW = e.type === 'title' ? 320 : 340
    return { w: e.width || fallbackW, h: node?.offsetHeight || (e.type === 'title' ? 48 : 88) }
  }

  function clearGuides() {
    if (guides) guides.innerHTML = ''
  }

  function showGuides(guideV, guideH) {
    clearGuides()
    if (!guides) return
    if (guideV != null) {
      const line = document.createElement('div')
      line.className = 'guide v'
      line.style.left = guideV + 'px'
      guides.appendChild(line)
    }
    if (guideH != null) {
      const line = document.createElement('div')
      line.className = 'guide h'
      line.style.top = guideH + 'px'
      guides.appendChild(line)
    }
  }

  function magnetizePosition(id, x, y, enabled) {
    if (!enabled) {
      clearGuides()
      return { x, y }
    }
    const e = model(id)
    const { w, h } = elSize(e)
    let bestDx = SNAP + 1
    let bestDy = SNAP + 1
    let nextX = x
    let nextY = y
    let guideV = null
    let guideH = null

    const xOptions = [{ pos: Math.round(x / GRID) * GRID, guide: null }]
    const yOptions = [{ pos: Math.round(y / GRID) * GRID, guide: null }]

    for (const o of elements) {
      if (o.id === id) continue
      const os = elSize(o)
      const left = o.x
      const right = o.x + os.w
      const cx = o.x + os.w / 2
      const top = o.y
      const bottom = o.y + os.h
      const cy = o.y + os.h / 2
      xOptions.push(
        { pos: left, guide: left },
        { pos: right, guide: right },
        { pos: cx - w / 2, guide: cx },
        { pos: left - w, guide: left },
        { pos: right - w, guide: right }
      )
      yOptions.push(
        { pos: top, guide: top },
        { pos: bottom, guide: bottom },
        { pos: cy - h / 2, guide: cy },
        { pos: top - h, guide: top },
        { pos: bottom - h, guide: bottom }
      )
    }
    xOptions.push({ pos: 24, guide: 24 })

    for (const opt of xOptions) {
      const d = Math.abs(x - opt.pos)
      if (d <= SNAP && d < bestDx) {
        bestDx = d
        nextX = opt.pos
        guideV = opt.guide
      }
    }
    for (const opt of yOptions) {
      const d = Math.abs(y - opt.pos)
      if (d <= SNAP && d < bestDy) {
        bestDy = d
        nextY = opt.pos
        guideH = opt.guide
      }
    }
    if (bestDx > SNAP) {
      nextX = x
      guideV = null
    }
    if (bestDy > SNAP) {
      nextY = y
      guideH = null
    }
    showGuides(guideV, guideH)
    return { x: nextX, y: Math.max(0, nextY) }
  }

  function organizeBoard() {
    if (!elements.length) return
    const gap = 18
    const pad = 28
    const pageW = viewport.clientWidth / scale
    const colCount = clamp(Math.floor((pageW - pad * 2 + gap) / 260), 2, 4)
    const colW = (pageW - pad * 2 - gap * (colCount - 1)) / colCount
    const heights = Array.from({ length: colCount }, () => pad)

    const items = [...elements].sort((a, b) => a.y - b.y || a.x - b.x)

    for (const e of items) {
      const col = heights.indexOf(Math.min(...heights))
      e.x = pad + col * (colW + gap)
      e.y = heights[col]

      if (e.type === 'image') {
        const ratio = e.h / Math.max(e.w, 1)
        e.w = colW
        e.h = colW * ratio
      } else if (e.type === 'spotify') {
        const ratio = e.h / Math.max(e.w, 1)
        e.w = colW
        e.h = Math.max(152, colW * ratio)
      } else if (e.type === 'gif') {
        const ratio = e.h / Math.max(e.w, 1)
        e.w = colW
        e.h = Math.max(120, colW * ratio)
      } else if (e.type === 'text' || e.type === 'title') {
        e.width = colW
      } else if (e.type === 'container') {
        e.w = colW
      }
      render(e)
      heights[col] += elSize(e).h + gap
    }

    deselect()
    updateWorldSize()
    scheduleSave()
    flashSave('Organized')
  }

  function addNoteAtView() {
    createText(lastPointerWorld.x, Math.max(0, lastPointerWorld.y))
  }

  function addTitleAtView() {
    createTitle(lastPointerWorld.x, Math.max(0, lastPointerWorld.y))
  }

  function cloneData(value) {
    try {
      return structuredClone(value)
    } catch {
      return JSON.parse(JSON.stringify(value))
    }
  }

  function derivePageTitle(page) {
    if (page?.title?.trim()) return page.title.trim()
    const els = page?.id === currentPageId && viewMode === 'page' ? liveElements() : page?.elements || []
    const titleEl = els.find((e) => e.type === 'title' && stripHtml(e.html || '').trim())
    if (titleEl) return stripHtml(titleEl.html).trim()
    const col = els.find((e) => e.type === 'container')
    const h1 = col?.blocks?.find((b) => b.kind === 'h1' && stripHtml(b.html || '').trim())
    if (h1) return stripHtml(h1.html).trim()
    const p = col?.blocks?.find((b) => b.kind !== 'image' && b.kind !== 'divider' && stripHtml(b.html || '').trim())
    if (p) return stripHtml(p.html).trim().slice(0, 60)
    const note = els.find((e) => e.type === 'text' && stripHtml(e.html || '').trim())
    if (note) return stripHtml(note.html).trim().slice(0, 60)
    return 'Untitled'
  }

  function flushCurrentPage() {
    if (viewMode !== 'page' || !currentPageId) return
    const page = pages.find((p) => p.id === currentPageId)
    if (!page) return
    page.elements = liveElements()
    page.scrollTop = viewport.scrollTop
    page.scale = scale
    if (pageTitleInput && !pageTitleInput.hidden && document.activeElement === pageTitleInput) {
      page.title = pageTitleInput.value.trim()
    } else if (!page.title?.trim()) {
      page.title = derivePageTitle(page)
    }
  }

  function setLibraryMode(on) {
    viewMode = on ? 'library' : 'page'
    appShell?.classList.toggle('library-on', on)
    if (libraryEl) libraryEl.hidden = !on
    if (pageTitleInput) pageTitleInput.hidden = on
    emptyState.classList.toggle('hidden', on || elements.length > 0)
  }

  function pagePreviewBounds(els) {
    let minX = Infinity
    let minY = Infinity
    let maxX = 0
    let maxY = 0
    for (const e of els) {
      const x = Number(e.x) || 0
      const y = Number(e.y) || 0
      const w = Number(e.w || e.width) || (e.type === 'title' ? 280 : 220)
      const h = Number(e.h) || (e.type === 'image' ? 180 : e.type === 'container' ? 220 : 48)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + w)
      maxY = Math.max(maxY, y + h)
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 720, h: 420 }
    return {
      minX,
      minY,
      w: Math.max(360, maxX - minX),
      h: Math.max(240, maxY - minY),
    }
  }

  function renderPagePreview(page, host) {
    const els = page?.id === currentPageId && viewMode === 'page' ? liveElements() : page?.elements || []
    host.innerHTML = ''
    if (!els.length) {
      host.classList.add('empty')
      host.textContent = 'Empty page'
      return
    }
    host.classList.remove('empty')
    const b = pagePreviewBounds(els)
    const clipW = 280
    const clipH = 168
    const s = Math.min(clipW / b.w, clipH / b.h)
    const stage = document.createElement('div')
    stage.className = 'library-preview-stage'
    stage.style.width = b.w + 'px'
    stage.style.height = b.h + 'px'
    stage.style.transform = `scale(${s})`
    let previewImgs = 0
    for (const e of els) {
      try {
        const node = document.createElement('div')
        const kind = String(e.type || '').trim()
        node.className = kind ? `library-preview-el ${kind}` : 'library-preview-el'
        node.style.left = (Number(e.x) || 0) - b.minX + 'px'
        node.style.top = (Number(e.y) || 0) - b.minY + 'px'
        if (e.type === 'image' && e.src) {
          node.style.width = (e.w || 160) + 'px'
          node.style.height = (e.h || 160) + 'px'
          if (previewImgs < 4) {
            previewImgs += 1
            const img = document.createElement('img')
            img.src = e.src
            img.alt = ''
            img.draggable = false
            img.loading = 'lazy'
            img.decoding = 'async'
            node.appendChild(img)
          }
        } else if (e.type === 'spotify') {
          node.style.width = (e.w || 200) + 'px'
          node.style.height = Math.min(e.h || 80, 120) + 'px'
          node.classList.add('spotify')
          node.textContent = e.kind === 'track' ? 'Track' : e.kind === 'album' ? 'Album' : 'Playlist'
        } else if (e.type === 'gif') {
          node.style.width = (e.w || 160) + 'px'
          node.style.height = Math.min(e.h || 80, 120) + 'px'
          node.classList.add('gif')
          node.textContent = 'GIF'
        } else if (e.type === 'container') {
          node.style.width = Math.min(Number(e.w) || 480, 640) + 'px'
          for (const bl of (e.blocks || []).slice(0, 8)) {
            const line = document.createElement('div')
            const lineKind = String(bl.kind || 'p').trim() || 'p'
            line.className = 'pv-block ' + lineKind
            if (bl.kind === 'divider') continue
            if (bl.kind === 'image' && bl.src) {
              if (previewImgs < 4) {
                previewImgs += 1
                const im = document.createElement('img')
                im.src = bl.src
                im.loading = 'lazy'
                im.decoding = 'async'
                line.appendChild(im)
              }
            } else {
              line.textContent = stripHtml(bl.html || '')
            }
            if (line.textContent || line.querySelector('img')) node.appendChild(line)
          }
        } else {
          node.style.width = (e.width || 280) + 'px'
          node.textContent = stripHtml(e.html || '')
        }
        if (node.childNodes.length || node.textContent) stage.appendChild(node)
      } catch (err) {
        console.warn('preview skip', err)
      }
    }
    host.appendChild(stage)
  }

  function renderLibrary() {
    if (!libraryGrid) return
    libraryGrid.innerHTML = ''
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'library-card library-new'
    add.innerHTML = '<span>+</span>New page'
    add.addEventListener('click', () => createLibraryPage())
    libraryGrid.appendChild(add)

    for (const page of pages) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'library-card'
      const cover = document.createElement('div')
      cover.className = 'library-cover'
      renderPagePreview(page, cover)
      const body = document.createElement('div')
      body.className = 'library-card-body'
      const title = document.createElement('div')
      title.className = 'library-card-title'
      title.textContent = derivePageTitle(page)
      const meta = document.createElement('div')
      meta.className = 'library-card-meta'
      const n = (page.elements || []).length
      meta.textContent = n ? `${n} item${n === 1 ? '' : 's'}` : 'Empty'
      body.append(title, meta)
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'library-card-del'
      del.title = 'Delete page'
      del.textContent = '×'
      del.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        deleteLibraryPage(page.id)
      })
      card.append(cover, body, del)
      card.addEventListener('click', () => openLibraryPage(page.id))
      libraryGrid.appendChild(card)
    }
  }

  function showLibrary({ skipFlush = false } = {}) {
    if (!skipFlush) flushCurrentPage()
    deselect()
    clearWorld()
    currentPageId = null
    setLibraryMode(true)
    renderLibrary()
    updateCartBadge()
  }

  function mountPageElements(list) {
    clearWorld()
    elements = cloneData(list || [])
    elements.forEach(render)
    layoutAllWritingColumns()
    syncAllLinkedToCart()
    applyView()
    updateEmpty()
  }

  function openLibraryPage(id) {
    flushCurrentPage()
    const page = pages.find((p) => p.id === id)
    if (!page) return
    currentPageId = page.id
    setLibraryMode(false)
    scale = page.scale || 1
    mountPageElements(page.elements)
    viewport.scrollTop = page.scrollTop || 0
    if (pageTitleInput) {
      pageTitleInput.hidden = false
      pageTitleInput.value = derivePageTitle(page)
    }
    undoStack.length = 0
    redoStack.length = 0
    pushHistory()
    updateHistoryButtons()
  }

  function createLibraryPage() {
    flushCurrentPage()
    const page = {
      id: pageUid(),
      title: '',
      elements: [],
      scrollTop: 0,
      scale: 1,
    }
    pages.unshift(page)
    openLibraryPage(page.id)
    focusWritingAt(NOTION_X, 72)
    pageTitleInput?.focus()
    scheduleSave()
    flashSave('New page')
  }

  function deleteLibraryPage(id) {
    pages = pages.filter((p) => p.id !== id)
    if (currentPageId === id) {
      currentPageId = null
      clearWorld()
      setLibraryMode(true)
    }
    renderLibrary()
    scheduleSave()
    flashSave('Page deleted')
  }

  function goHome() {
    showLibrary()
    scheduleSave({ soft: true })
  }

  function onPageTitleInput() {
    const page = pages.find((p) => p.id === currentPageId)
    if (!page) return
    page.title = pageTitleInput.value
    scheduleSave({ soft: true })
  }

  const FLOW_W = 560
  let activePageId = null

  function writingColumns() {
    return elements.filter((e) => e.type === 'container' && (e.column || e.notion))
  }

  function setActivePage(id) {
    activePageId = id || null
    document.querySelectorAll('.el.notion-active').forEach((n) => n.classList.remove('notion-active'))
    if (activePageId) byId(activePageId)?.classList.add('notion-active')
  }

  function getWritingColumn() {
    if (activePageId) {
      const cur = model(activePageId)
      if (cur && cur.type === 'container' && (cur.column || cur.notion)) return cur
    }
    return writingColumns()[0] || null
  }

  function layoutAllWritingColumns() {
    for (const col of writingColumns()) {
      col.w = writingColumnWidth()
      const node = byId(col.id)
      if (node) node.style.width = col.w + 'px'
      layoutColumnAroundImages(col)
    }
  }

  function nextPageY() {
    const viewY = Math.max(48, viewport.scrollTop / Math.max(scale, 0.01) + 72)
    const cols = writingColumns()
    if (!cols.length) return viewY
    // Prefer below the active page so New isn’t stacked on top of existing writing
    const cur = (activePageId && model(activePageId)) || getWritingColumn()
    if (cur) return cur.y + (cur.h || 160) + 96
    let bottom = 0
    for (const c of cols) bottom = Math.max(bottom, c.y + (c.h || 160))
    return Math.max(viewY, bottom + 96)
  }

  function findPageNearY(wy) {
    let best = null
    let bestDist = Infinity
    for (const c of writingColumns()) {
      const top = c.y - 48
      const bottom = c.y + (c.h || 160) + 120
      if (wy < top || wy > bottom) continue
      const mid = c.y + (c.h || 160) / 2
      const d = Math.abs(wy - mid)
      if (d < bestDist) {
        best = c
        bestDist = d
      }
    }
    return best
  }

  function absorbFlowLinesInto(page) {
    const flows = flowLines().sort((a, b) => a.y - b.y)
    if (!flows.length || !page) return
    ensureContainerBlocks(page)
    const keep = []
    for (const f of flows) {
      if (f.kind === 'divider') keep.push(newBlock('divider'))
      else if (stripHtml(f.html || '').trim() || f.kind !== 'p') {
        keep.push(
          newBlock(
            f.kind === 'h1' || f.kind === 'bullet' || f.kind === 'number' ? f.kind : 'p',
            f.html || ''
          )
        )
      }
      byId(f.id)?.remove()
      elements = elements.filter((el) => el.id !== f.id)
      selectedIds = selectedIds.filter((id) => id !== f.id)
    }
    if (keep.length) {
      const onlyEmpty =
        page.blocks.length === 1 &&
        page.blocks[0].kind === 'p' &&
        !stripHtml(page.blocks[0].html || '').trim()
      page.blocks = onlyEmpty ? keep : page.blocks.concat(keep)
    }
  }

  function createNotionPageAt(wy) {
    const page = {
      id: uid(),
      type: 'container',
      column: true,
      notion: true,
      x: NOTION_X,
      y: Math.max(48, wy),
      w: writingColumnWidth(),
      h: 160,
      blocks: [newBlock('p', '')],
      title: '',
      z: maxZ() + 10,
    }
    elements.push(page)
    setActivePage(page.id)
    render(page)
    fitContainerHeight(page)
    updateEmpty()
    return page
  }

  function resolvePageToClose(id) {
    if (id && model(id)) return model(id)
    if (activePageId && model(activePageId)) return model(activePageId)
    const selected = selectedModels().find(
      (e) => e.type === 'container' && (e.column || e.notion)
    )
    if (selected) return selected
    return writingColumns()[0] || null
  }

  function closeNotionPage(id) {
    goHome()
  }

  function createNewNotionPage() {
    // Start a blank page below the current one and scroll to it (doesn’t delete writing)
    const page = createNotionPageAt(nextPageY())
    page.z = maxZ() + 10
    select(page.id)
    setActivePage(page.id)
    render(page)
    const first = page.blocks[0]
    if (first) focusBlock(page.id, first.id)
    viewport.scrollTo({
      top: Math.max(0, page.y * scale - 48),
      behavior: 'smooth',
    })
    scheduleSave()
    flashSave('New page — start typing')
    return page
  }

  function blockHasContent(b) {
    if (!b) return false
    if (b.kind === 'image') return Boolean(b.src)
    if (b.kind === 'divider') return true
    return Boolean(stripHtml(b.html || '').trim())
  }

  function flowLines() {
    return elements.filter((e) => e.type === 'flow')
  }

  function getFlowX(fallbackX = 72) {
    const lines = flowLines()
    if (lines.length) return lines[0].x
    return Math.max(0, fallbackX)
  }

  function flowLineHeight(e) {
    const node = byId(e.id)
    if (node) return Math.max(28, node.offsetHeight)
    if (e.kind === 'h1') return 52
    if (e.kind === 'divider') return 28
    return 34
  }

  const FLOW_GAP = 20

  /** Push Y down until this band no longer sits on top of a free-floating image. */
  function flowYPastImages(x, y, w, h = 36) {
    let yPos = Math.max(0, y)
    for (let guard = 0; guard < 64; guard++) {
      let blocker = null
      for (const e of elements) {
        if (e.type !== 'image') continue
        const overlapX = x < e.x + e.w && x + w > e.x
        const overlapY = yPos < e.y + e.h && yPos + h > e.y
        if (overlapX && overlapY) {
          if (!blocker || e.y + e.h > blocker.y + blocker.h) blocker = e
        }
      }
      if (!blocker) break
      yPos = blocker.y + blocker.h + FLOW_GAP
    }
    return yPos
  }

  function removeEmptyWritingContainers() {
    let changed = false
    for (const col of [...writingColumns()]) {
      if (col.id === activePageId) continue
      ensureContainerBlocks(col)
      if (col.blocks.some(blockHasContent)) continue
      byId(col.id)?.remove()
      elements = elements.filter((el) => el.id !== col.id)
      selectedIds = selectedIds.filter((id) => id !== col.id)
      changed = true
    }
    return changed
  }

  function createFlowLine(wx, wy, { kind = 'p', html = '', focus = true } = {}) {
    const x = getFlowX(wx)
    const y = flowYPastImages(x, Math.max(0, wy), FLOW_W, kind === 'h1' ? 52 : 34)
    const e = {
      id: uid(),
      type: 'flow',
      kind,
      x,
      y,
      width: FLOW_W,
      html: html || '',
      z: 2,
    }
    elements.push(e)
    const node = render(e)
    if (focus) {
      select(e.id)
      const body = node.querySelector('.content')
      body?.focus()
      placeCaretAtEnd(body)
    }
    scheduleSave()
    return e
  }

  function reflowAllFlowLines() {
    const lines = flowLines().sort((a, b) => a.y - b.y)
    if (!lines.length) return
    const x = lines[0].x
    let cursor = lines[0].y
    for (const l of lines) {
      l.x = x
      cursor = flowYPastImages(x, cursor, FLOW_W, flowLineHeight(l))
      if (Math.abs((l.y || 0) - cursor) > 1) {
        l.y = cursor
        render(l)
      } else {
        l.y = cursor
      }
      cursor = l.y + flowLineHeight(l) + 10
    }
  }

  function continueFlowAfter(line, { kind, html = '' } = {}) {
    if (!line) return createFlowLine(getFlowX(), 80, { kind: kind || 'p', html })
    const nextKind =
      kind || (line.kind === 'bullet' || line.kind === 'number' ? line.kind : 'p')
    const y = flowYPastImages(line.x, line.y + flowLineHeight(line) + 10, FLOW_W, 36)
    return createFlowLine(line.x, y, { kind: nextKind, html })
  }

  function activeFlowLine() {
    const node = document.activeElement?.closest?.('.el.flow')
    if (node?.dataset?.id) return model(node.dataset.id)
    if (selectedIds.length === 1) {
      const e = model(selectedIds[0])
      if (e?.type === 'flow') return e
    }
    return null
  }

  function setFlowKind(id, kind) {
    const e = model(id)
    if (!e || e.type !== 'flow') return
    if (kind === 'divider') {
      e.kind = 'divider'
      e.html = ''
      render(e)
      continueFlowAfter(e, { kind: 'p' })
      scheduleSave()
      return
    }
    e.kind = kind
    const plain = String(e.html || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\u00a0/g, ' ')
    if (/^\/[^\n]*$/.test(plain.trim())) e.html = ''
    render(e)
    scheduleSave()
    requestAnimationFrame(() => {
      const body = byId(id)?.querySelector('.content')
      body?.focus()
      placeCaretAtEnd(body)
    })
  }

  /** Turn old Doc/column containers into free flow lines. */
  function explodeContainerToFlow(col) {
    ensureContainerBlocks(col)
    const x = col.x
    let y = Math.max(0, col.y)
    for (const b of col.blocks || []) {
      if (b.kind === 'image' && b.src) {
        y = flowYPastImages(x, y, FLOW_W, 200)
        const img = {
          id: uid(),
          type: 'image',
          x,
          y,
          w: Math.min(FLOW_W, 480),
          h: 280,
          src: b.src,
          z: maxZ() + 1,
          inFlow: true,
        }
        elements.push(img)
        render(img)
        y = img.y + img.h + FLOW_GAP
        continue
      }
      if (b.kind === 'divider') {
        y = flowYPastImages(x, y, FLOW_W, 28)
        createFlowLine(x, y, { kind: 'divider', focus: false })
        y += 28
        continue
      }
      if (!blockHasContent(b)) continue
      const kind = b.kind === 'h1' || b.kind === 'bullet' || b.kind === 'number' ? b.kind : 'p'
      y = flowYPastImages(x, y, FLOW_W, kind === 'h1' ? 52 : 34)
      const line = createFlowLine(x, y, { kind, html: b.html || '', focus: false })
      y = line.y + flowLineHeight(line) + 8
    }
    byId(col.id)?.remove()
    elements = elements.filter((el) => el.id !== col.id)
    selectedIds = selectedIds.filter((id) => id !== col.id)
  }

  const MIN_WRITE_W = 220
  const OBSTACLE_PAD = 16

  function columnObstacles(skipId = null) {
    const out = []
    for (const el of elements) {
      if (!el || el.id === skipId) continue
      if (el.type === 'container' && (el.column || el.notion)) continue
      if (el.type === 'flow') continue
      const { w: ew, h: eh } = elSize(el)
      if (ew < 8 || eh < 8) continue
      out.push({ x: el.x, y: el.y, w: ew, h: eh })
    }
    return out
  }

  /** Free horizontal intervals inside [left, right] after punching out obstacles. */
  function freeIntervals(left, right, obstacles, worldY, h) {
    let gaps = [[left, right]]
    for (const o of obstacles) {
      if (worldY >= o.y + o.h || worldY + h <= o.y) continue
      const ox0 = o.x - OBSTACLE_PAD
      const ox1 = o.x + o.w + OBSTACLE_PAD
      const next = []
      for (const [a, b] of gaps) {
        if (ox1 <= a || ox0 >= b) {
          next.push([a, b])
          continue
        }
        if (ox0 > a) next.push([a, Math.min(b, ox0)])
        if (ox1 < b) next.push([Math.max(a, ox1), b])
      }
      gaps = next
    }
    return gaps.filter(([a, b]) => b - a >= MIN_WRITE_W)
  }

  /**
   * Place a writing line at the soonest Y that still has usable horizontal room
   * beside (or clear of) images/notes — indent into free space instead of only
   * jumping under a fully clear band.
   */
  function placeBlockBesideObstacles(colX, colW, startWorldY, h, skipId = null) {
    const obstacles = columnObstacles(skipId)
    let yPos = Math.max(0, startWorldY)
    for (let guard = 0; guard < 96; guard++) {
      const gaps = freeIntervals(colX, colX + colW, obstacles, yPos, h)
      if (gaps.length) {
        // Prefer the leftmost usable strip so text keeps a Notion-like left edge when possible
        gaps.sort((a, b) => a[0] - b[0] || b[1] - b[0] - (a[1] - a[0]))
        const [gx0, gx1] = gaps[0]
        return {
          worldY: yPos,
          left: Math.max(0, gx0 - colX),
          width: Math.max(MIN_WRITE_W, gx1 - gx0),
        }
      }
      // No room on this band — drop just below the lowest overlapping obstacle
      let nextY = yPos + h + 8
      for (const o of obstacles) {
        if (yPos < o.y + o.h && yPos + h > o.y) {
          nextY = Math.max(nextY, o.y + o.h + OBSTACLE_PAD)
        }
      }
      if (nextY <= yPos) nextY = yPos + 24
      yPos = nextY
    }
    return { worldY: yPos, left: 0, width: colW }
  }

  /** Skip writing lines under anything sitting in the column (images, notes, titles). */
  function flowYPastObstacles(x, y, w, h = 40, skipId = null) {
    return placeBlockBesideObstacles(x, w, y, h, skipId).worldY
  }

  /**
   * Lay out writing blocks in one column. When an image/note sits in the lane,
   * use remaining free width on that line (indent); only jump under if there's
   * no usable strip left.
   */
  function layoutColumnAroundImages(e) {
    if (!e || e.type !== 'container' || !(e.column || e.notion)) return
    ensureContainerBlocks(e)
    const node = byId(e.id)
    const root = node?.querySelector('.blocks')
    if (!node || !root) return

    e.w = writingColumnWidth()
    node.style.width = e.w + 'px'

    root.style.position = 'relative'
    root.style.minHeight = '48px'

    let y = 0
    const rows = [...root.querySelectorAll(':scope > .block')]
    for (const row of rows) {
      // First pass: place with current height, then remeasure after width shrinks
      let approxH = Math.max(44, row.offsetHeight || 44)
      let place = placeBlockBesideObstacles(e.x, e.w, e.y + y, approxH, e.id)
      y = Math.max(0, place.worldY - e.y)
      row.style.position = 'absolute'
      row.style.left = place.left + 'px'
      row.style.right = 'auto'
      row.style.width = Math.min(place.width, e.w - place.left) + 'px'
      row.style.top = y + 'px'
      const hAfter = Math.max(40, row.offsetHeight || approxH)
      if (hAfter !== approxH) {
        place = placeBlockBesideObstacles(e.x, e.w, e.y + y, hAfter, e.id)
        y = Math.max(0, place.worldY - e.y)
        row.style.left = place.left + 'px'
        row.style.width = Math.min(place.width, e.w - place.left) + 'px'
        row.style.top = y + 'px'
      }
      const h = Math.max(40, row.offsetHeight || hAfter)
      y += h + 8
    }
    const nextH = Math.max(100, y + 64)
    e.h = nextH
    node.style.height = nextH + 'px'
    root.style.height = nextH + 'px'
  }

  function consolidateWritingColumns() {
    removeEmptyWritingContainers()
    const flows = flowLines()
    const cols = writingColumns()

    // Drop empty free-flow leftovers (wait for double-click / New page to write)
    const flowHasContent = flows.some(
      (f) => f.kind === 'divider' || f.kind !== 'p' || stripHtml(f.html || '').trim()
    )
    if (flows.length && !flowHasContent) {
      for (const f of flows) {
        byId(f.id)?.remove()
        elements = elements.filter((el) => el.id !== f.id)
      }
    } else if (flows.length && cols[0]) {
      absorbFlowLinesInto(cols[0])
      render(cols[0])
      fitContainerHeight(cols[0])
    }

    // Keep multiple pages — never merge them into one
    for (const col of writingColumns()) {
      col.column = true
      col.notion = true
      col.w = writingColumnWidth()
    }
    if (!activePageId || !model(activePageId)) {
      setActivePage(writingColumns()[0]?.id || null)
    }
    return Boolean(writingColumns().length)
  }

  /**
   * Double-click empty → Notion-style page. Multiple pages allowed —
   * use New page / Close page to manage them.
   */
  /** Left edge for the writing column — blocks share this fixed starting point. */
  const NOTION_X = 48
  /** Writing column stretches to the right edge of the screen (full page width). */
  function writingColumnWidth() {
    const pageW = Math.floor(viewport.clientWidth / Math.max(scale, 0.01))
    return Math.max(640, pageW - NOTION_X - 16)
  }
  const NOTION_W = writingColumnWidth()

  function ensureNotionPage(wx = NOTION_X, wy = 72) {
    let page =
      findPageNearY(wy) ||
      (activePageId && model(activePageId)) ||
      getWritingColumn()

    if (!page || page.type !== 'container') {
      page = createNotionPageAt(Math.max(48, wy))
    }

    setActivePage(page.id)
    ensureContainerBlocks(page)
    absorbFlowLinesInto(page)
    if (!page.blocks.length) page.blocks = [newBlock('p', '')]
    page.column = true
    page.notion = true
    page.w = writingColumnWidth()
    if (page.x == null || Number.isNaN(page.x)) page.x = NOTION_X
    render(page)
    fitContainerHeight(page)
    return page
  }

  function focusWritingAt(wx, wy) {
    removeEmptyWritingContainers()
    const page = ensureNotionPage(wx, wy)
    const rich = page.blocks.some(blockHasContent)
    // Empty page: only the vertical start follows the click — left edge stays fixed
    if (!rich) {
      page.y = Math.max(48, wy)
      if (page.x == null) page.x = NOTION_X
      page.w = writingColumnWidth()
      render(page)
      fitContainerHeight(page)
    }
    page.w = writingColumnWidth()
    select(page.id)
    setActivePage(page.id)

    ensureContainerBlocks(page)
    const node = byId(page.id)
    const rows = [...(node?.querySelectorAll('.block') || [])]

    // Click below content → new empty block at end (same left edge)
    if (wy > page.y + (page.h || 0) - 16) {
      const last = page.blocks[page.blocks.length - 1]
      if (last && blockHasContent(last)) {
        const nb = insertBlockAfter(page.id, last.id, 'p')
        if (nb) focusBlock(page.id, nb.id)
        return page
      }
      if (last) {
        focusBlock(page.id, last.id)
        return page
      }
    }

    // Nearest text block to click Y — all share page.x
    let best = null
    let bestDist = Infinity
    for (const row of rows) {
      const b = page.blocks.find((x) => x.id === row.dataset.blockId)
      if (!b || b.kind === 'image' || b.kind === 'divider') continue
      const top = page.y + row.offsetTop
      const dist = Math.abs(top - wy)
      if (dist < bestDist) {
        bestDist = dist
        best = b
      }
    }
    if (!best) {
      const nb =
        page.blocks.find((b) => b.kind !== 'image' && b.kind !== 'divider') || newBlock('p', '')
      if (!page.blocks.includes(nb)) {
        page.blocks.push(nb)
        render(page)
        fitContainerHeight(page)
      }
      best = nb
    }
    focusBlock(page.id, best.id)
    return page
  }

  function liveElements() {
    return elements.map((e) => {
      if (e.type === 'container') {
        syncContainerBlocks(e)
        return {
          ...e,
          blocks: (e.blocks || []).map((b) => ({ ...b })),
          html: blocksToHtml(e.blocks || []),
        }
      }
      if (isTextLike(e) || e.type === 'flow') {
        const live = byId(e.id)?.querySelector('.content')?.innerHTML
        if (live != null && e.kind !== 'divider') e.html = live
        return { ...e, html: e.html || '' }
      }
      return { ...e }
    })
  }

  function snapshot() {
    return JSON.stringify({ elements: liveElements(), nextId })
  }

  function updateHistoryButtons() {
    undoBtn.disabled = undoStack.length < 2
    redoBtn.disabled = redoStack.length === 0
  }

  function pushHistory() {
    if (disposed || applyingHistory) return
    const snap = snapshot()
    if (undoStack[undoStack.length - 1] === snap) return
    undoStack.push(snap)
    while (undoStack.length > HISTORY_LIMIT) undoStack.shift()
    redoStack.length = 0
    updateHistoryButtons()
  }

  function restoreSnapshot(snap) {
    applyingHistory = true
    const data = JSON.parse(snap)
    deselect()
    clearWorld()
    elements = data.elements || []
    nextId = data.nextId || elements.length + 1
    elements.forEach(render)
    updateEmpty()
    updateWorldSize()
    applyView()
    applyingHistory = false
    updateHistoryButtons()
    syncAllLinkedToCart()
    persist()
  }

  function undo() {
    if (undoStack.length < 2) return
    const current = undoStack.pop()
    redoStack.push(current)
    restoreSnapshot(undoStack[undoStack.length - 1])
    flashSave('Undo')
  }

  function redo() {
    if (!redoStack.length) return
    const snap = redoStack.pop()
    undoStack.push(snap)
    restoreSnapshot(snap)
    flashSave('Redo')
  }

  function contentBottom() {
    const minPage = viewport.clientHeight * 3
    let bottom = minPage
    for (const e of elements) {
      if (e.type === 'image' || e.type === 'container' || e.type === 'spotify' || e.type === 'gif') {
        bottom = Math.max(bottom, e.y + e.h + viewport.clientHeight)
      } else {
        const node = byId(e.id)
        const h = node?.offsetHeight || 80
        bottom = Math.max(bottom, e.y + h + viewport.clientHeight)
      }
    }
    return bottom
  }

  function updateWorldSize() {
    world.style.minHeight = contentBottom() + 'px'
    if (scale !== 1) {
      world.style.width = viewport.clientWidth / scale + 'px'
    } else {
      world.style.width = '100%'
    }
  }

  function applyView() {
    world.style.transform = scale === 1 ? 'none' : `scale(${scale})`
    viewport.style.backgroundSize = `${28 * scale}px ${28 * scale}px`
    updateWorldSize()
    zoomLabel.textContent = Math.round(scale * 100) + '%'
    positionToolbar()
    // Keep column width in sync with zoom, but don't reflow around images
    // unless the user is actually typing — paste/zoom shouldn't shove the board.
    const writing = document.activeElement?.closest?.('.el.container.column')
    if (writing) layoutAllWritingColumns()
    else {
      for (const col of writingColumns()) {
        col.w = writingColumnWidth()
        const node = byId(col.id)
        if (node) node.style.width = col.w + 'px'
      }
    }
  }

  function updateEmpty() {
    emptyState.classList.toggle('hidden', viewMode === 'library' || elements.length > 0)
  }

  function flashSave(text, ms = 1200) {
    if (!saveDot) return
    saveDot.textContent = text
    const err = /couldn|blocked|offline|full/i.test(text)
    saveDot.classList.toggle('error', err)
    saveDot.classList.toggle('ok', !err && /saved/i.test(text))
  }

  function scheduleSave({ soft = false } = {}) {
    if (disposed || applyingHistory || !hydrated) return
    flashSave('Saving…')
    clearTimeout(saveTimer)
    if (soft) {
      // Persist without bloating undo (avoids cloning huge image payloads every keystroke)
      saveTimer = setTimeout(persist, 900)
    } else {
      pushHistory()
      saveTimer = setTimeout(persist, 900)
    }
    updateEmpty()
    updateWorldSize()
  }

  async function persist() {
    if (disposed || !hydrated) return
    try {
      flushCurrentPage()
      const pageList = pages.map((p) => ({
        id: p.id,
        title: p.title || '',
        elements: p.id === currentPageId ? liveElements() : p.elements || [],
        scrollTop: p.scrollTop || 0,
        scale: p.scale || 1,
      }))
      const richest = pageList.reduce(
        (a, p) => ((p.elements?.length || 0) > (a?.elements?.length || 0) ? p : a),
        pageList[0] || null
      )
      const doc = {
        mode: 'canvas',
        pages: pageList,
        currentPageId,
        view: viewMode,
        elements:
          currentPageId && viewMode === 'page'
            ? liveElements()
            : richest?.elements || [],
        nextId,
        scale,
        scrollTop: viewport.scrollTop,
      }
      await saveCanvas(doc)
      flashSave('Saved')
    } catch (err) {
      console.error(err)
      const msg = String(err?.message || err)
      if (/Refusing to overwrite/i.test(msg)) {
        flashSave('Save blocked — refresh to reload your board', 5000)
        return
      }
      const missing = /canvas_boards|PGRST205|schema cache|Failed to fetch|ECONNREFUSED/i.test(msg)
      flashSave(missing ? 'Server offline — run npm run dev' : 'Couldn’t save', 4000)
    }
  }

  function clearWorld() {
    world.querySelectorAll('.el').forEach((n) => n.remove())
    clearGuides()
    elements = []
    selectedIds = []
    cropState = null
    elToolbar.style.display = 'none'
    elToolbar.innerHTML = ''
    if (selFrame) selFrame.hidden = true
  }

  async function load() {
    hydrated = false
    try {
      const d = await loadCanvas()
      clearWorld()
      let migrated = false

      const mapPageBlock = (b) => {
        if (b.type === 'image' || b.kind === 'image') {
          const nb = newBlock('image')
          nb.src = b.src
          nb.href = b.href || null
          nb.price = b.price ?? null
          nb.label = b.label || null
          nb.cartStatus = b.cartStatus || null
          return nb
        }
        if (b.type === 'heading' || b.kind === 'h1') return newBlock('h1', b.html || '')
        if (b.type === 'bullet' || b.kind === 'bullet') return newBlock('bullet', b.html || '')
        if (b.type === 'number' || b.kind === 'number') return newBlock('number', b.html || '')
        if (b.type === 'divider' || b.kind === 'divider') return newBlock('divider')
        return newBlock('p', b.html || '')
      }

      const normalizeEls = (list) =>
        (list || []).map((e) => {
          if (e.type === 'container') {
            if (!Array.isArray(e.blocks) || !e.blocks.length) {
              migrated = true
              const from = e.html || (e.title ? `<h2>${escapeHtml(e.title)}</h2>` : '')
              const { title, html, ...rest } = e
              return { ...rest, column: true, blocks: htmlToBlocks(from) }
            }
            ensureContainerBlocks(e)
            if (!e.column) {
              migrated = true
              e.column = true
            }
            return e
          }
          if (e.type === 'text' && (e.fontSize || 16) >= 28) {
            migrated = true
            return { ...e, type: 'title' }
          }
          return e
        })

      if (Array.isArray(d.pages) && d.pages.length) {
        pages = d.pages.map((p) => ({
          id: p.id || pageUid(),
          title: p.title || '',
          elements: normalizeEls(p.elements),
          scrollTop: p.scrollTop || 0,
          scale: p.scale || 1,
        }))
      } else if (
        d.mode === 'page' &&
        Array.isArray(d.blocks) &&
        d.blocks.length &&
        !(Array.isArray(d.elements) && d.elements.length)
      ) {
        migrated = true
        pages = [
          {
            id: pageUid(),
            title: '',
            elements: [
              {
                id: uid(),
                type: 'container',
                column: true,
                x: 72,
                y: 80,
                w: 640,
                h: 400,
                blocks: d.blocks.map(mapPageBlock),
              },
            ],
            scrollTop: 0,
            scale: 1,
          },
        ]
      } else {
        const els = normalizeEls(d.elements || [])
        if (els.length) migrated = !d.pages
        pages = [
          {
            id: pageUid(),
            title: '',
            elements: els,
            scrollTop: d.scrollTop ?? 0,
            scale: d.scale || 1,
          },
        ]
        const t = derivePageTitle(pages[0])
        if (t && t !== 'Untitled') pages[0].title = t
      }

      nextId = d.nextId || 1
      for (const p of pages) {
        const pn = Number(String(p.id).replace(/\D/g, ''))
        if (pn >= nextId) nextId = pn + 1
        for (const e of p.elements || []) {
          const en = Number(String(e.id).replace(/\D/g, ''))
          if (en >= nextId) nextId = en + 1
        }
      }
      scale = 1
      elements = []
      hydrated = true
      showLibrary({ skipFlush: true })
      if (migrated) scheduleSave({ soft: true })
    } catch (err) {
      console.error(err)
      hydrated = false
      flashSave('Couldn’t load board — refresh to retry (nothing was erased)', 5000)
      showLibrary({ skipFlush: true })
    }
    updateEmpty()
    undoStack.length = 0
    redoStack.length = 0
    if (hydrated) pushHistory()
    updateCartBadge()
    if (cartOpen) renderCart()
    try {
      const stored = parseCanvasClipboard(sessionStorage.getItem(CLIP_STORE))
      if (stored?.length) clipboardItems = stored
    } catch {
      /* ignore */
    }
  }

  function render(e) {
    let node = byId(e.id)
    if (!node) {
      node = document.createElement('div')
      node.dataset.id = e.id
      node.className = 'el ' + e.type
      world.appendChild(node)
      if (e.type === 'image') {
        const img = document.createElement('img')
        img.draggable = false
        img.loading = 'lazy'
        img.decoding = 'async'
        node.appendChild(img)
        const rh = document.createElement('div')
        rh.className = 'resize-handle'
        node.appendChild(rh)
      } else if (e.type === 'spotify') {
        const drag = document.createElement('div')
        drag.className = 'drag-dots'
        drag.title = 'Drag to move'
        drag.textContent = '⋮⋮'
        const frame = document.createElement('iframe')
        frame.className = 'spotify-frame'
        frame.setAttribute(
          'allow',
          'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture'
        )
        frame.setAttribute('allowfullscreen', '')
        frame.setAttribute('loading', 'lazy')
        frame.setAttribute('frameborder', '0')
        frame.title = 'Spotify player'
        const rh = document.createElement('div')
        rh.className = 'resize-handle'
        node.append(drag, frame, rh)
      } else if (e.type === 'gif') {
        const drag = document.createElement('div')
        drag.className = 'gif-drag'
        drag.title = 'Drag to move'
        drag.textContent = 'GIF'
        const frame = document.createElement('iframe')
        frame.className = 'gif-frame'
        frame.setAttribute('loading', 'lazy')
        frame.title = 'GIF'
        const rh = document.createElement('div')
        rh.className = 'resize-handle'
        node.append(drag, frame, rh)
      } else if (e.type === 'container') {
        const bar = document.createElement('div')
        bar.className = 'drag-bar'
        bar.title = 'Drag to move writing column'
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'page-close'
        closeBtn.title = 'Close page'
        closeBtn.setAttribute('aria-label', 'Close page')
        closeBtn.textContent = '×'
        bar.appendChild(closeBtn)
        const blocks = document.createElement('div')
        blocks.className = 'blocks'
        const rh = document.createElement('div')
        rh.className = 'resize-handle'
        node.append(bar, blocks, rh)
      } else if (e.type === 'flow') {
        const dots = document.createElement('div')
        dots.className = 'drag-dots'
        dots.textContent = '⋮⋮'
        const content = document.createElement('div')
        content.className = 'content'
        content.spellcheck = true
        const wh = document.createElement('div')
        wh.className = 'width-handle'
        node.append(dots, content, wh)
        bindFlowEditor(e.id, content)
      } else {
        const dots = document.createElement('div')
        dots.className = 'drag-dots'
        dots.textContent = '⋮⋮'
        const content = document.createElement('div')
        content.className = 'content'
        content.contentEditable = 'true'
        content.spellcheck = false
        bindContentEditor(e.id, content)
        const wh = document.createElement('div')
        wh.className = 'width-handle'
        node.append(dots, content, wh)
      }
    }
    node.style.left = e.x + 'px'
    node.style.top = e.y + 'px'
    node.style.zIndex = String(e.z ?? 1)
    if (e.type === 'image') {
      node.classList.toggle('sticker', Boolean(e.sticker))
      node.classList.toggle('flip-x', Boolean(e.flipX))
      node.classList.toggle('flip-y', Boolean(e.flipY))
      node.style.width = e.w + 'px'
      node.style.height = e.h + 'px'
      const rot = ((Number(e.rot) || 0) % 360 + 360) % 360
      node.style.transform = rot ? `rotate(${rot}deg)` : ''
      node.style.transformOrigin = 'center center'
      const img = node.querySelector('img')
      if (img.getAttribute('src') !== e.src) img.setAttribute('src', e.src)
      const sx = e.flipX ? -1 : 1
      const sy = e.flipY ? -1 : 1
      img.style.transform = sx === 1 && sy === 1 ? '' : `scale(${sx}, ${sy})`
    } else if (e.type === 'spotify') {
      node.style.width = e.w + 'px'
      node.style.height = e.h + 'px'
      const oldBar = node.querySelector('.spotify-drag')
      if (oldBar) {
        oldBar.className = 'drag-dots'
        oldBar.title = 'Drag to move'
        oldBar.textContent = '⋮⋮'
      }
      const frame = node.querySelector('.spotify-frame')
      const src = spotifyEmbedSrc(e)
      if (frame && src && frame.getAttribute('src') !== src) frame.setAttribute('src', src)
    } else if (e.type === 'gif') {
      node.style.width = e.w + 'px'
      node.style.height = e.h + 'px'
      const frame = node.querySelector('.gif-frame')
      if (frame && frame.getAttribute('src') !== e.embed) frame.setAttribute('src', e.embed)
    } else if (e.type === 'container') {
      node.classList.toggle('column', Boolean(e.column))
      node.classList.toggle('notion', Boolean(e.notion || e.column))
      if (e.column || e.notion) {
        // Notion page: fixed left edge + reading width — every block shares this point
        e.x = NOTION_X
        e.w = writingColumnWidth()
      }
      node.style.left = e.x + 'px'
      node.style.width = e.w + 'px'
      node.style.height = e.h + 'px'
      const bar = node.querySelector('.drag-bar')
      if (bar) bar.title = e.column || e.notion ? 'Drag page · Close to remove writing' : 'Drag to move'
      let closeBtn = bar?.querySelector('.page-close')
      if ((e.column || e.notion) && bar && !closeBtn) {
        closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'page-close'
        closeBtn.title = 'Close page'
        closeBtn.setAttribute('aria-label', 'Close page')
        closeBtn.textContent = '×'
        bar.appendChild(closeBtn)
      }
      if (closeBtn) closeBtn.hidden = !(e.column || e.notion)
      node.querySelectorAll('.page-title').forEach((n) => n.remove())
      renderContainerBlocks(e, node)
      applyTextStyles(e)
      fitContainerHeight(e)
    } else if (e.type === 'flow') {
      node.dataset.kind = e.kind || 'p'
      node.style.width = (e.width || FLOW_W) + 'px'
      const content = node.querySelector('.content')
      if (e.kind === 'divider') {
        if (content) {
          content.contentEditable = 'false'
          content.innerHTML = ''
          content.dataset.placeholder = ''
        }
      } else if (content) {
        content.contentEditable = 'true'
        content.dataset.placeholder = placeholderForKind(e.kind || 'p')
        syncContentNode(e)
      }
    } else {
      // text note (boxed) or title (no box)
      node.style.width = (e.width || (e.type === 'title' ? 360 : 340)) + 'px'
      syncContentNode(e)
      applyTextStyles(e)
    }
    if (e.type === 'image' || e.type === 'text') updateElementMeta(node, e)
    return node
  }

  function bindContentEditor(id, content) {
    content.addEventListener('input', () => {
      const e = model(id)
      if (e) e.html = content.innerHTML
      scheduleSave({ soft: true })
    })
    content.addEventListener('blur', () => {
      const e = model(id)
      if (e) e.html = content.innerHTML
    })
  }

  function bindFlowEditor(id, content) {
    content.addEventListener('input', () => {
      const e = model(id)
      if (!e || e.type !== 'flow') return
      e.html = content.innerHTML
      const q = slashQuery(content)
      if (q !== null) openBlockMenu(id, id, byId(id), { query: q, flow: true })
      else closeBlockMenu()
      scheduleSave({ soft: true })
    })
    content.addEventListener('keydown', (ev) => {
      const e = model(id)
      if (!e || e.type !== 'flow') return
      const menuOpen = Boolean(document.getElementById('blockMenu'))

      if (menuOpen && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter')) {
        const menu = document.getElementById('blockMenu')
        if (ev.key === 'Enter' && slashQuery(content) !== null) {
          ev.preventDefault()
          menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return
        }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault()
          menu?.dispatchEvent(new KeyboardEvent('keydown', { key: ev.key, bubbles: true }))
          return
        }
      }

      if (ev.key === ' ' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const plain = (content.textContent || '').replace(/\u00a0/g, ' ').trim()
        const map = [
          { re: /^#$/, kind: 'h1' },
          { re: /^-$/, kind: 'bullet' },
          { re: /^\*$/, kind: 'bullet' },
          { re: /^1\.$/, kind: 'number' },
          { re: /^---$/, kind: 'divider' },
        ]
        for (const { re, kind } of map) {
          if (re.test(plain)) {
            ev.preventDefault()
            content.innerHTML = ''
            e.html = ''
            setFlowKind(id, kind)
            return
          }
        }
      }

      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        closeBlockMenu()
        e.html = content.innerHTML
        if ((e.kind === 'bullet' || e.kind === 'number') && !content.textContent.trim()) {
          e.kind = 'p'
          e.html = ''
          render(e)
          scheduleSave()
          content.focus()
          return
        }
        const { before, after } = splitHtmlAtCaret(content)
        e.html = before
        content.innerHTML = before
        continueFlowAfter(e, {
          kind: e.kind === 'bullet' || e.kind === 'number' ? e.kind : 'p',
          html: after,
        })
        return
      }

      if (ev.key === 'Backspace' && caretAtStart(content)) {
        const plain = content.textContent || ''
        if (!plain.trim()) {
          ev.preventDefault()
          const lines = flowLines().sort((a, b) => a.y - b.y)
          const idx = lines.findIndex((l) => l.id === id)
          const prev = idx > 0 ? lines[idx - 1] : null
          removeElement(id)
          if (prev && prev.kind !== 'divider') {
            select(prev.id)
            const body = byId(prev.id)?.querySelector('.content')
            body?.focus()
            placeCaretAtEnd(body)
          }
          return
        }
        if (e.kind === 'h1' || e.kind === 'bullet' || e.kind === 'number') {
          ev.preventDefault()
          e.kind = 'p'
          render(e)
          scheduleSave()
          content.focus()
        }
      }

      if (ev.key === 'Escape') closeBlockMenu()
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === '/') {
        ev.preventDefault()
        openBlockMenu(id, id, byId(id), { flow: true })
      }
    })
    content.addEventListener('blur', () => {
      const e = model(id)
      if (e && e.type === 'flow' && e.kind !== 'divider') e.html = content.innerHTML
      setTimeout(() => {
        // Drop stray empty lines so the board doesn’t show placeholder chrome
        const lines = flowLines()
        for (const l of lines) {
          if (l.kind === 'divider') continue
          if (stripHtml(l.html || '').trim()) continue
          if (document.activeElement?.closest?.('.el')?.dataset?.id === l.id) continue
          if (lines.length <= 1) {
            // hide sole empty line when not focused
            byId(l.id)?.classList.add('flow-idle')
            continue
          }
          byId(l.id)?.remove()
          elements = elements.filter((el) => el.id !== l.id)
        }
        scheduleSave({ soft: true })
      }, 120)
    })
    content.addEventListener('focus', () => {
      byId(id)?.classList.remove('flow-idle')
    })
  }

  function syncContentNode(e) {
    const c = byId(e.id)?.querySelector('.content')
    if (!c) return
    // Keep model in sync while editing so later renders can't wipe text
    if (document.activeElement === c) {
      e.html = c.innerHTML
      return
    }
    if (!(e.html || '') && c.innerHTML) e.html = c.innerHTML
    if (c.innerHTML !== (e.html || '')) c.innerHTML = e.html || ''
  }

  function removeElement(id) {
    const n = byId(id)
    if (n) n.remove()
    elements = elements.filter((el) => el.id !== id)
    if (activePageId === id) {
      setActivePage(writingColumns()[0]?.id || null)
    }
    if (isSelected(id)) {
      selectedIds = selectedIds.filter((x) => x !== id)
      if (!selectedIds.length) {
        elToolbar.style.display = 'none'
        elToolbar.innerHTML = ''
      } else {
        buildToolbar()
        positionToolbar()
      }
    }
    renderCart()
    updateCartBadge()
    scheduleSave()
  }

  function removeSelected() {
    const ids = [...selectedIds]
    if (!ids.length) return
    deselect()
    for (const id of ids) {
      const n = byId(id)
      if (n) n.remove()
      elements = elements.filter((el) => el.id !== id)
    }
    renderCart()
    updateCartBadge()
    scheduleSave()
  }

  function setSelection(ids, { silent = false } = {}) {
    const next = []
    const seen = new Set()
    for (const id of ids) {
      if (!model(id) || seen.has(id)) continue
      seen.add(id)
      next.push(id)
    }
    for (const id of selectedIds) {
      if (!seen.has(id)) byId(id)?.classList.remove('selected')
    }
    selectedIds = next
    for (const id of selectedIds) byId(id)?.classList.add('selected')
    const writingSelected = selectedIds.some((id) => {
      const e = model(id)
      return e?.type === 'container' && (e.column || e.notion)
    })
    if (!writingSelected) {
      document.querySelectorAll('.el.notion-active').forEach((n) => n.classList.remove('notion-active'))
    }
    if (!silent) {
      if (!selectedIds.length) {
        document.querySelectorAll('.el.notion-active').forEach((n) => n.classList.remove('notion-active'))
        elToolbar.style.display = 'none'
        elToolbar.innerHTML = ''
        updateSelectionFrame()
        removeEmptyWritingContainers()
      } else {
        buildToolbar()
        positionToolbar()
        updateSelectionFrame()
      }
    } else {
      updateSelectionFrame()
    }
  }

  function select(id, { additive = false } = {}) {
    if (!id || !model(id)) return
    if (additive) {
      if (isSelected(id)) setSelection(selectedIds.filter((x) => x !== id))
      else setSelection([...selectedIds, id])
      return
    }
    const e = model(id)
    if (e?.type === 'container' && (e.column || e.notion)) setActivePage(e.id)
    if (e?.groupId) {
      const members = elements.filter((x) => x.groupId === e.groupId).map((x) => x.id)
      setSelection([...members.filter((x) => x !== id), id])
      return
    }
    setSelection([id])
  }

  function deselect() {
    document.querySelectorAll('.el.notion-active').forEach((n) => n.classList.remove('notion-active'))
    for (const id of selectedIds) byId(id)?.classList.remove('selected')
    selectedIds = []
    elToolbar.style.display = 'none'
    elToolbar.innerHTML = ''
    if (selFrame) selFrame.hidden = true
    // Empty Notion page shouldn’t leave a ghost placeholder on the moodboard
    removeEmptyWritingContainers()
  }

  function selectedModels() {
    return selectedIds.map(model).filter(Boolean)
  }

  function selectionBounds() {
    const items = selectedModels()
    if (!items.length) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const e of items) {
      const { w, h } = elSize(e)
      minX = Math.min(minX, e.x)
      minY = Math.min(minY, e.y)
      maxX = Math.max(maxX, e.x + w)
      maxY = Math.max(maxY, e.y + h)
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  function selectionIsGrouped() {
    const items = selectedModels()
    if (items.length < 2) return false
    const g = items[0].groupId
    return Boolean(g) && items.every((e) => e.groupId === g)
  }

  function updateSelectionFrame() {
    if (!selFrame) return
    if (selectedIds.length < 2) {
      selFrame.hidden = true
      return
    }
    const b = selectionBounds()
    if (!b || b.w < 2 || b.h < 2) {
      selFrame.hidden = true
      return
    }
    selFrame.hidden = false
    selFrame.classList.toggle('grouped', selectionIsGrouped())
    selFrame.style.left = b.x + 'px'
    selFrame.style.top = b.y + 'px'
    selFrame.style.width = b.w + 'px'
    selFrame.style.height = b.h + 'px'
  }

  function groupSelected() {
    const items = selectedModels()
    if (items.length < 2) {
      flashSave('Select at least 2 items to group')
      return
    }
    const id = gid()
    for (const e of items) e.groupId = id
    updateSelectionFrame()
    buildToolbar()
    scheduleSave()
    flashSave(`Grouped ${items.length}`)
  }

  function ungroupSelected() {
    const items = selectedModels()
    if (!items.length) return
    for (const e of items) delete e.groupId
    updateSelectionFrame()
    buildToolbar()
    scheduleSave()
    flashSave('Ungrouped')
  }

  function scaleSelected(factor, origin) {
    const items = selectedModels()
    if (items.length < 2) return
    const b = selectionBounds()
    if (!b) return
    const ox = origin?.x ?? b.x
    const oy = origin?.y ?? b.y
    factor = clamp(factor, 0.15, 8)
    for (const e of items) {
      e.x = ox + (e.x - ox) * factor
      e.y = Math.max(0, oy + (e.y - oy) * factor)
      if (e.type === 'image' || e.type === 'container' || e.type === 'spotify' || e.type === 'gif') {
        e.w = Math.max(28, e.w * factor)
        e.h = Math.max(28, e.h * factor)
      } else if (isTextLike(e)) {
        e.width = Math.max(72, (e.width || (e.type === 'title' ? 360 : 280)) * factor)
        const base = e.fontSize || (e.type === 'title' ? 32 : 16)
        e.fontSize = clamp(Math.round(base * factor), 10, 96)
      }
      render(e)
    }
    updateSelectionFrame()
    positionToolbar()
    updateWorldSize()
  }

  function nudgeGroupScale(dir) {
    scaleSelected(dir < 0 ? 0.9 : 1.1)
    scheduleSave()
  }

  function captureScaleOrigins() {
    return selectedModels().map((e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      w: e.w,
      h: e.h,
      width: e.width,
      fontSize: e.fontSize,
    }))
  }

  function applyScaleFromOrigins(origins, factor, ox, oy) {
    factor = clamp(factor, 0.15, 8)
    for (const o of origins) {
      const e = model(o.id)
      if (!e) continue
      e.x = ox + (o.x - ox) * factor
      e.y = Math.max(0, oy + (o.y - oy) * factor)
      if (e.type === 'image' || e.type === 'container' || e.type === 'spotify' || e.type === 'gif') {
        e.w = Math.max(28, o.w * factor)
        e.h = Math.max(28, o.h * factor)
      } else if (isTextLike(e)) {
        e.width = Math.max(72, (o.width || 280) * factor)
        const base = o.fontSize || (e.type === 'title' ? 32 : 16)
        e.fontSize = clamp(Math.round(base * factor), 10, 96)
      }
      render(e)
    }
    updateSelectionFrame()
    positionToolbar()
    updateWorldSize()
  }

  function buildToolbar() {
    if (!selectedIds.length) return
    elToolbar.innerHTML = ''

    if (selectedIds.length > 1) {
      const label = document.createElement('span')
      label.className = 'tb-label'
      label.textContent = selectionIsGrouped()
        ? `Group · ${selectedIds.length}`
        : `${selectedIds.length} selected`
      elToolbar.appendChild(label)
      addSep()
      if (selectionIsGrouped()) {
        addBtn('Ungroup', () => ungroupSelected())
      } else {
        addBtn('Group', () => groupSelected())
      }
      addSep()
      addBtn('Smaller', () => nudgeGroupScale(-1), null, 'Scale down')
      addBtn('Bigger', () => nudgeGroupScale(1), null, 'Scale up')
      addSep()
      addBtn('Front', () => {
        const base = maxZ()
        selectedIds.forEach((id, i) => {
          const e = model(id)
          if (!e) return
          e.z = base + 1 + i
          render(e)
        })
        scheduleSave()
      })
      addBtn('Back', () => {
        const base = minZ()
        selectedIds.forEach((id, i) => {
          const e = model(id)
          if (!e) return
          e.z = base - 1 - i
          render(e)
        })
        scheduleSave()
      })
      addSep()
      addBtn('Copy', () => copySelected(), null, 'Copy (⌘C)')
      addBtn('Paste', () => pasteClipboard(), null, 'Paste (⌘V)')
      if (selectedModels().some((el) => el.type === 'image' && el.src)) {
        addBtn('Download', () => downloadSelectedImages(), null, 'Download selected images')
        addSep()
        addBtn('↺', () => rotateSelected(-90), null, 'Rotate left 90°')
        addBtn('↻', () => rotateSelected(90), null, 'Rotate right 90°')
      }
      addSep()
      addBtn('Delete', () => removeSelected(), 'danger')
      elToolbar.style.display = 'flex'
      positionToolbar()
      updateSelectionFrame()
      return
    }

    const e = model(primaryId())
    if (!e) return
    updateSelectionFrame()
    if (cropState) {
      addBtn('Cancel', () => exitCrop(false))
      addBtn('Apply crop', () => exitCrop(true), 'primary')
    } else if (e.type === 'image') {
      addBtn('Crop', () => enterCrop(e.id))
      const eraseBtn = addBtn(
        removingBg ? 'Cutting…' : 'Make sticker',
        () => eraseImageBackground(e.id)
      )
      if (removingBg) eraseBtn.disabled = true
      addSep()
      addBtn('Copy', () => copySelected(), null, 'Copy image (⌘C)')
      addBtn('Paste', () => pasteClipboard(), null, 'Paste (⌘V)')
      addBtn('Download', () => downloadSelectedImages(), null, 'Download image')
      addSep()
      addBtn('Flip H', () => flipImage(e.id, 'x'), null, 'Flip horizontal')
      addBtn('Flip V', () => flipImage(e.id, 'y'), null, 'Flip vertical')
      addBtn('↺', () => rotateImage(e.id, -90), null, 'Rotate left 90°')
      addBtn('↻', () => rotateImage(e.id, 90), null, 'Rotate right 90°')
      addSep()
      addBtn('Front', () => bringToFront(e.id), null, 'Bring to front')
      addBtn('Forward', () => bringForward(e.id), null, 'Bring forward')
      addBtn('Backward', () => sendBackward(e.id), null, 'Send backward')
      addBtn('Back', () => sendToBack(e.id), null, 'Send to back')
      addSep()
      addBtn(e.href ? 'Edit link' : 'Link', () => editElementLink(e.id))
      if (e.href) {
        addBtn('Open', () => openExternalLink(e.href), null, 'Open product link')
      }
      const priceBtn = addBtn(
        findingPrice ? 'Finding…' : e.price != null ? 'Refresh price' : 'Find price',
        () => findPriceForElement(e.id)
      )
      if (findingPrice || !e.href) priceBtn.disabled = true
      if (e.cartStatus === 'later') {
        addBtn('Move to cart', () => addToCart(e.id))
      } else if (e.cartStatus === 'cart') {
        addBtn('Save for later', () => moveToLater(e.id))
      } else if (!e.href) {
        addBtn('Add link', () => editElementLink(e.id))
      }
      addSep()
      addBtn('Delete', () => removeElement(e.id), 'danger')
    } else if (e.type === 'spotify') {
      addBtn('Open in Spotify', () => openExternalLink(e.href), 'primary')
      addSep()
      addBtn('Copy', () => copySelected(), null, 'Copy (⌘C)')
      addSep()
      addBtn('Front', () => bringToFront(e.id))
      addBtn('Back', () => sendToBack(e.id))
      addSep()
      addBtn('Delete', () => removeElement(e.id), 'danger')
    } else if (e.type === 'gif') {
      addBtn('Open GIF', () => openExternalLink(e.href || e.embed), 'primary')
      addSep()
      addBtn('Copy', () => copySelected(), null, 'Copy (⌘C)')
      addSep()
      addBtn('Front', () => bringToFront(e.id))
      addBtn('Back', () => sendToBack(e.id))
      addSep()
      addBtn('Delete', () => removeElement(e.id), 'danger')
    } else if (e.type === 'container' || e.type === 'flow') {
      // Invisible writing: `/` + markdown only — no floating format chrome
      elToolbar.innerHTML = ''
      elToolbar.style.display = 'none'
      return
    } else if (e.type === 'title') {
      addTextFormatTools(e, { lists: false, shop: false })
    } else {
      addTextFormatTools(e, { lists: true, shop: true })
    }
    elToolbar.style.display = 'flex'
    positionToolbar()
  }

  function addTextFormatTools(e, { lists = false, shop = false } = {}) {
    addFormatBtn('B', () => formatInline('bold'), { title: 'Bold', weight: '700' })
    addFormatBtn('I', () => formatInline('italic'), { title: 'Italic', italic: true })
    addFormatBtn('U', () => formatInline('underline'), { title: 'Underline', underline: true })
    addBtn('Link', () => formatInlineLink(), 'fmt', 'Add hyperlink to selection')
    if (lists) {
      addBtn('• List', () => formatInline('insertUnorderedList'), null, 'Bullet list')
      addBtn('1. List', () => formatInline('insertOrderedList'), null, 'Numbered list')
    }
    addSep()
    addBtn('A−', () => nudgeTextSize(e.id, -1), null, 'Smaller')
    addBtn('A+', () => nudgeTextSize(e.id, 1), null, 'Bigger')
    addSep()
    ;[
      { c: '#37352F', label: 'Ink' },
      { c: '#2383E2', label: 'Blue' },
      { c: '#D44C47', label: 'Red' },
      { c: '#0F7B6C', label: 'Teal' },
      { c: '#9B9A97', label: 'Gray' },
    ].forEach(({ c, label }) => addColorSwatch(e.id, c, label))
    addSep()
    addBtn('⟸', () => setTextAlign(e.id, 'left'), null, 'Align left')
    addBtn('≡', () => setTextAlign(e.id, 'center'), null, 'Align center')
    addBtn('⟹', () => setTextAlign(e.id, 'right'), null, 'Align right')
    if (shop) {
      addSep()
      addBtn(e.href ? 'Edit link' : 'Product link', () => editElementLink(e.id))
      if (e.href) {
        addBtn('Open', () => openExternalLink(e.href), null, 'Open product link')
      }
      const priceBtn = addBtn(
        findingPrice ? 'Finding…' : e.price != null ? 'Refresh price' : 'Find price',
        () => findPriceForElement(e.id)
      )
      if (findingPrice || !e.href) priceBtn.disabled = true
      if (e.cartStatus === 'later') {
        addBtn('Move to cart', () => addToCart(e.id))
      } else if (e.cartStatus === 'cart') {
        addBtn('Save for later', () => moveToLater(e.id))
      }
    }
    addSep()
    addBtn('Delete', () => removeElement(e.id), 'danger')
  }

  function addSep() {
    const s = document.createElement('div')
    s.className = 'tb-sep'
    elToolbar.appendChild(s)
  }

  function addBtn(label, fn, cls, title) {
    const b = document.createElement('button')
    b.type = 'button'
    if (cls) b.classList.add(cls)
    if (title) b.title = title
    b.textContent = label
    // preventDefault keeps text selection for bold/italic/etc.
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    })
    b.addEventListener('click', fn)
    elToolbar.appendChild(b)
    return b
  }

  function addFormatBtn(label, fn, { title, weight, italic, underline } = {}) {
    const b = addBtn(label, fn, 'fmt', title)
    if (weight) b.style.fontWeight = weight
    if (italic) b.style.fontStyle = 'italic'
    if (underline) b.style.textDecoration = 'underline'
    return b
  }

  function addColorSwatch(id, color, label) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'swatch'
    b.title = label
    b.style.background = color
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    })
    b.addEventListener('click', () => setTextColor(id, color))
    elToolbar.appendChild(b)
    return b
  }

  function focusText(id) {
    const node = byId(id)
    if (!node) return null
    const content =
      node.querySelector('.block-body:focus') ||
      node.querySelector('.block-body') ||
      node.querySelector('.content')
    if (!content) return null
    if (document.activeElement !== content) content.focus()
    return content
  }

  function syncTextHtml(id) {
    const e = model(id)
    if (!e) return
    if (e.type === 'container') {
      syncContainerBlocks(e)
      scheduleSave()
      return
    }
    const content = byId(id)?.querySelector('.content')
    if (!content) return
    e.html = content.innerHTML
    scheduleSave()
  }

  function formatInline(command) {
    const id = primaryId()
    if (!id) return
    focusText(id)
    document.execCommand(command, false, null)
    syncTextHtml(id)
  }

  const SIZE_STEPS = [12, 14, 16, 18, 22, 28, 32, 36, 48, 64]

  function nudgeTextSize(id, dir) {
    const e = model(id)
    if (!e) return
    const current = e.fontSize || 16
    let idx = SIZE_STEPS.findIndex((s) => s >= current)
    if (idx < 0) idx = SIZE_STEPS.length - 1
    if (SIZE_STEPS[idx] !== current) {
      // snap to nearest then step
      idx = SIZE_STEPS.reduce(
        (best, s, i) => (Math.abs(s - current) < Math.abs(SIZE_STEPS[best] - current) ? i : best),
        0
      )
    }
    idx = clamp(idx + dir, 0, SIZE_STEPS.length - 1)
    e.fontSize = SIZE_STEPS[idx]
    applyTextStyles(e)
    scheduleSave()
  }

  function setTextColor(id, color) {
    const e = model(id)
    if (!e) return
    // If there's a text selection, color just that; otherwise the whole block
    const content = focusText(id)
    const sel = window.getSelection()
    if (content && sel && !sel.isCollapsed && content.contains(sel.anchorNode)) {
      document.execCommand('foreColor', false, color)
      syncTextHtml(id)
      return
    }
    e.color = color
    applyTextStyles(e)
    scheduleSave()
  }

  function setTextAlign(id, align) {
    const e = model(id)
    if (!e) return
    e.align = align
    applyTextStyles(e)
    scheduleSave()
  }

  function applyTextStyles(e) {
    const node = byId(e.id)
    if (!node) return
    const targets =
      e.type === 'container'
        ? [...node.querySelectorAll('.block-body')]
        : [node.querySelector('.content')].filter(Boolean)
    const fallback = e.type === 'title' ? 32 : 16
    for (const content of targets) {
      content.style.fontSize = (e.fontSize || fallback) + 'px'
      content.style.color = e.color || ''
      content.style.textAlign = e.align || ''
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  async function srcToObjectUrl(src) {
    if (src.startsWith('blob:')) return { url: src, revoke: false }
    const res = await fetch(src)
    const blob = await res.blob()
    return { url: URL.createObjectURL(blob), revoke: true }
  }

  /** Trim transparent padding and harden soft alpha so it reads like a sticker. */
  async function trimToSticker(dataUrl) {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = dataUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)

    const { width, height } = canvas
    const imageData = ctx.getImageData(0, 0, width, height)
    const { data } = imageData

    // Harden alpha: kill soft fringe that looks pixelated
    const HARD = 40
    const KEEP = 200
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i]
      if (a < HARD) data[i] = 0
      else if (a > KEEP) data[i] = 255
    }
    ctx.putImageData(imageData, 0, 0)

    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      return { src: dataUrl, trimW: width, trimH: height, padX: 0, padY: 0, fullW: width, fullH: height }
    }

    // tiny padding so edges aren’t clipped
    const pad = 2
    minX = Math.max(0, minX - pad)
    minY = Math.max(0, minY - pad)
    maxX = Math.min(width - 1, maxX + pad)
    maxY = Math.min(height - 1, maxY + pad)

    const trimW = maxX - minX + 1
    const trimH = maxY - minY + 1
    const out = document.createElement('canvas')
    out.width = trimW
    out.height = trimH
    out.getContext('2d').drawImage(canvas, minX, minY, trimW, trimH, 0, 0, trimW, trimH)

    let src
    try {
      src = out.toDataURL('image/webp', 0.92)
    } catch {
      src = out.toDataURL('image/png')
    }

    return { src, trimW, trimH, padX: minX, padY: minY, fullW: width, fullH: height }
  }

  async function eraseImageBackground(id) {
    const e = model(id)
    if (!e || e.type !== 'image' || removingBg) return

    removingBg = true
    buildToolbar()
    positionToolbar()
    flashSave('Loading better remover… first time can take a minute', 5000)

    let unsub = () => {}
    let input = null
    try {
      const rembg = await import('rembg-webgpu')
      unsub = rembg.subscribeToProgress(({ phase, progress }) => {
        if (phase === 'downloading') flashSave(`Downloading model… ${Math.round(progress)}%`, 2000)
        else if (phase === 'building') flashSave(`Preparing model… ${Math.round(progress)}%`, 2000)
        else if (phase === 'ready') flashSave('Cutting sticker…', 2000)
      })
      input = await srcToObjectUrl(e.src)
      const result = await rembg.removeBackground(input.url)
      const raw = await blobToDataUrl(await fetch(result.blobUrl).then((r) => r.blob()))

      URL.revokeObjectURL(result.blobUrl)
      if (result.previewUrl) URL.revokeObjectURL(result.previewUrl)

      const trimmed = await trimToSticker(raw)

      // Shrink the on-canvas box to the subject bounds (sticker-shaped)
      const scaleX = e.w / trimmed.fullW
      const scaleY = e.h / trimmed.fullH
      e.x += trimmed.padX * scaleX
      e.y += trimmed.padY * scaleY
      e.w = Math.max(24, trimmed.trimW * scaleX)
      e.h = Math.max(24, trimmed.trimH * scaleY)
      e.src = trimmed.src
      e.sticker = true

      render(e)
      scheduleSave()
      flashSave('Sticker ready')
    } catch (err) {
      console.error(err)
      flashSave('Couldn’t erase background', 3200)
    } finally {
      unsub()
      if (input?.revoke) URL.revokeObjectURL(input.url)
      removingBg = false
      if (isSelected(id)) {
        buildToolbar()
        positionToolbar()
      }
    }
  }

  function positionToolbar() {
    if (!selectedIds.length || elToolbar.style.display === 'none') return
    const bounds = selectionBounds()
    if (!bounds) return
    const left = bounds.x * scale - viewport.scrollLeft + viewport.getBoundingClientRect().left
    const topWorld = bounds.y * scale - viewport.scrollTop + viewport.getBoundingClientRect().top
    const bottomWorld =
      (bounds.y + bounds.h) * scale - viewport.scrollTop + viewport.getBoundingClientRect().top
    elToolbar.style.left =
      clamp(left + (bounds.w * scale) / 2 - elToolbar.offsetWidth / 2, 8, innerWidth - elToolbar.offsetWidth - 8) +
      'px'
    let top = topWorld - elToolbar.offsetHeight - 10
    if (top < 8) top = bottomWorld + 10
    elToolbar.style.top = top + 'px'
  }

  function createTitle(wx, wy, html = '') {
    const e = {
      id: uid(),
      type: 'title',
      x: Math.max(0, wx),
      y: Math.max(0, wy),
      width: 420,
      html,
      fontSize: 32,
    }
    elements.push(e)
    const node = render(e)
    select(e.id)
    node.querySelector('.content').focus()
    scheduleSave()
    return e
  }

  function createText(wx, wy, html = '', { focus = true } = {}) {
    const e = {
      id: uid(),
      type: 'text',
      x: Math.max(0, wx),
      y: Math.max(0, wy),
      width: 280,
      html,
    }
    elements.push(e)
    const node = render(e)
    select(e.id)
    if (focus) node.querySelector('.content').focus()
    scheduleSave()
    return e
  }

  function createContainer(wx, wy, { column = true, blocks: seed } = {}) {
    if (column !== false) return focusWritingAt(wx, wy)
    const e = {
      id: uid(),
      type: 'container',
      x: Math.max(0, wx),
      y: Math.max(0, wy),
      w: 720,
      h: 140,
      blocks: seed?.length ? seed : [newBlock('p', '')],
    }
    elements.push(e)
    const node = render(e)
    select(e.id)
    fitContainerHeight(e)
    node.querySelector('.block-body')?.focus()
    scheduleSave()
    return e
  }

  function fitContainerHeight(e) {
    if (!e || e.type !== 'container') return
    if (e.column || e.notion) {
      layoutColumnAroundImages(e)
      return
    }
    const node = byId(e.id)
    const root = node?.querySelector('.blocks')
    if (!node || !root) return
    const next = Math.max(120, root.scrollHeight + 36)
    if (Math.abs((e.h || 0) - next) > 2) {
      e.h = next
      node.style.height = next + 'px'
    }
  }

  function maxZ() {
    let m = 0
    for (const el of elements) m = Math.max(m, el.z || 0)
    return m
  }

  function minZ() {
    let m = 0
    for (const el of elements) m = Math.min(m, el.z || 0)
    return m
  }

  function flipImage(id, axis) {
    const e = model(id)
    if (!e || e.type !== 'image') return
    if (axis === 'x') e.flipX = !e.flipX
    else e.flipY = !e.flipY
    render(e)
    scheduleSave()
  }

  function normalizeRot(deg) {
    return ((Number(deg) || 0) % 360 + 360) % 360
  }

  /** Rotate image by delta degrees (usually ±90), keeping its center fixed. */
  function rotateImage(id, delta) {
    const e = model(id)
    if (!e || e.type !== 'image') return
    e.rot = normalizeRot((e.rot || 0) + delta)
    if (!e.rot) delete e.rot
    render(e)
    if (isSelected(id)) buildToolbar()
    scheduleSave()
  }

  function rotateSelected(delta) {
    const images = selectedModels().filter((e) => e.type === 'image')
    if (!images.length) return
    for (const e of images) rotateImage(e.id, delta)
    updateSelectionFrame()
  }

  function bringToFront(id) {
    const e = model(id)
    if (!e) return
    e.z = maxZ() + 1
    render(e)
    scheduleSave()
  }

  function sendToBack(id) {
    const e = model(id)
    if (!e) return
    e.z = minZ() - 1
    render(e)
    scheduleSave()
  }

  function bringForward(id) {
    const e = model(id)
    if (!e) return
    const mine = e.z || 0
    const above = elements
      .filter((el) => el.id !== id && (el.z || 0) > mine)
      .sort((a, b) => (a.z || 0) - (b.z || 0))[0]
    e.z = above ? (above.z || 0) + 1 : mine + 1
    render(e)
    scheduleSave()
  }

  function sendBackward(id) {
    const e = model(id)
    if (!e) return
    const mine = e.z || 0
    const below = elements
      .filter((el) => el.id !== id && (el.z || 0) < mine)
      .sort((a, b) => (b.z || 0) - (a.z || 0))[0]
    e.z = below ? (below.z || 0) - 1 : mine - 1
    render(e)
    scheduleSave()
  }

  function createImage(src, natW, natH, wx, wy, extras = {}) {
    const maxW = extras.maxW ?? 420
    const w = Math.min(natW, maxW)
    const h = (w * natH) / natW
    const e = {
      id: uid(),
      type: 'image',
      x: wx - w / 2,
      y: Math.max(0, wy - h / 2),
      w,
      h,
      src,
      z: maxZ() + 1,
      href: extras.href || null,
      price: extras.price ?? null,
      label: extras.label || null,
    }
    if (!e.href) delete e.href
    if (e.price == null) delete e.price
    if (!e.label) delete e.label
    syncLinkedToCart(e)
    elements.push(e)
    render(e)
    select(e.id)
    updateCartBadge()
    scheduleSave()
    return e
  }

  function createImageFromSrc(src, wx, wy, extras = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        try {
          const natW = img.naturalWidth || img.width || 420
          const natH = img.naturalHeight || img.height || 420
          resolve(createImage(src, natW, natH, wx, wy, extras))
        } catch (err) {
          reject(err)
        }
      }
      img.onerror = () => reject(new Error('Couldn’t load product image'))
      img.src = src
    })
  }

  function loadImageFile(fileOrBlob, wx, wy) {
    const preview = URL.createObjectURL(fileOrBlob)
    const img = new Image()
    img.onload = () => {
      createImage(preview, img.naturalWidth || img.width || 420, img.naturalHeight || img.height || 420, wx, wy)
      persistPastedBlob(preview, fileOrBlob)
    }
    img.onerror = () => {
      URL.revokeObjectURL(preview)
      flashSave('Couldn’t read image', 2800)
    }
    img.src = preview
  }

  function snapshotSelection() {
    if (!selectedIds.length) return []
    const live = liveElements()
    const byLive = new Map(live.map((e) => [e.id, e]))
    return selectedIds
      .map((id) => {
        const e = byLive.get(id)
        if (!e) return null
        try {
          return structuredClone(e)
        } catch {
          return JSON.parse(JSON.stringify(e))
        }
      })
      .filter(Boolean)
  }

  async function srcToBlob(src) {
    if (!src) return null
    if (src.startsWith('blob:') || src.startsWith('data:') || /^https?:/i.test(src)) {
      const res = await fetch(src)
      if (!res.ok) throw new Error('Couldn’t read image')
      return res.blob()
    }
    // Assume data URL-ish or raw
    const res = await fetch(src)
    return res.blob()
  }

  async function imageToPngBlob(src) {
    const blob = await srcToBlob(src)
    if (!blob) return null
    if (blob.type === 'image/png') return blob
    // Normalize to PNG for broad clipboard support
    const url = URL.createObjectURL(blob)
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('Couldn’t decode image'))
        i.src = url
      })
      const c = document.createElement('canvas')
      c.width = img.naturalWidth || img.width
      c.height = img.naturalHeight || img.height
      c.getContext('2d').drawImage(img, 0, 0)
      return await new Promise((resolve) => c.toBlob(resolve, 'image/png'))
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  function safeFilename(name, ext = 'png') {
    const base = String(name || 'image')
      .replace(/[^\w\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
    return `${base || 'image'}.${ext}`
  }

  async function downloadImageElement(e) {
    if (!e?.src) return false
    const blob = await srcToBlob(e.src)
    if (!blob) return false
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = safeFilename(e.label || hostLabel(e.href || '') || e.id, ext)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    return true
  }

  async function downloadSelectedImages() {
    const images = selectedModels().filter((e) => e.type === 'image' && e.src)
    if (!images.length) {
      flashSave('No image selected')
      return
    }
    flashSave(images.length === 1 ? 'Downloading…' : `Downloading ${images.length}…`)
    let ok = 0
    for (const e of images) {
      try {
        if (await downloadImageElement(e)) ok += 1
        // Small gap so browsers don't block multiple downloads
        if (images.length > 1) await new Promise((r) => setTimeout(r, 200))
      } catch (err) {
        console.error(err)
      }
    }
    flashSave(ok ? `Downloaded ${ok}` : 'Couldn’t download', ok ? 1200 : 2800)
  }

  function persistAppClipboard(items) {
    clipboardItems = items || []
    pasteGeneration = 0
    try {
      if (!clipboardItems.length) sessionStorage.removeItem(CLIP_STORE)
      else sessionStorage.setItem(CLIP_STORE, JSON.stringify({ [CLIP_MARK]: 1, elements: clipboardItems }))
    } catch {
      // payload may be too large (big images) — memory clipboard still works this session
    }
  }

  function readAppClipboard() {
    if (clipboardItems.length) return clipboardItems
    try {
      return parseCanvasClipboard(sessionStorage.getItem(CLIP_STORE)) || []
    } catch {
      return []
    }
  }

  async function copySelected() {
    if (!selectedIds.length) return false
    persistAppClipboard(snapshotSelection())
    const payload = JSON.stringify({ [CLIP_MARK]: 1, elements: clipboardItems })
    const images = clipboardItems.filter((e) => e.type === 'image' && e.src)

    try {
      if (images.length >= 1 && navigator.clipboard?.write && window.ClipboardItem) {
        const png = await imageToPngBlob(images[0].src)
        if (png) {
          const data = {
            'image/png': png,
            'text/plain': new Blob([payload], { type: 'text/plain' }),
          }
          await navigator.clipboard.write([new ClipboardItem(data)])
          flashSave(
            images.length > 1
              ? `Copied ${clipboardItems.length} · image ready to paste`
              : 'Copied image'
          )
          return true
        }
      }
      await navigator.clipboard?.writeText?.(payload)
      flashSave(`Copied ${clipboardItems.length}`)
      return true
    } catch (err) {
      console.error(err)
      try {
        await navigator.clipboard?.writeText?.(payload)
        flashSave(`Copied ${clipboardItems.length}`)
        return true
      } catch {
        // memory clipboard still works inside the app
        flashSave(`Copied ${clipboardItems.length}`)
        return true
      }
    }
  }

  async function cutSelected() {
    if (!(await copySelected())) return
    removeSelected()
    flashSave('Cut')
  }

  function pasteClipboard(atX, atY) {
    const items = readAppClipboard()
    if (!items.length) {
      flashSave('Nothing to paste')
      return
    }
    if (viewMode !== 'page' || !currentPageId) {
      flashSave('Open a page to paste')
      return
    }
    persistAppClipboard(items)
    pasteGeneration += 1
    let minX = Infinity
    let minY = Infinity
    for (const e of items) {
      minX = Math.min(minX, e.x)
      minY = Math.min(minY, e.y)
    }
    const pointer = lastPointerWorld
    const baseX = atX != null ? atX : pointer?.x ?? minX + 36 * pasteGeneration
    const baseY = atY != null ? atY : pointer?.y ?? minY + 36 * pasteGeneration
    const dx = baseX - minX
    const dy = baseY - minY
    const newIds = []
    let z = maxZ()
    const groupMap = new Map()
    for (const src of items) {
      let e
      try {
        e = structuredClone(src)
      } catch {
        e = JSON.parse(JSON.stringify(src))
      }
      e.id = uid()
      e.x = src.x + dx
      e.y = Math.max(0, src.y + dy)
      e.z = ++z
      if (src.groupId) {
        if (!groupMap.has(src.groupId)) groupMap.set(src.groupId, gid())
        e.groupId = groupMap.get(src.groupId)
      }
      if (e.type === 'container' && Array.isArray(e.blocks)) {
        e.blocks = e.blocks.map((b) => ({ ...b, id: blockUid() }))
      }
      syncLinkedToCart(e)
      elements.push(e)
      render(e)
      newIds.push(e.id)
    }
    setSelection(newIds)
    updateCartBadge()
    updateEmpty()
    updateWorldSize()
    scheduleSave()
    flashSave(`Pasted ${newIds.length}`)
  }

  function parseCanvasClipboard(text) {
    if (!text || text[0] !== '{') return null
    try {
      const data = JSON.parse(text)
      if (data?.[CLIP_MARK] && Array.isArray(data.elements) && data.elements.length) {
        return data.elements
      }
    } catch {
      // not our payload
    }
    return null
  }

  function clipboardImageFiles(dt) {
    const files = []
    const key = (f) => `${f.name}|${f.size}|${f.lastModified}|${f.type}`
    const seen = new Set()
    const add = (f) => {
      if (!f || !String(f.type || '').startsWith('image/')) return
      const k = key(f)
      if (seen.has(k)) return
      seen.add(k)
      files.push(f)
    }
    if (dt?.files) for (const f of dt.files) add(f)
    // Safari often yields the file only once from DataTransferItem.getAsFile()
    if (dt?.items) {
      for (const it of dt.items) {
        if (!it.type?.startsWith('image/')) continue
        add(it.getAsFile())
      }
    }
    return files
  }

  function clipboardHtmlImageUrls(dt) {
    const html = dt?.getData('text/html') || ''
    if (!html || !html.includes('<img')) return []
    const urls = []
    const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
    let m
    while ((m = re.exec(html))) {
      const src = m[1].trim().replace(/&amp;/g, '&')
      if (src.startsWith('data:image') || /^https?:\/\//i.test(src)) urls.push(src)
    }
    return urls
  }

  function onPaste(ev) {
    const dt = ev.clipboardData
    const text = dt?.getData('text/plain') || ''
    const canvasEls = parseCanvasClipboard(text)
    if (canvasEls?.length) persistAppClipboard(canvasEls)

    const imageFiles = clipboardImageFiles(dt)
    const isAppPayload = Boolean(canvasEls?.length)
    const types = [...(dt?.types || [])]
    const osHasMedia = imageFiles.length > 0 || types.some((t) => t.startsWith('image/') || t === 'Files')

    // In-app copy between pages — only when this paste actually carries our payload.
    if (isAppPayload) {
      ev.preventDefault()
      pasteClipboard(lastPointerWorld.x, lastPointerWorld.y)
      return
    }

    if (viewMode === 'library' && imageFiles.length) {
      ev.preventDefault()
      flashSave('Open a page to paste')
      return
    }

    // Prefer the Notion page only while the caret is actually in a block
    let column = activeDocEdit()
    const flow = activeFlowLine()

    if (imageFiles.length) {
      if (column) {
        ev.preventDefault()
        insertImagesIntoDoc(column.containerId, column.blockId, imageFiles)
        return
      }
      if (flow) {
        ev.preventDefault()
        insertImagesIntoFlow(flow, imageFiles)
        return
      }
      if (document.activeElement?.isContentEditable) return
      ev.preventDefault()
      const { x, y } = lastPointerWorld
      imageFiles.forEach((file, i) => loadImageFile(file, x + i * 28, y + i * 28))
      return
    }

    const htmlImgs = clipboardHtmlImageUrls(dt)
    if (htmlImgs.length && viewMode !== 'library' && !document.activeElement?.isContentEditable) {
      ev.preventDefault()
      const { x, y } = lastPointerWorld
      htmlImgs.forEach((src, i) => {
        if (src.startsWith('data:')) {
          createImageFromSrc(src, x + i * 28, y + i * 28).catch((err) => console.error(err))
        } else {
          importPinnedImage({ src, page: src }).catch((err) => console.error(err))
        }
      })
      return
    }

    const maybeUrl = (ev.clipboardData?.getData('text/plain') || '').trim()
    if (column && maybeUrl && looksLikeUrl(maybeUrl) && looksLikeImageUrl(normalizeUrl(maybeUrl))) {
      ev.preventDefault()
      const url = normalizeUrl(maybeUrl)
      ;(async () => {
        try {
          flashSave('Adding image…', 4000)
          const data = await fetchRemoteImage(url)
          const src = data?.imageDataUrl || data?.image
          if (!src) throw new Error('Couldn’t download that image')
          const e = model(column.containerId)
          ensureContainerBlocks(e)
          const imgBlock = newBlock('image')
          imgBlock.src = src
          const textBlock = newBlock('p', '')
          let idx = e.blocks.findIndex((b) => b.id === column.blockId)
          if (idx < 0) idx = e.blocks.length - 1
          const cur = e.blocks[idx]
          if (cur && cur.kind === 'p' && !stripHtml(cur.html)) {
            e.blocks.splice(idx, 1, imgBlock, textBlock)
          } else {
            e.blocks.splice(idx + 1, 0, imgBlock, textBlock)
          }
          render(e)
          fitContainerHeight(e)
          select(column.containerId)
          scheduleSave()
          focusBlock(column.containerId, textBlock.id)
          flashSave('Image on its own line')
        } catch (err) {
          console.error(err)
          flashSave(err.message || 'Couldn’t add image', 3200)
        }
      })()
      return
    }

    if (flow && maybeUrl && looksLikeUrl(maybeUrl) && looksLikeImageUrl(normalizeUrl(maybeUrl))) {
      ev.preventDefault()
      const url = normalizeUrl(maybeUrl)
      ;(async () => {
        try {
          flashSave('Adding image…', 4000)
          const data = await fetchRemoteImage(url)
          const src = data?.imageDataUrl || data?.image
          if (!src) throw new Error('Couldn’t download that image')
          await insertSrcIntoFlow(flow, src)
          flashSave('Image on its own line')
        } catch (err) {
          console.error(err)
          flashSave(err.message || 'Couldn’t add image', 3200)
        }
      })()
      return
    }

    if (text && parseSpotifyUrl(text.trim())) {
      ev.preventDefault()
      addSpotifyFromUrl(text.trim(), lastPointerWorld.x, lastPointerWorld.y)
      return
    }
    if (text && parseGifUrl(text.trim())) {
      ev.preventDefault()
      addGifFromUrl(text.trim(), lastPointerWorld.x, lastPointerWorld.y)
      return
    }

    if (document.activeElement?.isContentEditable) return

    if (readAppClipboard().length && !osHasMedia && !text.trim() && !types.length) {
      ev.preventDefault()
      pasteClipboard(lastPointerWorld.x, lastPointerWorld.y)
      return
    }

    if (text && looksLikeUrl(text)) {
      ev.preventDefault()
      const url = normalizeUrl(text)
      if (looksLikeImageUrl(url)) {
        importPinnedImage({ src: url, page: url }).catch((err) => console.error(err))
      } else {
        addProductFromUrl(text, lastPointerWorld.x, lastPointerWorld.y)
      }
      return
    }
    if (text && text.trim()) {
      ev.preventDefault()
      const e = createText(lastPointerWorld.x, lastPointerWorld.y)
      const node = byId(e.id).querySelector('.content')
      node.textContent = text
      e.html = node.innerHTML
      scheduleSave()
    }
  }

  function onDragOver(ev) {
    ev.preventDefault()
  }

  function onDrop(ev) {
    ev.preventDefault()
    const files = [...(ev.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
    const hit = document.elementFromPoint(ev.clientX, ev.clientY)
    const overBlock = hit?.closest?.('.block')
    const overDoc = overBlock?.closest?.('.el.container')
    if (overDoc && files.length) {
      const id = overDoc.dataset.id
      const e = model(id)
      if (e) {
        ensureContainerBlocks(e)
        insertImagesIntoDoc(id, overBlock?.dataset?.blockId || e.blocks[e.blocks.length - 1]?.id, files)
        return
      }
    }
    const p = toWorld(ev.clientX, ev.clientY)
    for (const f of files) loadImageFile(f, p.x, p.y)
  }

  function onPointerDown(ev) {
    if (ev.button !== 0 && ev.button !== 1) return
    const target = ev.target
    const elNode = target.closest('.el')
    lastPointerWorld = toWorld(ev.clientX, ev.clientY)

    if (target.classList.contains('sel-scale-handle') && selectedIds.length > 1) {
      const b = selectionBounds()
      if (!b) return
      gesture = {
        kind: 'scale-group',
        sx: ev.clientX,
        sy: ev.clientY,
        ox: b.x,
        oy: b.y,
        startW: b.w,
        startH: b.h,
        origins: captureScaleOrigins(),
      }
      viewport.setPointerCapture(ev.pointerId)
      ev.preventDefault()
      return
    }

    if (cropState) {
      if (target.classList.contains('ch')) {
        gesture = {
          kind: 'crop-resize',
          dir: target.className.split(' ')[1],
          start: { ...cropState.rect },
          sx: ev.clientX,
          sy: ev.clientY,
        }
        viewport.setPointerCapture(ev.pointerId)
        return
      }
      if (target.classList.contains('crop-rect')) {
        gesture = {
          kind: 'crop-move',
          start: { ...cropState.rect },
          sx: ev.clientX,
          sy: ev.clientY,
        }
        viewport.setPointerCapture(ev.pointerId)
        return
      }
      if (!elNode || elNode.dataset.id !== cropState.id) exitCrop(false)
      return
    }

    if (elNode) {
      const id = elNode.dataset.id
      const e = model(id)
      const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey

      if (target.classList.contains('resize-handle')) {
        select(id)
        gesture = {
          kind: 'resize',
          id,
          sx: ev.clientX,
          sy: ev.clientY,
          w0: e.w,
          h0: e.h,
        }
        viewport.setPointerCapture(ev.pointerId)
        return
      }
      if (target.closest('.page-close')) {
        ev.preventDefault()
        ev.stopPropagation()
        closeNotionPage(id)
        return
      }
      if (
        (e.type === 'spotify' && target.closest('iframe, .spotify-frame')) ||
        (e.type === 'gif' && target.closest('iframe, .gif-frame'))
      ) {
        select(id)
        return
      }
      if (target.closest('.block-handle')) {
        // handled by bindBlockRow
        return
      }
      if (target.closest('.block-menu')) return
      if (target.classList.contains('width-handle')) {
        select(id)
        gesture = { kind: 'width', id, sx: ev.clientX, w0: e.width || 280 }
        viewport.setPointerCapture(ev.pointerId)
        return
      }
      if (target.closest('.el-meta')) {
        select(id, { additive })
        return
      }
      // Don't start a drag when clicking an inline hyperlink — open it instead
      const inlineLink = target.closest('a[href]')
      if (inlineLink && (isTextLike(e) || e.type === 'container')) {
        select(id, { additive })
        openExternalLink(inlineLink.getAttribute('href'), ev)
        return
      }

      const onDragBar = Boolean(target.closest('.drag-bar'))
      const onBlockBody = Boolean(target.closest('.block-body'))

      // Already editing a block — leave the caret alone
      if (
        e.type === 'container' &&
        onBlockBody &&
        document.activeElement === target.closest('.block-body') &&
        !onDragBar &&
        !additive
      ) {
        select(id)
        return
      }

      // Already editing text — leave the caret alone
      if (
        isTextLike(e) &&
        target.classList.contains('content') &&
        document.activeElement === target &&
        !onDragBar &&
        !additive
      ) {
        select(id)
        return
      }

      if (additive) {
        select(id, { additive: true })
        if (document.activeElement?.isContentEditable) document.activeElement.blur()
        ev.preventDefault()
        return
      }

      // Keep multi-selection when dragging an already-selected item
      if (!isSelected(id)) select(id)
      else setSelection([...selectedIds.filter((x) => x !== id), id])

      // Clicking inside a block focuses it on tap; only the top bar moves the page
      if (e.type === 'container' && onBlockBody && !onDragBar) {
        const body = target.closest('.block-body')
        select(id)
        body?.focus()
        return
      }

      if (document.activeElement?.isContentEditable) document.activeElement.blur()
      const movingIds = isSelected(id) ? [...selectedIds] : [id]
      gesture = {
        kind: 'move',
        id,
        sx: ev.clientX,
        sy: ev.clientY,
        x0: e.x,
        y0: e.y,
        scrollLeft0: viewport.scrollLeft,
        scrollTop0: viewport.scrollTop,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false,
        editOnTap: !onDragBar && movingIds.length === 1 && isTextLike(e),
        origins: movingIds.map((mid) => {
          const m = model(mid)
          return { id: mid, x: m.x, y: m.y }
        }),
      }
      viewport.setPointerCapture(ev.pointerId)
      ev.preventDefault()
      return
    }

    if (document.activeElement?.isContentEditable) document.activeElement.blur()

    // Shift/⌘-drag on empty space = marquee multi-select
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
      const p = toWorld(ev.clientX, ev.clientY)
      gesture = {
        kind: 'marquee',
        sx: ev.clientX,
        sy: ev.clientY,
        x0: p.x,
        y0: p.y,
        additive: ev.shiftKey || ev.metaKey || ev.ctrlKey,
      }
      marqueeEl.hidden = false
      marqueeEl.style.left = p.x + 'px'
      marqueeEl.style.top = p.y + 'px'
      marqueeEl.style.width = '0px'
      marqueeEl.style.height = '0px'
      viewport.setPointerCapture(ev.pointerId)
      ev.preventDefault()
      return
    }

    // Click empty space → clear selection (notes via Note / Title / double-click)
    deselect()
  }

  let autoScrollRaf = null

  function stopAutoScroll() {
    if (autoScrollRaf != null) {
      cancelAnimationFrame(autoScrollRaf)
      autoScrollRaf = null
    }
  }

  function edgeScrollDelta(clientX, clientY) {
    const vr = viewport.getBoundingClientRect()
    const margin = 80
    const maxStep = 26
    let sx = 0
    let sy = 0
    if (clientY < vr.top + margin) {
      const t = clamp((vr.top + margin - clientY) / margin, 0, 1)
      sy = -maxStep * t * t
    } else if (clientY > vr.bottom - margin) {
      const t = clamp((clientY - (vr.bottom - margin)) / margin, 0, 1)
      sy = maxStep * t * t
    }
    if (clientX < vr.left + margin) {
      const t = clamp((vr.left + margin - clientX) / margin, 0, 1)
      sx = -maxStep * t * t
    } else if (clientX > vr.right - margin) {
      const t = clamp((clientX - (vr.right - margin)) / margin, 0, 1)
      sx = maxStep * t * t
    }
    return { sx, sy }
  }

  function applyMoveGesture(clientX, clientY) {
    if (!gesture || gesture.kind !== 'move') return
    const dx = clientX - gesture.sx
    const dy = clientY - gesture.sy
    const scrollDx = viewport.scrollLeft - (gesture.scrollLeft0 || 0)
    const scrollDy = viewport.scrollTop - (gesture.scrollTop0 || 0)
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(scrollDx) + Math.abs(scrollDy) > 2) {
      gesture.moved = true
    }
    const rawX = gesture.x0 + (dx + scrollDx) / scale
    const rawY = Math.max(0, gesture.y0 + (dy + scrollDy) / scale)
    const snap = magnetizePosition(gesture.id, rawX, rawY, magnetOn)
    const ddx = snap.x - gesture.x0
    const ddy = snap.y - gesture.y0
    const origins = gesture.origins || [{ id: gesture.id, x: gesture.x0, y: gesture.y0 }]
    for (const origin of origins) {
      const m = model(origin.id)
      if (!m) continue
      m.x = origin.x + ddx
      m.y = Math.max(0, origin.y + ddy)
      // Notion writing column: every block shares one fixed left edge
      if (m.type === 'container' && (m.column || m.notion)) m.x = NOTION_X
      render(m)
    }
    updateSelectionFrame()
    positionToolbar()
    updateWorldSize()
  }

  function tickAutoScroll() {
    autoScrollRaf = null
    if (!gesture || gesture.kind !== 'move') return
    const { sx, sy } = edgeScrollDelta(gesture.lastClientX, gesture.lastClientY)
    if (!sx && !sy) return

    if (sy > 0) updateWorldSize()
    const prevLeft = viewport.scrollLeft
    const prevTop = viewport.scrollTop
    viewport.scrollLeft = Math.max(0, prevLeft + sx)
    viewport.scrollTop = Math.max(0, prevTop + sy)

    applyMoveGesture(gesture.lastClientX, gesture.lastClientY)

    // Keep scrolling while the finger stays in the edge zone
    autoScrollRaf = requestAnimationFrame(tickAutoScroll)
  }

  function startAutoScrollIfNeeded() {
    if (!gesture || gesture.kind !== 'move') return
    const { sx, sy } = edgeScrollDelta(gesture.lastClientX, gesture.lastClientY)
    if ((sx || sy) && autoScrollRaf == null) {
      autoScrollRaf = requestAnimationFrame(tickAutoScroll)
    }
  }

  function onPointerMove(ev) {
    lastPointerWorld = toWorld(ev.clientX, ev.clientY)
    if (!gesture) return
    const dx = ev.clientX - gesture.sx
    const dy = ev.clientY - gesture.sy

    if (gesture.kind === 'move') {
      gesture.lastClientX = ev.clientX
      gesture.lastClientY = ev.clientY
      applyMoveGesture(ev.clientX, ev.clientY)
      startAutoScrollIfNeeded()
    } else if (gesture.kind === 'block-reorder') {
      gesture.lastY = ev.clientY
      const root = byId(gesture.containerId)?.querySelector('.blocks')
      if (!root) return
      root.querySelectorAll('.block').forEach((row) => row.classList.remove('drop-before', 'drop-after'))
      const rows = [...root.querySelectorAll('.block')]
      let targetIdx = rows.length - 1
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect()
        const mid = r.top + r.height / 2
        if (ev.clientY < mid) {
          targetIdx = i
          rows[i].classList.add('drop-before')
          break
        }
        if (i === rows.length - 1) {
          rows[i].classList.add('drop-after')
          targetIdx = i
        }
      }
      gesture.dropIndex = targetIdx
      const before = rows[targetIdx]?.classList.contains('drop-before')
      gesture.dropBefore = Boolean(before)
    } else if (gesture.kind === 'scale-group') {
      const dist0 = Math.hypot(gesture.startW, gesture.startH) || 1
      const worldDx = dx / scale
      const worldDy = dy / scale
      const dist1 = Math.hypot(gesture.startW + worldDx, gesture.startH + worldDy)
      const factor = clamp(dist1 / dist0, 0.15, 8)
      applyScaleFromOrigins(gesture.origins, factor, gesture.ox, gesture.oy)
    } else if (gesture.kind === 'marquee') {
      const p = toWorld(ev.clientX, ev.clientY)
      const x = Math.min(gesture.x0, p.x)
      const y = Math.min(gesture.y0, p.y)
      const w = Math.abs(p.x - gesture.x0)
      const h = Math.abs(p.y - gesture.y0)
      marqueeEl.style.left = x + 'px'
      marqueeEl.style.top = y + 'px'
      marqueeEl.style.width = w + 'px'
      marqueeEl.style.height = h + 'px'
      gesture.rect = { x, y, w, h }
    } else if (gesture.kind === 'resize') {
      const e = model(gesture.id)
      if (e.type === 'container') {
        if (e.column || e.notion) {
          e.w = writingColumnWidth()
          e.h = clamp(gesture.h0 + dy / scale, 120, 4000)
        } else {
          e.w = clamp(gesture.w0 + dx / scale, 240, 900)
          e.h = clamp(gesture.h0 + dy / scale, 200, 1600)
        }
      } else {
        const k = Math.max((gesture.w0 + dx / scale) / gesture.w0, 40 / gesture.w0)
        e.w = gesture.w0 * k
        e.h = gesture.h0 * k
      }
      render(e)
      positionToolbar()
      updateWorldSize()
    } else if (gesture.kind === 'width') {
      const e = model(gesture.id)
      e.width = clamp(gesture.w0 + dx / scale, 120, 900)
      render(e)
      positionToolbar()
    } else if (gesture.kind === 'crop-move') {
      const e = model(cropState.id)
      const r = cropState.rect
      const s = gesture.start
      r.x = clamp(s.x + dx / scale, 0, e.w - r.w)
      r.y = clamp(s.y + dy / scale, 0, e.h - r.h)
      renderCropRect()
    } else if (gesture.kind === 'crop-resize') {
      const e = model(cropState.id)
      const s = gesture.start
      const r = cropState.rect
      const d = gesture.dir
      const wdx = dx / scale
      const wdy = dy / scale
      const MIN = 24
      let x = s.x
      let y = s.y
      let w = s.w
      let h = s.h
      if (d.includes('e')) w = clamp(s.w + wdx, MIN, e.w - s.x)
      if (d.includes('s')) h = clamp(s.h + wdy, MIN, e.h - s.y)
      if (d.includes('w')) {
        const nx = clamp(s.x + wdx, 0, s.x + s.w - MIN)
        w = s.w + (s.x - nx)
        x = nx
      }
      if (d.includes('n')) {
        const ny = clamp(s.y + wdy, 0, s.y + s.h - MIN)
        h = s.h + (s.y - ny)
        y = ny
      }
      Object.assign(r, { x, y, w, h })
      renderCropRect()
    }
  }

  function onPointerUp() {
    if (!gesture) return
    const g = gesture
    stopAutoScroll()
    clearGuides()
    if (g.kind === 'block-reorder') {
      const root = byId(g.containerId)?.querySelector('.blocks')
      root?.querySelectorAll('.block').forEach((row) => {
        row.classList.remove('dragging', 'drop-before', 'drop-after')
      })
      if (g.dropIndex != null) {
        let to = g.dropIndex
        if (g.dropBefore === false) to = g.dropIndex + 1
        // Convert to final index in current array before removal
        const e = model(g.containerId)
        if (e) {
          ensureContainerBlocks(e)
          const from = e.blocks.findIndex((b) => b.id === g.blockId)
          if (from >= 0) {
            let insertAt = to
            if (from < insertAt) insertAt -= 1
            insertAt = clamp(insertAt, 0, e.blocks.length - 1)
            if (insertAt !== from) {
              const [item] = e.blocks.splice(from, 1)
              e.blocks.splice(insertAt, 0, item)
              render(e)
              scheduleSave()
            }
          }
        }
      }
      gesture = null
      return
    }
    if (g.kind === 'marquee') {
      marqueeEl.hidden = true
      const rect = g.rect || { x: g.x0, y: g.y0, w: 0, h: 0 }
      const hit = []
      if (rect.w >= 4 || rect.h >= 4) {
        for (const e of elements) {
          const { w, h } = elSize(e)
          const overlap =
            e.x < rect.x + rect.w &&
            e.x + w > rect.x &&
            e.y < rect.y + rect.h &&
            e.y + h > rect.y
          if (overlap) hit.push(e.id)
        }
      }
      if (g.additive && selectedIds.length) {
        const merged = [...selectedIds]
        for (const id of hit) if (!merged.includes(id)) merged.push(id)
        setSelection(merged)
      } else {
        setSelection(hit)
      }
    }
    if (g.kind === 'move' && !g.moved && g.editOnTap) {
      byId(g.id)?.querySelector('.content')?.focus()
    }
    if (
      g.kind === 'resize' ||
      g.kind === 'width' ||
      g.kind === 'crop-move' ||
      g.kind === 'crop-resize' ||
      g.kind === 'scale-group' ||
      (g.kind === 'move' && g.moved)
    ) {
      const col = getWritingColumn()
      if (col) layoutAllWritingColumns()
      reflowAllFlowLines()
      scheduleSave()
    }
    viewport.classList.remove('panning')
    gesture = null
  }

  function onDblClick(ev) {
    const elNode = ev.target.closest('.el')
    if (elNode) {
      const e = model(elNode.dataset.id)
      if (e?.type === 'image' && !cropState) {
        select(e.id)
        enterCrop(e.id)
      }
      return
    }
    if (cropState) return
    // Double-click empty → continue the one invisible writing column
    const p = toWorld(ev.clientX, ev.clientY)
    focusWritingAt(p.x, Math.max(0, p.y))
  }

  function onWheel(ev) {
    // Pinch-zoom only; otherwise let the browser scroll the page
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault()
      const factor = Math.exp(-ev.deltaY * 0.0022)
      zoomAt(ev.clientX, ev.clientY, scale * factor)
    }
  }

  function onScroll() {
    positionToolbar()
  }

  function zoomAt(sx, sy, next) {
    next = clamp(next, 0.5, 2)
    const before = toWorld(sx, sy)
    scale = next
    applyView()
    const vr = viewport.getBoundingClientRect()
    viewport.scrollLeft = before.x * scale - (sx - vr.left)
    viewport.scrollTop = before.y * scale - (sy - vr.top)
    scheduleSave()
  }

  function onZoomIn() {
    zoomAt(innerWidth / 2, innerHeight / 2, scale * 1.15)
  }
  function onZoomOut() {
    zoomAt(innerWidth / 2, innerHeight / 2, scale / 1.15)
  }
  function onZoomReset() {
    zoomAt(innerWidth / 2, innerHeight / 2, 1)
  }

  function enterCrop(id) {
    const e = model(id)
    cropState = { id, rect: { x: e.w * 0.08, y: e.h * 0.08, w: e.w * 0.84, h: e.h * 0.84 } }
    const node = byId(id)
    node.classList.add('cropping')
    const rect = document.createElement('div')
    rect.className = 'crop-rect'
    ;['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'].forEach((d) => {
      const h = document.createElement('div')
      h.className = 'ch ' + d
      rect.appendChild(h)
    })
    node.appendChild(rect)
    renderCropRect()
    buildToolbar()
    positionToolbar()
  }

  function renderCropRect() {
    const node = byId(cropState.id)
    const r = cropState.rect
    const rect = node.querySelector('.crop-rect')
    rect.style.left = r.x + 'px'
    rect.style.top = r.y + 'px'
    rect.style.width = r.w + 'px'
    rect.style.height = r.h + 'px'
  }

  function exitCrop(apply) {
    const id = cropState.id
    const e = model(id)
    const node = byId(id)
    const r = { ...cropState.rect }
    node.querySelector('.crop-rect')?.remove()
    node.classList.remove('cropping')
    cropState = null

    if (apply) {
      const img = node.querySelector('img')
      const kx = img.naturalWidth / e.w
      const ky = img.naturalHeight / e.h
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(r.w * kx))
      c.height = Math.max(1, Math.round(r.h * ky))
      c.getContext('2d').drawImage(img, r.x * kx, r.y * ky, r.w * kx, r.h * ky, 0, 0, c.width, c.height)
      let src
      try {
        src = c.toDataURL('image/webp', 0.9)
      } catch {
        src = c.toDataURL('image/png')
      }
      e.src = src
      e.x += r.x
      e.y += r.y
      e.w = r.w
      e.h = r.h
      render(e)
      scheduleSave()
    }
    buildToolbar()
    positionToolbar()
  }

  function onKeyDown(ev) {
    const editing = document.activeElement?.isContentEditable
    const mod = ev.metaKey || ev.ctrlKey

    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault()
      if (ev.shiftKey) redo()
      else undo()
      return
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault()
      redo()
      return
    }

    if (mod && ev.key.toLowerCase() === 'a' && !editing) {
      ev.preventDefault()
      setSelection(elements.map((e) => e.id))
      return
    }

    if (mod && ev.key.toLowerCase() === 'c' && !editing && selectedIds.length) {
      ev.preventDefault()
      copySelected()
      return
    }
    if (mod && ev.key.toLowerCase() === 'x' && !editing && selectedIds.length) {
      ev.preventDefault()
      cutSelected()
      return
    }
    if (mod && ev.key.toLowerCase() === 'd' && !editing && selectedIds.length) {
      ev.preventDefault()
      copySelected()
      pasteClipboard(lastPointerWorld.x, lastPointerWorld.y)
      return
    }

    if (mod && (ev.key === '=' || ev.key === '+') && !editing && selectedIds.length > 1) {
      ev.preventDefault()
      nudgeGroupScale(1)
      return
    }
    if (mod && ev.key === '-' && !editing && selectedIds.length > 1) {
      ev.preventDefault()
      nudgeGroupScale(-1)
      return
    }
    if (mod && ev.key.toLowerCase() === 'g' && !editing && selectedIds.length > 1) {
      ev.preventDefault()
      if (ev.shiftKey) ungroupSelected()
      else groupSelected()
      return
    }

    if (ev.key === 'Escape') {
      if (cropState) exitCrop(false)
      else if (cartOpen) setCartOpen(false)
      else if (editing) document.activeElement.blur()
      else deselect()
      return
    }
    if (cropState && ev.key === 'Enter') {
      exitCrop(true)
      return
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !editing && selectedIds.length) {
      ev.preventDefault()
      removeSelected()
      return
    }
    if (!editing && !mod && (ev.key === '[' || ev.key === ']') && selectedIds.length) {
      const images = selectedModels().filter((e) => e.type === 'image')
      if (!images.length) return
      ev.preventDefault()
      rotateSelected(ev.key === '[' ? -90 : 90)
    }
  }

  const resizeObserver = new ResizeObserver(positionToolbar)
  function onWorldInput() {
    requestAnimationFrame(positionToolbar)
  }

  function onResize() {
    applyView()
    positionToolbar()
  }

  function toggleMagnet() {
    magnetOn = !magnetOn
    magnetBtn.classList.toggle('on', magnetOn)
    if (!magnetOn) clearGuides()
  }

  function bind() {
    document.addEventListener('paste', onPaste)
    viewport.addEventListener('dragover', onDragOver)
    viewport.addEventListener('drop', onDrop)
    viewport.addEventListener('pointerdown', onPointerDown)
    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerup', onPointerUp)
    viewport.addEventListener('dblclick', onDblClick)
    viewport.addEventListener('wheel', onWheel, { passive: false })
    viewport.addEventListener('scroll', onScroll, { passive: true })
    document.getElementById('zoomIn').addEventListener('click', onZoomIn)
    document.getElementById('zoomOut').addEventListener('click', onZoomOut)
    zoomLabel.addEventListener('click', onZoomReset)
    undoBtn.addEventListener('click', undo)
    redoBtn.addEventListener('click', redo)
    noteBtn.addEventListener('click', addNoteAtView)
    titleBtn.addEventListener('click', addTitleAtView)
    homeBtn?.addEventListener('click', goHome)
    addPageBtn?.addEventListener('click', createLibraryPage)
    pageTitleInput?.addEventListener('input', onPageTitleInput)
    linkBtn.addEventListener('click', addProductAtView)
    containerBtn?.addEventListener('click', addContainerAtView)
    organizeBtn.addEventListener('click', organizeBoard)
    magnetBtn.addEventListener('click', toggleMagnet)
    cartBtn.addEventListener('click', toggleCart)
    cartClose.addEventListener('click', closeCart)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onDocPointerDown, true)
    resizeObserver.observe(document.body)
    world.addEventListener('input', onWorldInput)
    addEventListener('resize', onResize)
    addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilitySave)
  }

  function onPageHide() {
    persist()
  }

  function onVisibilitySave() {
    if (document.hidden) persist()
  }

  function onDocPointerDown(ev) {
    const menu = document.getElementById('blockMenu')
    if (menu && !menu.contains(ev.target)) closeBlockMenu()
  }

  function unbind() {
    document.removeEventListener('paste', onPaste)
    viewport.removeEventListener('dragover', onDragOver)
    viewport.removeEventListener('drop', onDrop)
    viewport.removeEventListener('pointerdown', onPointerDown)
    viewport.removeEventListener('pointermove', onPointerMove)
    viewport.removeEventListener('pointerup', onPointerUp)
    viewport.removeEventListener('dblclick', onDblClick)
    viewport.removeEventListener('wheel', onWheel)
    viewport.removeEventListener('scroll', onScroll)
    document.getElementById('zoomIn').removeEventListener('click', onZoomIn)
    document.getElementById('zoomOut').removeEventListener('click', onZoomOut)
    zoomLabel.removeEventListener('click', onZoomReset)
    undoBtn.removeEventListener('click', undo)
    redoBtn.removeEventListener('click', redo)
    noteBtn.removeEventListener('click', addNoteAtView)
    titleBtn.removeEventListener('click', addTitleAtView)
    homeBtn?.removeEventListener('click', goHome)
    addPageBtn?.removeEventListener('click', createLibraryPage)
    pageTitleInput?.removeEventListener('input', onPageTitleInput)
    linkBtn.removeEventListener('click', addProductAtView)
    containerBtn?.removeEventListener('click', addContainerAtView)
    organizeBtn.removeEventListener('click', organizeBoard)
    magnetBtn.removeEventListener('click', toggleMagnet)
    cartBtn.removeEventListener('click', toggleCart)
    cartClose.removeEventListener('click', closeCart)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    resizeObserver.disconnect()
    world.removeEventListener('input', onWorldInput)
    removeEventListener('resize', onResize)
    removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibilitySave)
  }

  function reset() {
    disposed = true
    hydrated = false
    clearTimeout(saveTimer)
    stopAutoScroll()
    unbind()
    clearWorld()
    scale = 1
    viewport.scrollTop = 0
    applyView()
    updateEmpty()
  }

  async function importPinnedImage({ src, page, title } = {}) {
    const imageUrl = String(src || '').trim()
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
      flashSave('That pin link is missing a public image URL', 3200)
      return null
    }
    if (viewMode !== 'page') createLibraryPage()
    const x = lastPointerWorld?.x ?? 48 + viewport.scrollLeft / scale + 220
    const y = lastPointerWorld?.y ?? 90 + viewport.scrollTop / scale + 180
    const pageUrl = page ? normalizeUrl(page) : null
    const extras = { href: pageUrl || null, label: title || null, maxW: 780 }
    try {
      const e = await createImageFromSrc(imageUrl, x, y, extras)
      fetchRemoteImage(imageUrl)
        .then((data) => {
          const next = data?.image || data?.imageDataUrl
          if (next && next !== e.src) {
            e.src = next
            byId(e.id)?.classList.remove('loading')
            render(e)
            scheduleSave()
          }
        })
        .catch((err) => console.error(err))
      flashSave('Pasted')
      if (pageUrl) enrichElementFromLink(e.id, { quietFail: true, priceOnly: true }).catch(() => {})
      return e
    } catch (err) {
      console.error(err)
      flashSave(err.message || 'Couldn’t pin image', 3200)
      return null
    }
  }

  // Avoid double-boot when auth fires INITIAL_SESSION then SIGNED_IN
  async function boot() {
    if (booted || disposed) return
    booted = true
    bind()
    await load()
  }

  const ready = boot()

  return {
    reset,
    ready,
    importPinnedImage: async (pin) => {
      await ready
      if (disposed) return null
      return importPinnedImage(pin)
    },
  }
}
