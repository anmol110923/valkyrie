const $ = (id) => document.getElementById(id)
const api = window.valkyrie
let prefs = {}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

let toastTimer
function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 1800)
}

// ---------- generic preference controls ----------

async function setPref(key, value) {
  try {
    prefs = { ...prefs, ...(await api.setPref(key, value)) }
    toast('Saved')
  } catch (err) {
    toast(`Couldn't save: ${err.message}`)
  }
  renderPrefs()
}

function renderPrefs() {
  document.querySelectorAll('[data-pref]').forEach((c) => {
    const v = prefs[c.dataset.pref]
    if (c.type === 'checkbox') c.checked = !!v
    else c.value = String(v)
  })
  document.querySelectorAll('.theme').forEach((b) => b.classList.toggle('on', b.dataset.theme === prefs.theme))
}

document.querySelectorAll('[data-pref]').forEach((c) => {
  c.addEventListener('change', () => {
    const v = c.type === 'checkbox' ? c.checked : c.hasAttribute('data-number') ? Number(c.value) : c.value
    setPref(c.dataset.pref, v)
  })
})
document.querySelectorAll('.theme').forEach((b) => b.addEventListener('click', () => setPref('theme', b.dataset.theme)))

// ---------- default browser ----------

async function loadInfo() {
  const info = await api.info()
  $('default-status').textContent = info.isDefault
    ? '✓ Valkyrie is your default browser.'
    : 'Links from other apps currently open in another browser.'
  $('make-default').hidden = info.isDefault
  $('history-count').textContent = `${info.history.toLocaleString()} pages in history · ${info.bookmarks.toLocaleString()} bookmarks · ${info.extensions} extensions`
}

$('make-default').addEventListener('click', async () => {
  const r = await api.makeDefault()
  const note = $('default-note')
  note.hidden = false
  if (!r.ok && r.reason === 'dev') {
    note.textContent = 'You are running Valkyrie from source. Install the app (or run “npm run dist”), open it, then click this button there.'
    return
  }
  note.textContent = 'Your system will ask you to confirm. Choose Valkyrie. To open PDFs here too: right-click a PDF in Finder → Get Info → Open with: Valkyrie → Change All.'
  setTimeout(loadInfo, 1500)
})

// ---------- spaces ----------

function renderSpaces() {
  const colors = prefs.colors || []
  $('space-list').replaceChildren(...(prefs.spaces || []).map((s) => {
    const li = el('li', 'space-item')
    const icon = el('span', `icon c-${s.color}`, s.icon)
    const name = el('input', 'text')
    name.value = s.name
    name.setAttribute('aria-label', 'Space name')
    name.addEventListener('change', async () => { await api.updateSpace(s.id, { name: name.value }); toast('Saved'); loadPrefs() })
    const sw = el('div', 'colors')
    for (const c of colors) {
      const b = el('button', `c-${c}` + (c === s.color ? ' on' : ''))
      b.title = c
      b.setAttribute('aria-label', `${c} colour`)
      b.addEventListener('click', async () => { await api.updateSpace(s.id, { color: c }); loadPrefs() })
      sw.append(b)
    }
    const del = el('button', 'ghost small', 'Delete')
    del.disabled = prefs.spaces.length <= 1
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the “${s.name}” space? Its pinned tabs are removed; open tabs move to another space.`)) return
      await api.deleteSpace(s.id)
      loadPrefs()
    })
    li.append(icon, name, sw, del)
    return li
  }))
}
$('add-space').addEventListener('click', async () => {
  await api.addSpace(`Space ${(prefs.spaces?.length || 0) + 1}`)
  await loadPrefs()
  $('space-list').lastElementChild?.querySelector('input')?.select()
})

// ---------- archive ----------

async function loadArchive() {
  const items = await api.archive()
  $('archive-empty').hidden = items.length > 0
  $('archive').replaceChildren(...items.slice(0, 100).map((it) => {
    const li = el('li')
    const t = el('div', 't')
    t.append(el('b', null, it.title || it.url), el('small', null, `${new URL(it.url).host} · ${it.space || ''}`))
    const when = el('span', 'when', new Date(it.archivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
    const open = el('button', 'small', 'Reopen')
    open.addEventListener('click', () => api.openUrl(it.url))
    li.append(t, when, open)
    return li
  }))
}
$('clear-archive').addEventListener('click', async () => { await api.clearArchive(); loadArchive() })

// ---------- wellbeing tracking switch ----------

async function loadTracking() {
  const s = await api.settings()
  $('tracking').checked = s.enabled
}
$('tracking').addEventListener('change', async (e) => { await api.setEnabled(e.target.checked); toast(e.target.checked ? 'Tracking on' : 'Tracking paused') })

// ---------- clear data ----------

$('clear-data').addEventListener('click', async () => {
  const what = {}
  document.querySelectorAll('#privacy .checks input').forEach((c) => { what[c.value] = c.checked })
  if (!Object.values(what).some(Boolean)) return
  const parts = Object.entries(what).filter(([, v]) => v).map(([k]) => ({ history: 'history', cache: 'cached files', cookies: 'cookies and site data' })[k])
  if (!confirm(`Permanently clear ${parts.join(', ')}? This can't be undone.`)) return
  await api.clearData(what)
  toast('Cleared')
  loadInfo()
})

// ---------- import ----------

let browsers = []
function fillProfiles() {
  const b = browsers.find((x) => x.id === $('browser').value)
  $('profile').replaceChildren(...(b?.profiles || []).map((p) => new Option(p.name, p.dir)))
}
async function loadBrowsers() {
  browsers = await api.importBrowsers()
  $('no-browsers').hidden = browsers.length > 0
  $('run-import').disabled = browsers.length === 0
  $('browser').replaceChildren(...browsers.map((b) => new Option(b.name, b.id)))
  fillProfiles()
}
$('browser').addEventListener('change', fillProfiles)
$('run-import').addEventListener('click', async () => {
  const what = {}
  document.querySelectorAll('#import .checks input').forEach((c) => { what[c.value] = c.checked })
  if (!Object.values(what).some(Boolean)) return
  const btn = $('run-import')
  btn.disabled = true
  $('import-status').textContent = what.passwords || what.cookies ? 'Importing… allow Keychain access if asked.' : 'Importing…'
  $('import-result').hidden = true
  try {
    const r = await api.runImport({ browser: $('browser').value, profile: $('profile').value, what })
    const lines = []
    const add = (n, label) => { if (n !== undefined) lines.push(['ok', `${n.toLocaleString()} ${label}`]) }
    add(r.bookmarks, 'bookmarks')
    add(r.history, 'history entries')
    add(r.passwords, 'passwords')
    add(r.cookies, 'cookies (you should stay signed in to most sites)')
    add(r.extensions, 'extensions installed')
    for (const e of r.errors || []) lines.push(['err', e])
    $('import-result').replaceChildren(...lines.map(([cls, text]) => el('li', cls, text)))
    $('import-result').hidden = false
    $('import-status').textContent = `Done importing from ${r.browser}.`
  } catch (err) {
    $('import-status').textContent = `Import failed: ${err.message}`
  } finally {
    btn.disabled = false
    loadInfo()
    loadPasswords()
  }
})

// ---------- passwords ----------

let passwords = []
function renderPasswords() {
  const q = $('pw-search').value.trim().toLowerCase()
  const rows = passwords.filter((p) => !q || p.origin.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
  $('pw-count').textContent = passwords.length ? `(${passwords.length})` : ''
  $('pw-empty').hidden = rows.length > 0
  $('pw-list').replaceChildren(...rows.slice(0, 500).map((p) => {
    const tr = el('tr')
    const site = el('td')
    const a = el('a', null, new URL(p.origin).host)
    a.href = p.origin
    site.append(a)
    const secret = el('td', 'secret', '••••••••')
    const btns = el('td', 'btns')
    const reveal = el('button', 'small', 'Show')
    reveal.addEventListener('click', async () => {
      if (reveal.textContent === 'Hide') { secret.textContent = '••••••••'; reveal.textContent = 'Show'; return }
      secret.textContent = (await api.revealPassword(p.id)) ?? '(unavailable)'
      reveal.textContent = 'Hide'
    })
    const del = el('button', 'small danger', 'Delete')
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the saved password for ${p.username || 'this login'} on ${new URL(p.origin).host}?`)) return
      await api.deletePassword(p.id)
      loadPasswords()
    })
    btns.append(reveal, del)
    tr.append(site, el('td', null, p.username || '—'), secret, btns)
    return tr
  }))
}
async function loadPasswords() { passwords = await api.passwords(); renderPasswords() }
$('pw-search').addEventListener('input', renderPasswords)

// ---------- shortcuts ----------

const SHORTCUTS = [
  ['⌘K', 'Command bar: search tabs, bookmarks, history and commands'],
  ['⌘T / ⌘W / ⇧⌘T', 'New tab / close tab / reopen closed tab'],
  ['⌘L', 'Focus the URL bar'],
  ['⌘S', 'Collapse or show the sidebar'],
  ['⇧⌘L', 'Toggle light / dark mode'],
  ['⌘D / ⇧⌘D', 'Bookmark page / pin tab'],
  ['⇧⌘C', 'Copy the current URL'],
  ['⌃⇧= / ⌃⇧-', 'Split view with previous tab / exit split view'],
  ['⌃1 – ⌃9, ⌃⌥← / →', 'Switch spaces'],
  ['⌘1 – ⌘9, ⌃Tab', 'Switch tabs'],
  ['⌘Y', 'Wellbeing dashboard'],
  ['⌘,', 'Settings'],
  ['⌘O', 'Open a file (PDF, HTML…)'],
  ['⌘[ / ⌘]', 'Back / forward'],
  ['⌘= / ⌘- / ⌘0', 'Zoom in / out / reset'],
  ['⌥⌘I', 'Developer tools'],
]
$('keys').replaceChildren(...SHORTCUTS.map(([k, d]) => {
  const tr = el('tr')
  const kc = el('td')
  k.split(' / ').forEach((part, i) => { if (i) kc.append(' / '); kc.append(el('kbd', null, part)) })
  tr.append(kc, el('td', null, d))
  return tr
}))

// ---------- about ----------

document.querySelectorAll('[data-ext]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); api.openUrl(a.href) }))
$('data-folder').addEventListener('click', () => api.openDataFolder())

// ---------- nav highlight ----------

const links = [...document.querySelectorAll('.side a')]
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('current', a.getAttribute('href') === `#${e.target.id}`))
}, { rootMargin: '-20% 0px -70% 0px' })
document.querySelectorAll('main section').forEach((s) => io.observe(s))

// ---------- init ----------

async function loadPrefs() {
  prefs = await api.prefs()
  $('engines').replaceChildren(...Object.entries(prefs.engines).map(([k, name]) => new Option(name, k)))
  $('version').textContent = prefs.version
  $('engine').textContent = `Chromium ${prefs.chrome} · Electron ${prefs.electron}`
  renderPrefs()
  renderSpaces()
}

if (!api) {
  document.body.textContent = 'Settings are only available inside Valkyrie.'
} else {
  if (!/Mac/.test(navigator.platform)) $('ctrl-note').hidden = false
  loadPrefs()
  loadInfo()
  loadArchive()
  loadTracking()
  loadBrowsers()
  loadPasswords()
  if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView(), 100)
}
