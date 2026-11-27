const $ = (id) => document.getElementById(id)
const api = window.valkyrie

// ---------- default browser ----------

async function loadInfo() {
  const info = await api.info()
  $('default-status').textContent = info.isDefault
    ? '✓ Valkyrie is your default browser. Links from other apps open here.'
    : 'Links from other apps (Mail, Slack, Finder…) currently open in another browser.'
  $('make-default').hidden = info.isDefault
  $('history-count').textContent = `${info.history.toLocaleString()} pages in history · ${info.bookmarks.toLocaleString()} bookmarks · ${info.extensions} extensions`
  return info
}

$('make-default').addEventListener('click', async () => {
  const r = await api.makeDefault()
  const note = $('default-note')
  note.hidden = false
  if (!r.ok && r.reason === 'dev') {
    note.textContent = 'You are running Valkyrie from source (npm start). Build the app with “npm run dist”, open dist/mac-arm64/Valkyrie.app (or move it to Applications), then click this button there.'
    return
  }
  note.textContent = 'macOS will ask you to confirm. Choose “Use Valkyrie”. To open PDFs and HTML files here too: right-click a PDF in Finder → Get Info → Open with: Valkyrie → Change All.'
  setTimeout(loadInfo, 1500)
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
  document.querySelectorAll('.checks input').forEach((c) => { what[c.value] = c.checked })
  if (!Object.values(what).some(Boolean)) return
  const btn = $('run-import')
  btn.disabled = true
  $('import-status').textContent = what.passwords || what.cookies
    ? 'Importing… allow Keychain access if macOS asks.'
    : 'Importing…'
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
    $('import-result').replaceChildren(...lines.map(([cls, text]) => {
      const li = document.createElement('li')
      li.className = cls
      li.textContent = text
      return li
    }))
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
    const tr = document.createElement('tr')
    const site = document.createElement('td')
    const a = document.createElement('a')
    a.href = p.origin
    a.textContent = new URL(p.origin).host
    site.append(a)
    const user = document.createElement('td')
    user.textContent = p.username || '—'
    const secret = document.createElement('td')
    secret.className = 'secret'
    secret.textContent = '••••••••'
    const btns = document.createElement('td')
    btns.className = 'btns'

    const reveal = document.createElement('button')
    reveal.className = 'small'
    reveal.textContent = 'Show'
    reveal.addEventListener('click', async () => {
      if (reveal.textContent === 'Hide') { secret.textContent = '••••••••'; reveal.textContent = 'Show'; return }
      secret.textContent = (await api.revealPassword(p.id)) ?? '(unavailable)'
      reveal.textContent = 'Hide'
    })
    const del = document.createElement('button')
    del.className = 'small danger'
    del.textContent = 'Delete'
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the saved password for ${p.username || 'this login'} on ${new URL(p.origin).host}?`)) return
      await api.deletePassword(p.id)
      loadPasswords()
    })
    btns.append(reveal, del)
    tr.append(site, user, secret, btns)
    return tr
  }))
}

async function loadPasswords() {
  passwords = await api.passwords()
  renderPasswords()
}
$('pw-search').addEventListener('input', renderPasswords)

// ---------- privacy ----------

$('clear-history').addEventListener('click', async () => {
  if (!confirm('Delete all browsing history? This can\'t be undone.')) return
  await api.clearHistory()
  loadInfo()
})

// ---------- init ----------

if (!api) {
  document.body.textContent = 'Settings are only available inside Valkyrie.'
} else {
  loadInfo()
  loadBrowsers()
  loadPasswords()
  if (location.hash === '#import') $('import').scrollIntoView()
}
