import { api, clearSession, getSession, hasRemoteApi, isLocalSession, setSession } from './api.js'
import { localLogin } from './local-backend.js'

const gate = document.getElementById('authGate')
const shell = document.getElementById('appShell')
const form = document.getElementById('authForm')
const emailInput = document.getElementById('emailInput')
const codeInput = document.getElementById('codeInput')
const submitBtn = document.getElementById('authSubmit')
const msg = document.getElementById('authMsg')
const accountEmail = document.getElementById('accountEmail')
const signOutBtn = document.getElementById('signOutBtn')

let readyEmail = null
let onReadyCb = null
let onSignedOutCb = null

function setMsg(text, kind = '') {
  msg.textContent = text
  msg.className = 'auth-msg' + (kind ? ` ${kind}` : '')
}

function showGate() {
  gate.hidden = false
  shell.hidden = true
}

function showApp(email) {
  gate.hidden = true
  shell.hidden = false
  accountEmail.textContent = email
}

function handleSession(user) {
  if (!user?.email) {
    readyEmail = null
    clearSession()
    showGate()
    onSignedOutCb?.()
    return
  }
  showApp(user.email)
  if (readyEmail === user.email) return
  readyEmail = user.email
  queueMicrotask(() => onReadyCb?.(user))
}

/**
 * Email + personal code against the local SQLite API.
 * First login creates the account; later logins need the same code.
 */
export async function startAuth({ onReady, onSignedOut }) {
  onReadyCb = onReady
  onSignedOutCb = onSignedOut

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const email = emailInput.value.trim().toLowerCase()
    const code = codeInput.value
    if (!email || !code) return

    submitBtn.disabled = true
    setMsg('Signing you in…')
    try {
      const data = (await hasRemoteApi())
        ? await api('/api/login', {
            method: 'POST',
            body: { email, code },
          })
        : await localLogin(email, code)
      setSession({ token: data.token, email: data.email })
      setMsg('')
      handleSession({ email: data.email })
    } catch (err) {
      setMsg(err.message || 'Could not sign in.', 'error')
    } finally {
      submitBtn.disabled = false
    }
  })

  signOutBtn.addEventListener('click', async () => {
    const session = getSession()
    try {
      if (session?.token && !isLocalSession(session) && (await hasRemoteApi())) {
        await api('/api/logout', { method: 'POST', token: session.token })
      }
    } catch {
      /* ignore */
    }
    handleSession(null)
    codeInput.value = ''
    setMsg('')
    emailInput.focus()
  })

  const existing = getSession()
  if (existing) {
    try {
      if ((await hasRemoteApi()) && !isLocalSession(existing)) {
        const me = await api('/api/me', { token: existing.token })
        handleSession({ email: me.email })
        return
      }
      if (!existing.email) throw new Error('Not signed in.')
      handleSession({ email: existing.email })
      return
    } catch {
      clearSession()
    }
  }

  showGate()
  emailInput.focus()
}
