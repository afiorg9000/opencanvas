const PIN_KEY = 'oc-pending-pin'

/**
 * Read ?pin= / ?src= from the URL (bookmarklet handoff), stash for after sign-in,
 * and clean the address bar.
 */
export function capturePinFromLocation() {
  const u = new URL(location.href)
  const src = u.searchParams.get('pin') || u.searchParams.get('src')
  if (!src) return

  const pin = {
    src,
    page: u.searchParams.get('from') || u.searchParams.get('page') || '',
    title: u.searchParams.get('title') || '',
  }

  for (const key of ['pin', 'src', 'from', 'page', 'title']) {
    u.searchParams.delete(key)
  }
  const next = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash
  history.replaceState({}, '', next)

  try {
    sessionStorage.setItem(PIN_KEY, JSON.stringify(pin))
  } catch {
    /* ignore quota / private mode */
  }
}

export function takePendingPin() {
  try {
    const raw = sessionStorage.getItem(PIN_KEY)
    if (!raw) return null
    sessionStorage.removeItem(PIN_KEY)
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Bookmarklet that lets you click an image on any site and open Open Canvas with it. */
export function buildPinBookmarklet(appOrigin = location.origin) {
  const app = String(appOrigin || location.origin).replace(/\/$/, '')
  const code = `(function(){var A=${JSON.stringify(app)};function go(s,p,t){var u=A+"/?pin="+encodeURIComponent(s)+"&from="+encodeURIComponent(p||location.href);if(t)u+="&title="+encodeURIComponent(t);window.open(u,"_blank")}var tip=document.createElement("div");tip.textContent="Click an image to pin to Open Canvas · Esc cancels";tip.setAttribute("style","position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:10px 14px;border-radius:8px;font:14px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)");document.documentElement.appendChild(tip);function cleanup(){tip.remove();document.removeEventListener("click",onClick,true);document.removeEventListener("keydown",onKey,true)}function onKey(e){if(e.key==="Escape"){e.preventDefault();cleanup()}}function onClick(e){var t=e.target;if(!t)return;var img=t.closest&&t.closest("img");var src=null;if(img){src=img.currentSrc||img.src}else{var bg=getComputedStyle(t).backgroundImage||"";var m=bg.match(/url\\(["']?(https?:[^"')]+)["']?\\)/i);if(m)src=m[1]}if(!src)return;e.preventDefault();e.stopPropagation();cleanup();if(/^data:/i.test(src)||/^blob:/i.test(src)){alert("That image isn’t a public URL — try another photo on the page.");return}if(!/^https?:/i.test(src)){alert("Need an http(s) image URL.");return}go(src,location.href,document.title||"")}document.addEventListener("click",onClick,true);document.addEventListener("keydown",onKey,true)})();`
  return `javascript:${code}`
}
