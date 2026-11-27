// Runs in every tab (sandboxed, isolated world).
//  - On built-in valkyrie:// pages it exposes the browser API (wellbeing, settings, import).
//  - On websites it provides password autofill + "save password?" offers.
// The main process re-checks the sender's origin for every call.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'valkyrie:') {
  const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args)
  contextBridge.exposeInMainWorld('valkyrie', {
    // wellbeing
    today: invoke('wb:today'),
    day: invoke('wb:day'),
    range: invoke('wb:range'),
    settings: invoke('wb:settings'),
    setEnabled: invoke('wb:set-enabled'),
    clear: invoke('wb:clear'),
    // settings page
    info: invoke('st:info'),
    makeDefault: invoke('st:make-default'),
    importBrowsers: invoke('imp:browsers'),
    runImport: invoke('imp:run'),
    passwords: invoke('pw:list'),
    revealPassword: invoke('pw:reveal-saved'),
    deletePassword: invoke('pw:delete'),
    clearHistory: invoke('hist:clear'),
  })
} else if (/^https?:$/.test(location.protocol)) {
  setupAutofill()
}

function setupAutofill() {
  let matches = null
  let popup = null
  let target = null

  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  const passwordIn = (scope) => [...scope.querySelectorAll('input[type="password"]')].find(visible)

  function usernameFieldFor(pw) {
    const scope = pw.form || document
    const inputs = [...scope.querySelectorAll('input')]
    for (let i = inputs.indexOf(pw) - 1; i >= 0; i--) {
      const t = (inputs[i].type || 'text').toLowerCase()
      if (['text', 'email', 'tel'].includes(t) && visible(inputs[i])) return inputs[i]
    }
    return scope.querySelector('input[autocomplete="username"], input[type="email"]')
  }

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function hide() {
    popup?.remove()
    popup = null
  }

  async function fill(id, pw) {
    hide()
    const login = await ipcRenderer.invoke('pw:fill', id)
    if (!login) return
    const user = usernameFieldFor(pw)
    if (user && login.username) setValue(user, login.username)
    setValue(pw, login.password)
  }

  function show(field, pw) {
    hide()
    const r = field.getBoundingClientRect()
    popup = document.createElement('div')
    popup.style.cssText = `position:fixed;z-index:2147483647;left:${r.left}px;top:${r.bottom + 4}px;`
    const root = popup.attachShadow({ mode: 'closed' })
    root.innerHTML = `<style>
      .box{font:13px -apple-system,system-ui,sans-serif;background:#211f29;color:#ecebf2;border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.35);padding:6px;min-width:${Math.max(220, r.width)}px;max-width:360px}
      .head{font-size:11px;color:#9b87f5;padding:4px 8px 6px;font-weight:600;letter-spacing:.03em}
      button{all:unset;display:flex;flex-direction:column;width:calc(100% - 16px);padding:7px 8px;border-radius:7px;cursor:pointer}
      button:hover,button:focus{background:rgba(155,135,245,.18)}
      .u{font-weight:600}.o{font-size:11px;color:#8c8a99}</style>
      <div class="box"><div class="head">VALKYRIE · SAVED LOGINS</div></div>`
    const box = root.querySelector('.box')
    for (const m of matches) {
      const b = document.createElement('button')
      const u = document.createElement('span')
      u.className = 'u'
      u.textContent = m.username || '(no username)'
      const o = document.createElement('span')
      o.className = 'o'
      o.textContent = new URL(m.origin).host
      b.append(u, o)
      b.addEventListener('mousedown', (e) => { e.preventDefault(); fill(m.id, pw) })
      box.append(b)
    }
    document.documentElement.append(popup)
  }

  document.addEventListener('focusin', async (e) => {
    const el = e.target
    if (!(el instanceof HTMLInputElement)) return
    const pw = el.type === 'password' ? el : el.form && passwordIn(el.form)
    if (!pw) return
    if (matches === null) matches = await ipcRenderer.invoke('pw:query')
    if (matches.length && document.activeElement === el) { target = el; show(el, pw) }
  }, true)
  document.addEventListener('focusout', () => setTimeout(() => { if (document.activeElement !== target) hide() }, 150), true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() }, true)
  window.addEventListener('scroll', hide, true)

  // ----- offer to save new logins -----
  let lastOffer = ''
  function offer(scope) {
    const pw = passwordIn(scope || document)
    if (!pw || !pw.value) return
    const username = usernameFieldFor(pw)?.value || ''
    const key = username + '\u0000' + pw.value
    if (key === lastOffer) return
    lastOffer = key
    ipcRenderer.send('pw:offer-save', { username, password: pw.value })
  }
  document.addEventListener('submit', (e) => offer(e.target), true)
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('button, input[type="submit"]')
    if (btn) offer(btn.form || btn.closest('form') || document)
  }, true)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') offer(e.target.form || document)
  }, true)
}
