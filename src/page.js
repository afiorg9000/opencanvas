import { loadCanvas, saveCanvas, fetchProduct, fetchRemoteImage } from './db.js'

/**
 * Notion-like page: one vertical column of blocks you type into and rearrange.
 * Migrates older free-canvas boards into an ordered block list on first load.
 */
export function startPage(_user) {
  const viewport = document.getElementById('viewport')
  const page = document.getElementById('page')
  const emptyState = document.getElementById('empty')
  const saveDot = document.getElementById('saveDot')
  const undoBtn = document.getElementById('undoBtn')
  const redoBtn = document.getElementById('redoBtn')
  const linkBtn = document.getElementById('linkBtn')
  const cartBtn = document.getElementById('cartBtn')
  const cartClose = document.getElementById('cartClose')
  const cartBadge = document.getElementById('cartBadge')
  const cartPanel = document.getElementById('cartPanel')
  const cartBody = document.getElementById('cartBody')

  let blocks = []
  let nextId = 1
  let saveTimer = null
  let disposed = false
  let hydrated = false
  let cartOpen = false
  let gesture = null
  const undoStack = []
  const redoStack = []
  const HISTORY = 40

  const uid = () => 'b' + nextId++
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

  function newBlock(type = 'paragraph', extras = {}) {
    return {
      id: uid(),
      type,
      html: extras.html || '',
      src: extras.src || null,
      href: extras.href || null,
      price: extras.price ?? null,
      label: extras.label || null,
      cartStatus: extras.cartStatus || null,
    }
  }

  function stripHtml(html) {
    const d = document.createElement('div')
    d.innerHTML = html || ''
    return (d.textContent || '').trim()
  }

  function normalizeUrl(raw) {
    let t = String(raw || '').trim()
    if (!t) return ''
    const md = t.match(/\((https?:\/\/[^)\s]+)\)/i)
    if (md) t = md[1]
    const found = t.match(/https?:\/\/[^\s<>"']+/i) || t.match(/\bwww\.[^\s<>"']+/i)
    if (found) t = found[0]
    t = t.replace(/[),.;]+$/g, '')
    if (!/^https?:\/\//i.test(t)) t = 'https://' + t
    try {
      return new URL(t).toString()
    } catch {
      return ''
    }
  }

  function looksLikeUrl(raw) {
    const t = String(raw || '').trim()
    return /^https?:\/\//i.test(t) || /^www\./i.test(t)
  }

  function formatMoney(n) {
    if (n == null || n === '') return ''
    const num = Number(n)
    if (!Number.isFinite(num)) return String(n)
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num)
  }

  function flashSave(text, ms = 1200) {
    saveDot.textContent = text
    saveDot.classList.add('show')
    setTimeout(() => saveDot.classList.remove('show'), ms)
  }

  function updateEmpty() {
    const hasContent = blocks.some((b) => {
      if (b.type === 'image') return Boolean(b.src)
      if (b.type === 'divider') return true
      return Boolean(stripHtml(b.html))
    })
    emptyState?.classList.toggle('hidden', hasContent || document.activeElement?.closest?.('#page'))
  }

  function syncFromDom() {
    for (const row of page.querySelectorAll('.nb')) {
      const id = row.dataset.id
      const b = blocks.find((x) => x.id === id)
      if (!b || b.type === 'image' || b.type === 'divider') continue
      const body = row.querySelector('.nb-body')
      if (body) b.html = body.innerHTML
    }
  }

  function snapshot() {
    syncFromDom()
    return JSON.stringify({ blocks, nextId })
  }

  function pushHistory() {
    if (disposed) return
    const snap = snapshot()
    if (undoStack[undoStack.length - 1] === snap) return
    undoStack.push(snap)
    while (undoStack.length > HISTORY) undoStack.shift()
    redoStack.length = 0
    undoBtn.disabled = undoStack.length < 2
    redoBtn.disabled = true
  }

  function restore(snap) {
    const data = JSON.parse(snap)
    blocks = data.blocks || []
    nextId = data.nextId || blocks.length + 1
    renderAll()
    scheduleSave({ soft: true })
  }

  function undo() {
    if (undoStack.length < 2) return
    const cur = undoStack.pop()
    redoStack.push(cur)
    restore(undoStack[undoStack.length - 1])
    redoBtn.disabled = false
    undoBtn.disabled = undoStack.length < 2
    flashSave('Undo')
  }

  function redo() {
    if (!redoStack.length) return
    const snap = redoStack.pop()
    undoStack.push(snap)
    restore(snap)
    undoBtn.disabled = undoStack.length < 2
    redoBtn.disabled = !redoStack.length
    flashSave('Redo')
  }

  function scheduleSave({ soft = false } = {}) {
    if (disposed || !hydrated) return
    clearTimeout(saveTimer)
    if (!soft) pushHistory()
    saveTimer = setTimeout(persist, 700)
    updateEmpty()
    updateCartBadge()
  }

  async function persist() {
    if (disposed || !hydrated) return
    try {
      syncFromDom()
      await saveCanvas({
        mode: 'page',
        blocks,
        nextId,
        elements: [],
      })
      flashSave('Saved')
    } catch (err) {
      console.error(err)
      flashSave(err.message || 'Couldn’t save', 4000)
    }
  }

  function migrateFromElements(elements) {
    const sorted = [...(elements || [])].sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))
    const out = []
    for (const e of sorted) {
      if (e.type === 'image' && e.src) {
        out.push(
          newBlock('image', {
            src: e.src,
            href: e.href,
            price: e.price,
            label: e.label,
            cartStatus: e.cartStatus,
          })
        )
      } else if (e.type === 'title') {
        out.push(newBlock('heading', { html: e.html || '' }))
      } else if (e.type === 'text') {
        out.push(newBlock('paragraph', { html: e.html || '' }))
      } else if (e.type === 'container') {
        const inner = Array.isArray(e.blocks) ? e.blocks : []
        if (!inner.length && e.html) {
          out.push(newBlock('paragraph', { html: e.html }))
        }
        for (const b of inner) {
          if (b.kind === 'image' && b.src) out.push(newBlock('image', { src: b.src }))
          else if (b.kind === 'h1') out.push(newBlock('heading', { html: b.html || '' }))
          else if (b.kind === 'bullet') out.push(newBlock('bullet', { html: b.html || '' }))
          else if (b.kind === 'number') out.push(newBlock('number', { html: b.html || '' }))
          else if (b.kind === 'divider') out.push(newBlock('divider'))
          else out.push(newBlock('paragraph', { html: b.html || '' }))
        }
      }
    }
    return out.length ? out : [newBlock('paragraph')]
  }

  function closeSlash() {
    document.getElementById('slashMenu')?.remove()
  }

  function openSlash(blockId, anchor) {
    closeSlash()
    const menu = document.createElement('div')
    menu.id = 'slashMenu'
    menu.className = 'slash-menu'
    const items = [
      { type: 'paragraph', label: 'Text', hint: 'Plain text' },
      { type: 'heading', label: 'Heading', hint: 'Big section title' },
      { type: 'bullet', label: 'Bulleted list', hint: '• List' },
      { type: 'number', label: 'Numbered list', hint: '1. List' },
      { type: 'divider', label: 'Divider', hint: 'Visual break' },
    ]
    for (const it of items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.innerHTML = `<strong>${it.label}</strong><span>${it.hint}</span>`
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        setType(blockId, it.type)
        closeSlash()
      })
      menu.appendChild(btn)
    }
    document.body.appendChild(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = Math.min(r.left, innerWidth - 260) + 'px'
    menu.style.top = Math.min(r.bottom + 6, innerHeight - 280) + 'px'
  }

  function setType(blockId, type) {
    const b = blocks.find((x) => x.id === blockId)
    if (!b) return
    syncFromDom()
    if (type === 'divider') {
      b.type = 'divider'
      b.html = ''
    } else {
      b.type = type
      const plain = stripHtml(b.html)
      if (plain === '/' || /^\/\w*$/i.test(plain)) b.html = ''
    }
    renderAll()
    scheduleSave()
    if (type !== 'divider') focusBlock(blockId)
  }

  function focusBlock(blockId, atEnd = true) {
    requestAnimationFrame(() => {
      const body = page.querySelector(`.nb[data-id="${blockId}"] .nb-body`)
      if (!body) return
      body.focus()
      if (!atEnd) return
      const range = document.createRange()
      range.selectNodeContents(body)
      range.collapse(false)
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    })
  }

  function indexOf(id) {
    return blocks.findIndex((b) => b.id === id)
  }

  function insertAfter(blockId, type = 'paragraph', extras = {}) {
    syncFromDom()
    const nb = newBlock(type, extras)
    // Preserve shop fields on image extras
    if (type === 'image') {
      if (extras.href) nb.href = extras.href
      if (extras.price != null) nb.price = extras.price
      if (extras.label) nb.label = extras.label
      if (extras.cartStatus) nb.cartStatus = extras.cartStatus
      if (extras.src) nb.src = extras.src
    }
    const i = indexOf(blockId)
    blocks.splice(i < 0 ? blocks.length : i + 1, 0, nb)
    renderAll()
    scheduleSave()
    if (type !== 'image' && type !== 'divider') focusBlock(nb.id)
    return nb
  }

  function removeBlock(blockId) {
    syncFromDom()
    const i = indexOf(blockId)
    if (i < 0) return
    if (blocks.length === 1) {
      blocks[0] = newBlock('paragraph')
      renderAll()
      scheduleSave()
      focusBlock(blocks[0].id)
      return
    }
    blocks.splice(i, 1)
    renderAll()
    scheduleSave()
    const prev = blocks[Math.max(0, i - 1)]
    if (prev.type === 'image' || prev.type === 'divider') {
      const next = blocks[Math.min(blocks.length - 1, i)] || prev
      if (next.type !== 'image' && next.type !== 'divider') focusBlock(next.id)
    } else focusBlock(prev.id)
  }

  function placeholder(type) {
    if (type === 'heading') return 'Heading'
    if (type === 'bullet' || type === 'number') return 'List item'
    return 'Type ‘/’ for commands'
  }

  function fileToSrc(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const MAX = 1600
          let { width: w, height: h } = img
          if (Math.max(w, h) > MAX) {
            const k = MAX / Math.max(w, h)
            w = Math.round(w * k)
            h = Math.round(h * k)
          }
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          try {
            resolve(c.toDataURL('image/webp', 0.87))
          } catch {
            resolve(c.toDataURL('image/png'))
          }
        }
        img.onerror = reject
        img.src = reader.result
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function insertImages(afterId, files) {
    let after = afterId
    let focusId = null
    for (const file of files) {
      if (!file) continue
      try {
        const src = await fileToSrc(file)
        const img = insertAfter(after, 'image', { src })
        const text = insertAfter(img.id, 'paragraph')
        after = text.id
        focusId = text.id
      } catch (err) {
        console.error(err)
      }
    }
    if (focusId) focusBlock(focusId)
    flashSave('Image added')
  }

  function bindRow(row, b) {
    const handle = row.querySelector('.nb-handle')
    handle?.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      closeSlash()
      gesture = {
        kind: 'reorder',
        id: b.id,
        startY: ev.clientY,
      }
      row.classList.add('dragging')
      page.setPointerCapture(ev.pointerId)
    })

    const body = row.querySelector('.nb-body')
    if (!body) return

    body.addEventListener('input', () => {
      b.html = body.innerHTML
      const plain = stripHtml(b.html)
      if (plain === '/' || /^\/[a-z]*$/i.test(plain)) openSlash(b.id, row)
      else closeSlash()
      scheduleSave({ soft: true })
      updateEmpty()
    })

    body.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        b.html = body.innerHTML
        const nextType = b.type === 'bullet' || b.type === 'number' ? b.type : 'paragraph'
        if ((b.type === 'bullet' || b.type === 'number') && !stripHtml(b.html)) {
          b.type = 'paragraph'
          b.html = ''
          renderAll()
          scheduleSave()
          focusBlock(b.id)
          return
        }
        insertAfter(b.id, nextType)
        return
      }
      if (ev.key === 'Backspace') {
        const plain = stripHtml(body.innerHTML)
        const sel = getSelection()
        const atStart = sel?.isCollapsed && sel.anchorOffset === 0
        if (atStart && !plain) {
          ev.preventDefault()
          const i = indexOf(b.id)
          const prev = i > 0 ? blocks[i - 1] : null
          if (prev && (prev.type === 'image' || prev.type === 'divider')) {
            blocks.splice(i - 1, 1)
            renderAll()
            scheduleSave()
            focusBlock(b.id)
            return
          }
          removeBlock(b.id)
        }
      }
      if (ev.key === 'Escape') closeSlash()
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === '/') {
        ev.preventDefault()
        openSlash(b.id, row)
      }
    })
  }

  function renderAll() {
    const active = document.activeElement?.closest?.('.nb')?.dataset?.id
    page.innerHTML = ''
    if (!blocks.length) blocks = [newBlock('paragraph')]

    blocks.forEach((b, i) => {
      if (b.type === 'number') {
        /* counter via CSS */
      }
      const row = document.createElement('div')
      row.className = 'nb'
      row.dataset.id = b.id
      row.dataset.type = b.type

      const handle = document.createElement('button')
      handle.type = 'button'
      handle.className = 'nb-handle'
      handle.title = 'Drag to reorder'
      handle.tabIndex = -1
      handle.textContent = '⋮⋮'

      const plus = document.createElement('button')
      plus.type = 'button'
      plus.className = 'nb-plus'
      plus.title = 'Add block'
      plus.tabIndex = -1
      plus.textContent = '+'
      plus.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        insertAfter(b.id, 'paragraph')
      })

      const controls = document.createElement('div')
      controls.className = 'nb-controls'
      controls.append(plus, handle)

      if (b.type === 'divider') {
        const line = document.createElement('div')
        line.className = 'nb-divider'
        row.append(controls, line)
      } else if (b.type === 'image') {
        const media = document.createElement('div')
        media.className = 'nb-image'
        const img = document.createElement('img')
        img.draggable = false
        if (b.src) img.src = b.src
        media.appendChild(img)
        if (b.href || b.price != null) {
          const meta = document.createElement('div')
          meta.className = 'nb-image-meta'
          if (b.href) {
            const a = document.createElement('a')
            a.href = b.href
            a.target = '_blank'
            a.rel = 'noopener'
            a.textContent = b.label || 'Open link'
            a.addEventListener('click', (ev) => {
              ev.preventDefault()
              window.open(b.href, '_blank', 'noopener')
            })
            meta.appendChild(a)
          }
          if (b.price != null) {
            const p = document.createElement('span')
            p.textContent = formatMoney(b.price)
            meta.appendChild(p)
          }
          media.appendChild(meta)
        }
        row.append(controls, media)
      } else {
        const body = document.createElement('div')
        body.className = 'nb-body'
        body.contentEditable = 'true'
        body.spellcheck = true
        body.dataset.placeholder = placeholder(b.type)
        body.innerHTML = b.html || ''
        row.append(controls, body)
      }

      page.appendChild(row)
      bindRow(row, b)
    })

    if (active) focusBlock(active)
    updateEmpty()
    updateCartBadge()
  }

  function shoppable() {
    return blocks.filter((b) => b.type === 'image' && b.href)
  }

  function updateCartBadge() {
    const n = blocks.filter((b) => b.cartStatus === 'cart' || (b.href && b.cartStatus !== 'later')).length
    if (!cartBadge) return
    cartBadge.hidden = n === 0
    cartBadge.textContent = String(n)
  }

  function renderCart() {
    if (!cartBody) return
    cartBody.innerHTML = ''
    const items = blocks.filter((b) => b.type === 'image' && (b.cartStatus === 'cart' || (b.href && !b.cartStatus)))
    const later = blocks.filter((b) => b.cartStatus === 'later')

    const section = (title, list, emptyMsg) => {
      const wrap = document.createElement('section')
      const h = document.createElement('div')
      h.className = 'cart-section-title'
      h.textContent = title
      wrap.appendChild(h)
      if (!list.length) {
        const empty = document.createElement('div')
        empty.className = 'cart-empty'
        empty.textContent = emptyMsg
        wrap.appendChild(empty)
      } else {
        for (const b of list) {
          const row = document.createElement('div')
          row.className = 'cart-row'
          const name = document.createElement('div')
          name.className = 'cart-row-name'
          name.textContent = b.label || stripHtml(b.html) || 'Item'
          const price = document.createElement('div')
          price.className = 'cart-row-price'
          price.textContent = b.price != null ? formatMoney(b.price) : '—'
          row.append(name, price)
          wrap.appendChild(row)
        }
        if (title === 'Cart') {
          const total = list.reduce((s, b) => s + (Number(b.price) || 0), 0)
          const t = document.createElement('div')
          t.className = 'cart-total'
          t.innerHTML = `<span>Total</span><span>${formatMoney(total)}</span>`
          wrap.appendChild(t)
        }
      }
      cartBody.appendChild(wrap)
    }

    section('Cart', items, 'Paste a product link into the page to add items.')
    section('Saved for later', later, 'Nothing saved for later.')
  }

  function setCartOpen(open) {
    cartOpen = open
    cartPanel.hidden = !open
    if (open) renderCart()
  }

  async function addProductLink() {
    const raw = prompt('Product link', 'https://')
    if (raw == null || !String(raw).trim()) return
    const url = normalizeUrl(raw)
    if (!url) {
      flashSave('Need a full https:// link')
      return
    }
    flashSave('Fetching product…', 5000)
    try {
      const data = await fetchProduct(url)
      const src = data.imageDataUrl || data.image
      syncFromDom()
      const last = blocks[blocks.length - 1]
      let after = last?.id
      if (last && last.type === 'paragraph' && !stripHtml(last.html)) {
        // replace empty trailing paragraph
      } else {
        after = last.id
      }
      if (src) {
        const img = newBlock('image', {
          src,
          href: url,
          price: data.price ?? null,
          label: data.title || null,
          cartStatus: 'cart',
        })
        if (last && last.type === 'paragraph' && !stripHtml(last.html)) {
          const i = blocks.length - 1
          blocks.splice(i, 1, img, newBlock('paragraph'))
        } else {
          blocks.push(img, newBlock('paragraph'))
        }
        renderAll()
        scheduleSave()
        focusBlock(blocks[blocks.length - 1].id)
        flashSave(data.price != null ? `Added · ${formatMoney(data.price)}` : 'Added')
        setCartOpen(true)
      } else {
        const p = newBlock('paragraph', {
          html: `<a href="${url}">${data.title || url}</a>`,
        })
        p.href = url
        p.price = data.price ?? null
        blocks.push(p)
        renderAll()
        scheduleSave()
        flashSave('Link added (no image)')
      }
    } catch (err) {
      console.error(err)
      flashSave(err.message || 'Couldn’t fetch product', 3200)
    }
  }

  function onPointerMove(ev) {
    if (!gesture || gesture.kind !== 'reorder') return
    page.querySelectorAll('.nb').forEach((n) => n.classList.remove('drop-before', 'drop-after'))
    const rows = [...page.querySelectorAll('.nb')]
    let idx = rows.length - 1
    let before = false
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (ev.clientY < r.top + r.height / 2) {
        idx = i
        before = true
        rows[i].classList.add('drop-before')
        break
      }
      if (i === rows.length - 1) {
        rows[i].classList.add('drop-after')
        idx = i
        before = false
      }
    }
    gesture.dropIndex = idx
    gesture.dropBefore = before
  }

  function onPointerUp() {
    if (!gesture) return
    const g = gesture
    page.querySelectorAll('.nb').forEach((n) =>
      n.classList.remove('dragging', 'drop-before', 'drop-after')
    )
    if (g.kind === 'reorder' && g.dropIndex != null) {
      syncFromDom()
      const from = indexOf(g.id)
      if (from >= 0) {
        let insertAt = g.dropBefore ? g.dropIndex : g.dropIndex + 1
        const [item] = blocks.splice(from, 1)
        if (from < insertAt) insertAt -= 1
        insertAt = clamp(insertAt, 0, blocks.length)
        blocks.splice(insertAt, 0, item)
        renderAll()
        scheduleSave()
      }
    }
    gesture = null
  }

  function onPaste(ev) {
    const items = [...(ev.clipboardData?.items || [])]
    const images = items.filter((it) => it.type.startsWith('image/'))
    const row = document.activeElement?.closest?.('.nb')
    const blockId = row?.dataset?.id || blocks[blocks.length - 1]?.id

    if (images.length) {
      ev.preventDefault()
      insertImages(
        blockId,
        images.map((it) => it.getAsFile()).filter(Boolean)
      )
      return
    }

    if (document.activeElement?.isContentEditable) {
      // allow normal text paste into block
      const text = ev.clipboardData?.getData('text/plain') || ''
      if (text && looksLikeUrl(text) && blockId) {
        const url = normalizeUrl(text)
        // product-ish URLs: fetch as product; otherwise let default paste
        if (/\/product|\/p\/|shop|store|amazon|etsy|nordstrom|zara|asos/i.test(url)) {
          ev.preventDefault()
          ;(async () => {
            flashSave('Fetching product…', 5000)
            try {
              const data = await fetchProduct(url)
              const src = data.imageDataUrl || data.image
              syncFromDom()
              if (src) {
                const b = blocks.find((x) => x.id === blockId)
                if (b && b.type === 'paragraph' && !stripHtml(b.html)) {
                  const i = indexOf(blockId)
                  blocks.splice(
                    i,
                    1,
                    newBlock('image', {
                      src,
                      href: url,
                      price: data.price,
                      label: data.title,
                      cartStatus: 'cart',
                    }),
                    newBlock('paragraph')
                  )
                } else {
                  insertAfter(blockId, 'image', {
                    src,
                    href: url,
                    price: data.price,
                    label: data.title,
                    cartStatus: 'cart',
                  })
                  insertAfter(blocks[indexOf(blockId) + 1]?.id || blockId, 'paragraph')
                }
                renderAll()
                scheduleSave()
                focusBlock(blocks[blocks.length - 1].id)
                setCartOpen(true)
                flashSave('Added under this line')
              }
            } catch (err) {
              flashSave(err.message || 'Couldn’t fetch', 3200)
            }
          })()
        }
      }
      return
    }

    const text = ev.clipboardData?.getData('text/plain') || ''
    if (text && looksLikeUrl(text)) {
      ev.preventDefault()
      addProductLink()
    }
  }

  function onKeyDown(ev) {
    const mod = ev.metaKey || ev.ctrlKey
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault()
      if (ev.shiftKey) redo()
      else undo()
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault()
      redo()
    }
  }

  function onDocPointerDown(ev) {
    const menu = document.getElementById('slashMenu')
    if (menu && !menu.contains(ev.target)) closeSlash()
  }

  function onPageClick(ev) {
    if (ev.target !== page) return
    const last = blocks[blocks.length - 1]
    if (last && last.type === 'paragraph') focusBlock(last.id)
    else {
      const nb = newBlock('paragraph')
      blocks.push(nb)
      renderAll()
      scheduleSave()
      focusBlock(nb.id)
    }
  }

  async function importPinnedImage({ src, page: pageUrl, title } = {}) {
    try {
      flashSave('Adding pin…', 5000)
      const data = await fetchRemoteImage(src)
      const imageSrc = data?.imageDataUrl || data?.image
      if (!imageSrc) throw new Error('Couldn’t download that image')
      const last = blocks[blocks.length - 1]
      const after =
        last && last.type === 'paragraph' && !stripHtml(last.html) ? last.id : last?.id
      if (last && last.type === 'paragraph' && !stripHtml(last.html)) {
        const i = blocks.length - 1
        blocks.splice(
          i,
          1,
          newBlock('image', {
            src: imageSrc,
            href: pageUrl || null,
            label: title || null,
            cartStatus: pageUrl ? 'cart' : null,
          }),
          newBlock('paragraph')
        )
        renderAll()
      } else {
        insertAfter(after, 'image', {
          src: imageSrc,
          href: pageUrl || null,
          label: title || null,
          cartStatus: pageUrl ? 'cart' : null,
        })
        insertAfter(blocks[blocks.length - 1].id, 'paragraph')
      }
      scheduleSave()
      focusBlock(blocks[blocks.length - 1].id)
      flashSave('Pinned')
    } catch (err) {
      flashSave(err.message || 'Couldn’t pin', 3200)
    }
  }

  async function load() {
    hydrated = false
    try {
      const d = await loadCanvas()
      if (d.mode === 'page' && Array.isArray(d.blocks) && d.blocks.length) {
        blocks = d.blocks.map((b) => ({
          ...newBlock(b.type || 'paragraph'),
          ...b,
          id: b.id || uid(),
        }))
        nextId = d.nextId || blocks.length + 1
      } else if (Array.isArray(d.elements) && d.elements.length) {
        blocks = migrateFromElements(d.elements)
        flashSave('Moved your board into a page', 2400)
      } else if (Array.isArray(d.blocks) && d.blocks.length) {
        blocks = d.blocks
        nextId = d.nextId || blocks.length + 1
      } else {
        blocks = [newBlock('paragraph')]
      }
      for (const b of blocks) {
        const n = Number(String(b.id).replace(/\D/g, ''))
        if (n >= nextId) nextId = n + 1
      }
      hydrated = true
      renderAll()
      pushHistory()
      scheduleSave({ soft: true })
      requestAnimationFrame(() => {
        const first = blocks.find((b) => b.type !== 'image' && b.type !== 'divider') || blocks[0]
        if (first && !stripHtml(first.html) && first.type !== 'image') focusBlock(first.id)
      })
    } catch (err) {
      console.error(err)
      blocks = [newBlock('paragraph')]
      hydrated = true
      renderAll()
      flashSave('Couldn’t load — starting a blank page', 4000)
    }
  }

  function bind() {
    undoBtn?.addEventListener('click', undo)
    redoBtn?.addEventListener('click', redo)
    linkBtn?.addEventListener('click', addProductLink)
    cartBtn?.addEventListener('click', () => setCartOpen(!cartOpen))
    cartClose?.addEventListener('click', () => setCartOpen(false))
    document.addEventListener('paste', onPaste)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onDocPointerDown, true)
    page.addEventListener('pointermove', onPointerMove)
    page.addEventListener('pointerup', onPointerUp)
    page.addEventListener('click', onPageClick)
    page.addEventListener('dragover', (ev) => ev.preventDefault())
    page.addEventListener('drop', (ev) => {
      ev.preventDefault()
      const files = [...(ev.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.nb')
      insertImages(row?.dataset?.id || blocks[blocks.length - 1]?.id, files)
    })
  }

  function unbind() {
    undoBtn?.removeEventListener('click', undo)
    redoBtn?.removeEventListener('click', redo)
    linkBtn?.removeEventListener('click', addProductLink)
    cartBtn?.removeEventListener('click', () => setCartOpen(!cartOpen))
    cartClose?.removeEventListener('click', () => setCartOpen(false))
    document.removeEventListener('paste', onPaste)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('pointerdown', onDocPointerDown, true)
  }

  function reset() {
    disposed = true
    hydrated = false
    clearTimeout(saveTimer)
    unbind()
    closeSlash()
    page.innerHTML = ''
    blocks = []
  }

  bind()
  const ready = load()

  return {
    reset,
    ready,
    importPinnedImage: async (pin) => {
      await ready
      if (disposed) return
      return importPinnedImage(pin)
    },
  }
}
