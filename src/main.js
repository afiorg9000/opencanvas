import './style.css'
import { startAuth } from './auth.js'
import { startCanvas } from './canvas.js'
import { buildPinBookmarklet, capturePinFromLocation, takePendingPin } from './pin.js'

capturePinFromLocation()

let canvasSession = null
let starting = false

function setupPinHelp() {
  const openBtn = document.getElementById('pinHelpBtn')
  const dialog = document.getElementById('pinHelp')
  const closeBtn = document.getElementById('pinHelpClose')
  const link = document.getElementById('pinBookmarklet')
  if (!openBtn || !dialog || !link) return

  link.href = buildPinBookmarklet(location.origin)
  link.addEventListener('click', (ev) => ev.preventDefault())

  const open = () => {
    dialog.hidden = false
    closeBtn?.focus()
  }
  const close = () => {
    dialog.hidden = true
  }

  openBtn.addEventListener('click', open)
  closeBtn?.addEventListener('click', close)
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) close()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !dialog.hidden) close()
  })
}

setupPinHelp()

await startAuth({
  onReady: async (user) => {
    if (canvasSession || starting) return
    starting = true
    try {
      canvasSession = startCanvas(user)
      const pin = takePendingPin()
      if (pin) await canvasSession.importPinnedImage(pin)
    } finally {
      starting = false
    }
  },
  onSignedOut: () => {
    canvasSession?.reset()
    canvasSession = null
    starting = false
  },
})
