const $ = (id) => document.getElementById(id)
document.body.classList.add(`platform-${valkyrie.platform}`)
const urlInput = $('url')
const tabsEl = $('tabs')
const sugEl = $('suggestions')

let state = { tabs: [], activeId: null, newTabUrl: '', bookmarked: false }
let layout = { collapsed: false, peek: false }
let editing = false

const ICON_CLOSE = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
const ICON_FOLDER = '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>'

const activeTab = () => state.tabs.find((t) => t.id === state.activeId)
const displayUrl = (url) => (!url || url === state.newTabUrl ? '' : url)
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

// ---------- tabs ----------

function render() {
  const tab = activeTab()
  $('back').disabled = !tab?.canGoBack
  $('forward').disabled = !tab?.canGoForward
  $('reload').classList.toggle('loading', !!tab?.loading)
  if (!editing) urlInput.value = displayUrl(tab?.url)

  const blocked = tab?.blocked || 0
  $('shield').classList.toggle('on', blocked > 0)
  $('shield-count').textContent = blocked > 999 ? '999+' : String(blocked)

  const star = $('star')
  star.hidden = !/^(https?|file):/.test(tab?.url || '')
  star.classList.toggle('on', !!state.bookmarked)
  star.title = state.bookmarked ? 'Remove bookmark (⌘D)' : 'Bookmark this page (⌘D)'

  // extension buttons reflect the active tab
  if (state.activeId) document.querySelector('browser-action-list').setAttribute('tab', String(state.activeId))

  tabsEl.replaceChildren(...state.tabs.map(renderTab))
  document.title = tab ? `${tab.title} — Valkyrie` : 'Valkyrie'
}

function faviconEl({ loading, favicon, letter }) {
  const icon = document.createElement('span')
  icon.className = 'favicon'
  if (loading) {
    icon.innerHTML = '<span class="spinner"></span>'
  } else if (favicon) {
    const img = document.createElement('img')
    img.src = favicon
    img.onerror = () => { icon.innerHTML = '<span class="dot"></span>' }
    icon.append(img)
  } else if (letter) {
    const l = document.createElement('span')
    l.className = 'letter'
    l.textContent = letter
    icon.append(l)
  } else {
    icon.innerHTML = '<span class="dot"></span>'
  }
  return icon
}

function renderTab(t) {
  const li = document.createElement('li')
  li.className = 'tab' + (t.id === state.activeId ? ' active' : '')
  li.draggable = true
  li.title = t.title

  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = t.url === state.newTabUrl ? 'New Tab' : t.title

  const close = document.createElement('button')
  close.className = 'close'
  close.setAttribute('aria-label', 'Close tab')
  close.innerHTML = ICON_CLOSE
  close.addEventListener('click', (e) => { e.stopPropagation(); valkyrie.send('close-tab', t.id) })

  li.append(faviconEl(t), title, close)
  li.addEventListener('mousedown', (e) => { if (e.button === 0) valkyrie.send('select-tab', t.id) })
  li.addEventListener('auxclick', (e) => { if (e.button === 1) valkyrie.send('close-tab', t.id) })

  li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/valkyrie-tab', String(t.id)); li.classList.add('dragging') })
  li.addEventListener('dragend', () => li.classList.remove('dragging'))
  li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop-before') })
  li.addEventListener('dragleave', () => li.classList.remove('drop-before'))
  li.addEventListener('drop', (e) => {
    e.preventDefault()
    li.classList.remove('drop-before')
    const id = Number(e.dataTransfer.getData('text/valkyrie-tab'))
    if (!id || id === t.id) return
    const from = state.tabs.findIndex((x) => x.id === id)
    let to = state.tabs.findIndex((x) => x.id === t.id)
    if (from < to) to -= 1
    valkyrie.send('move-tab', id, to)
  })
  return li
}

// ---------- bookmarks ----------

const openFolders = new Set(store.get('openFolders', []))

function renderBookmarks(root) {
  const section = $('bookmarks-section')
  section.hidden = !root.children.length
  section.classList.toggle('open', store.get('bookmarksOpen', true))
  $('bookmarks').replaceChildren(...root.children.map(renderBookmarkNode))
}

function hostLetter(url) {
  try { return new URL(url).hostname.replace(/^www\./, '')[0].toUpperCase() } catch { return '•' }
}

function renderBookmarkNode(node) {
  const li = document.createElement('li')
  const row = document.createElement('div')
  row.className = 'bm' + (node.type === 'folder' ? ' folder' : '')
  row.title = node.type === 'url' ? `${node.title}\n${node.url}` : node.title
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = node.title

  if (node.type === 'folder') {
    const icon = document.createElement('span')
    icon.className = 'favicon'
    icon.innerHTML = ICON_FOLDER
    row.append(icon, title)
    row.classList.toggle('open', openFolders.has(node.id))
    row.addEventListener('click', () => {
      if (openFolders.has(node.id)) openFolders.delete(node.id)
      else openFolders.add(node.id)
      row.classList.toggle('open')
      store.set('openFolders', [...openFolders])
    })
    const ul = document.createElement('ul')
    ul.append(...node.children.map(renderBookmarkNode))
    li.append(row, ul)
  } else {
    row.append(faviconEl({ letter: hostLetter(node.url) }), title)
    row.addEventListener('click', () => valkyrie.send('open-bookmark', node.url))
    li.append(row)
  }
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); valkyrie.send('bookmark-menu', node.id) })
  return li
}

$('bookmarks-toggle').addEventListener('click', () => {
  const open = !$('bookmarks-section').classList.contains('open')
  $('bookmarks-section').classList.toggle('open', open)
  store.set('bookmarksOpen', open)
})

// ---------- omnibox + suggestions ----------

let suggestions = []
let selected = -1
let sugSeq = 0

function renderSuggestions() {
  sugEl.hidden = !suggestions.length || !editing
  sugEl.replaceChildren(...suggestions.map((s, i) => {
    const li = document.createElement('li')
    li.className = i === selected ? 'sel' : ''
    const t = document.createElement('span')
    t.className = 's-title'
    if (s.type === 'bookmark') {
      const k = document.createElement('span')
      k.className = 'kind'
      k.textContent = '★'
      t.append(k)
    }
    t.append(s.title || s.url)
    const u = document.createElement('span')
    u.className = 's-url'
    u.textContent = s.url.replace(/^https?:\/\/(www\.)?/, '')
    li.append(t, u)
    li.addEventListener('mousedown', (e) => { e.preventDefault(); go(s.url) })
    return li
  }))
}

async function updateSuggestions() {
  const q = urlInput.value.trim()
  const seq = ++sugSeq
  const list = q ? await valkyrie.suggest(q) : []
  if (seq !== sugSeq) return
  suggestions = list
  selected = -1
  renderSuggestions()
}

function go(value) {
  editing = false
  suggestions = []
  renderSuggestions()
  valkyrie.send('navigate', value)
  urlInput.blur()
}

$('omnibox').addEventListener('submit', (e) => {
  e.preventDefault()
  const value = selected >= 0 ? suggestions[selected].url : urlInput.value.trim()
  if (value) go(value)
})

urlInput.addEventListener('focus', () => { editing = true; urlInput.select() })
urlInput.addEventListener('blur', () => {
  editing = false
  suggestions = []
  renderSuggestions()
  render()
  maybeUnpeek()
})
urlInput.addEventListener('input', updateSuggestions)
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { editing = false; render(); urlInput.blur() }
  if (!suggestions.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); selected = (selected + 1) % suggestions.length; renderSuggestions() }
  if (e.key === 'ArrowUp') { e.preventDefault(); selected = selected <= 0 ? suggestions.length - 1 : selected - 1; renderSuggestions() }
})

// ---------- collapse / peek ----------

let unpeekTimer = null
let pointerInside = false

function applyLayout() {
  document.body.classList.toggle('collapsed', layout.collapsed)
  document.body.classList.toggle('peek', layout.peek)
}

function maybeUnpeek() {
  clearTimeout(unpeekTimer)
  if (!layout.collapsed || !layout.peek) return
  unpeekTimer = setTimeout(() => {
    if (!pointerInside && document.activeElement !== urlInput) valkyrie.send('peek', false)
  }, 350)
}

// The UI view is only as wide as the edge strip / floating panel, so leaving
// the document means the pointer went back to the page.
const pointerIn = () => { pointerInside = true; clearTimeout(unpeekTimer) }
document.documentElement.addEventListener('mouseenter', pointerIn)
document.documentElement.addEventListener('mousemove', pointerIn)
document.documentElement.addEventListener('mouseleave', () => { pointerInside = false; maybeUnpeek() })
$('edge').addEventListener('mouseenter', () => { pointerIn(); valkyrie.send('peek', true) })

// ---------- buttons ----------

$('toggle-sidebar').addEventListener('click', () => valkyrie.send('toggle-sidebar'))
$('back').addEventListener('click', () => valkyrie.send('back'))
$('forward').addEventListener('click', () => valkyrie.send('forward'))
$('reload').addEventListener('click', () => valkyrie.send(activeTab()?.loading ? 'stop' : 'reload'))
$('star').addEventListener('click', () => valkyrie.send('toggle-bookmark'))
$('new-tab').addEventListener('click', () => valkyrie.send('new-tab'))
$('webstore').addEventListener('click', () => valkyrie.send('open-web-store'))
$('wellbeing').addEventListener('click', () => valkyrie.send('open-wellbeing'))
$('settings').addEventListener('click', () => valkyrie.send('open-settings'))

// ---------- today's screen time ----------

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}
async function refreshToday() {
  try { $('today-total').textContent = fmtDuration((await valkyrie.today()).total) } catch {}
}
refreshToday()
setInterval(refreshToday, 15000)

// ---------- main process events ----------

valkyrie.onState((s) => { state = s; render() })
valkyrie.onLayout((l) => {
  layout = l
  applyLayout()
  if (l.peek && !pointerInside) maybeUnpeek()
})
valkyrie.onBookmarks(renderBookmarks)
valkyrie.onFocusUrl(() => { urlInput.focus(); urlInput.select() })
