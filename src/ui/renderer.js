const $ = (id) => document.getElementById(id)
document.body.classList.add(`platform-${valkyrie.platform}`)

const urlInput = $('url')
const sugEl = $('suggestions')

let state = { tabs: [], pinned: [], favorites: [], spaces: [], spaceId: null, activeId: null, active: null, newTabUrl: '', split: null }
let layout = { collapsed: false, peek: false }
let editing = false
let renaming = null // { kind, id } while an inline rename is open

const ICON = {
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
  sound: '<svg viewBox="0 0 16 16"><path d="M3 6h2.5L9 3v10L5.5 10H3zM11.5 5.5a3.5 3.5 0 0 1 0 5"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M3 6h2.5L9 3v10L5.5 10H3zM11 6l3 4M14 6l-3 4"/></svg>',
}
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function hostLetter(url) {
  try { return new URL(url).hostname.replace(/^www\./, '')[0].toUpperCase() } catch { return '•' }
}

function faviconEl({ loading, favicon, url }) {
  const icon = el('span', 'favicon')
  if (loading) {
    icon.innerHTML = '<span class="spinner"></span>'
  } else if (favicon) {
    const img = document.createElement('img')
    img.src = favicon
    img.onerror = () => { img.remove(); icon.append(el('span', 'letter', hostLetter(url))) }
    icon.append(img)
  } else if (url && url !== state.newTabUrl) {
    icon.append(el('span', 'letter', hostLetter(url)))
  } else {
    icon.innerHTML = '<span class="dot"></span>'
  }
  return icon
}

// ---------- main render ----------

let renderPending = false
let mouseHeld = false
window.addEventListener('mousedown', () => { mouseHeld = true }, true)
const release = () => { mouseHeld = false; if (renderPending) setTimeout(render, 0) }
window.addEventListener('mouseup', release, true)
window.addEventListener('dragend', release, true)
window.addEventListener('blur', release)
function render() {
  // don't rebuild the lists under an open rename box (it would lose what's being typed)
  // ...or while a mouse button is held: replacing the row between mousedown and mouseup
  // would swallow the click (this is what broke the tab close "×" button).
  if (renaming || mouseHeld) { renderPending = true; return }
  renderPending = false
  const a = state.active
  $('back').disabled = !a?.canGoBack
  $('forward').disabled = !a?.canGoForward
  $('reload').classList.toggle('loading', !!a?.loading)
  if (!editing) urlInput.value = !a || a.url === state.newTabUrl ? '' : a.url

  const blocked = a?.blocked || 0
  $('shield').classList.toggle('on', blocked > 0)
  $('shield-count').textContent = blocked > 999 ? '999+' : String(blocked)
  const star = $('star')
  star.hidden = !/^(https?|file):/.test(a?.url || '')
  star.classList.toggle('on', !!a?.bookmarked)
  $('split-exit').hidden = !(state.split && a?.split)
  if (state.activeId) document.querySelector('browser-action-list').setAttribute('tab', String(state.activeId))

  const space = state.spaces.find((s) => s.id === state.spaceId)
  document.documentElement.dataset.color = space?.color || 'violet'
  {
    const sn = $('space-name')
    sn.replaceChildren(el('span', 'glyph', space?.icon || '✦'), document.createTextNode(space?.name || 'Space'))
    sn.dataset.id = space?.id || ''
  }

  renderFavorites()
  $('pinned').replaceChildren(...state.pinned.map(renderNode))
  $('tabs').replaceChildren(...state.tabs.map(renderTab))
  renderSpaces()
  document.title = a ? `${a.title} — Valkyrie` : 'Valkyrie'
}

function renderFavorites() {
  $('favorites').replaceChildren(...state.favorites.map((f, i) => {
    const li = el('li', 'fav')
    const live = f.tab
    li.classList.toggle('live', !!live)
    li.classList.toggle('active', !!live && live.id === state.activeId)
    li.title = f.title
    li.append(faviconEl({ favicon: live?.favicon || f.favicon, url: f.url, loading: live?.loading }))
    if (live?.audible) li.append(el('span', 'sound', '♪'))
    li.addEventListener('click', () => valkyrie.send('open-item', f.id))
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); valkyrie.send(live ? 'tab-menu' : 'item-menu', live ? live.id : f.id) })
    makeDraggable(li, live ? { kind: 'tab', id: live.id } : { kind: 'node', id: f.id })
    makeDropTarget(li, () => ({ zone: 'favorites', index: i }), 'before')
    return li
  }))
}

function tabControls(row, tab) {
  if (tab.audible || tab.muted) {
    const m = el('button', 'mute')
    m.title = tab.muted ? 'Unmute tab' : 'Mute tab'
    m.innerHTML = tab.muted ? ICON.muted : ICON.sound
    m.addEventListener('click', (e) => { e.stopPropagation(); valkyrie.send('toggle-mute', tab.id) })
    row.append(m)
  }
  if (tab.split) row.append(el('span', 'badge split', '◫'))
  const close = el('button', 'close')
  close.setAttribute('aria-label', 'Close tab')
  close.innerHTML = ICON.close
  close.addEventListener('click', (e) => { e.stopPropagation(); valkyrie.send('close-tab', tab.id) })
  row.append(close)
}

function renderTab(t, i) {
  const li = el('li', 'row')
  li.dataset.renameTab = t.id
  li.classList.toggle('active', t.id === state.activeId)
  li.title = `${t.title}\n${t.url === state.newTabUrl ? '' : t.url}`
  li.append(faviconEl(t), el('span', 'title', t.title))
  tabControls(li, t)
  li.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) valkyrie.send('select-tab', t.id) })
  li.addEventListener('auxclick', (e) => { if (e.button === 1) valkyrie.send('close-tab', t.id) })
  li.addEventListener('dblclick', () => openRename({ kind: 'tab', id: t.id }))
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); valkyrie.send('tab-menu', t.id) })
  makeDraggable(li, { kind: 'tab', id: t.id })
  makeDropTarget(li, () => ({ zone: 'today', index: i }), 'before')
  return li
}

function renderNode(node, index, siblings, parentId = null) {
  const li = document.createElement('li')
  const row = el('div', 'row')
  row.dataset.renameNode = node.id
  if (node.type === 'folder') {
    row.classList.add('folder')
    row.classList.toggle('open', node.open !== false)
    row.insertAdjacentHTML('beforeend', ICON.chev)
    const icon = el('span', 'favicon')
    icon.innerHTML = ICON.folder
    row.append(icon, el('span', 'title', node.title))
    row.addEventListener('click', () => {
      const open = !row.classList.contains('open')
      row.classList.toggle('open', open)
      valkyrie.send('toggle-folder', node.id, open)
    })
    const ul = el('ul')
    ul.append(...node.children.map((c, i) => renderNode(c, i, node.children, node.id)))
    li.append(row, ul)
    makeDropTarget(row, () => ({ zone: 'pinned', parentId: node.id, index: -1 }), 'into')
  } else {
    const live = node.tab
    row.classList.toggle('dim', !live)
    row.classList.toggle('active', !!live && live.id === state.activeId)
    row.title = `${node.title}\n${node.url}`
    row.append(faviconEl({ favicon: live?.favicon || node.favicon, url: node.url, loading: live?.loading }), el('span', 'title', live?.title && live.title !== 'New Tab' ? node.title : node.title))
    if (live) tabControls(row, live)
    row.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) valkyrie.send('open-item', node.id) })
    li.append(row)
    makeDropTarget(row, () => ({ zone: 'pinned', parentId, index }), 'before')
  }
  row.addEventListener('dblclick', (e) => { e.stopPropagation(); openRename({ kind: 'node', id: node.id }) })
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); valkyrie.send(node.tab ? 'tab-menu' : 'item-menu', node.tab ? node.tab.id : node.id) })
  makeDraggable(row, node.tab ? { kind: 'tab', id: node.tab.id } : { kind: 'node', id: node.id })
  return li
}

function renderSpaces() {
  const box = $('spaces')
  box.replaceChildren(...state.spaces.map((s) => {
    const b = el('button', 'space' + (s.id === state.spaceId ? ' on' : ''), s.icon)
    b.title = s.name
    b.addEventListener('click', () => valkyrie.send('switch-space', s.id))
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); valkyrie.send('space-menu', s.id) })
    b.addEventListener('dblclick', () => openRename({ kind: 'space', id: s.id }))
    makeDropTarget(b, () => ({ zone: 'space', spaceId: s.id }), 'into')
    return b
  }), (() => {
    const add = el('button', 'space add', '+')
    add.title = 'New space'
    add.addEventListener('click', () => openRename({ kind: 'new-space' }))
    return add
  })())
}

// ---------- drag & drop ----------

let drag = null

function makeDraggable(node, payload) {
  node.draggable = true
  node.addEventListener('dragstart', (e) => {
    drag = payload
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', 'valkyrie')
    node.classList.add('dragging')
    document.body.classList.add('dragging')
  })
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging')
    document.body.classList.remove('dragging')
    document.querySelectorAll('.drop-before, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into'))
    drag = null
  })
}

function makeDropTarget(node, target, style) {
  const cls = style === 'into' ? 'drop-into' : 'drop-before'
  node.addEventListener('dragover', (e) => { if (!drag) return; e.preventDefault(); e.stopPropagation(); node.classList.add(cls) })
  node.addEventListener('dragleave', () => node.classList.remove(cls))
  node.addEventListener('drop', (e) => {
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    node.classList.remove(cls)
    const t = target()
    if (t.zone === 'space') {
      if (drag.kind === 'tab') valkyrie.send('drop', drag, { zone: 'space', spaceId: t.spaceId })
    } else {
      valkyrie.send('drop', drag, t)
    }
  })
}

// container-level drops (end of list / empty zones)
makeDropTarget($('favorites'), () => ({ zone: 'favorites', index: -1 }), 'into')
makeDropTarget($('pinned'), () => ({ zone: 'pinned', index: -1 }), 'into')
makeDropTarget($('pinned-hint'), () => ({ zone: 'pinned', index: -1 }), 'into')
makeDropTarget($('tabs'), () => ({ zone: 'today', index: -1 }), 'into')
makeDropTarget($('new-tab'), () => ({ zone: 'today', index: 0 }), 'into')

// ---------- inline rename ----------

function openRename(target, focus = true) {
  if (renaming) return
  renaming = target
  let host
  let current = ''
  if (target.kind === 'tab') {
    host = document.querySelector(`[data-rename-tab="${target.id}"]`) || document.querySelector(`.row.active[data-rename-node]`)
    current = state.tabs.find((t) => t.id === target.id)?.title || ''
  } else if (target.kind === 'node') {
    host = document.querySelector(`[data-rename-node="${CSS.escape(target.id)}"]`)
    current = findNode(state.pinned, target.id)?.title || state.favorites.find((f) => f.id === target.id)?.title || ''
  } else if (target.kind === 'space') {
    host = $('space-name')
    current = state.spaces.find((s) => s.id === target.id)?.name || ''
  } else if (target.kind === 'new-space') {
    host = $('spaces')
  }
  if (!host) { renaming = null; return }
  if (host.querySelector('.rename')) return
  const input = el('input', 'rename' + (target.kind === 'new-space' ? ' space-input' : ''))
  input.value = current
  input.placeholder = target.kind === 'new-space' ? 'Name your space' : ''
  const title = host.querySelector('.title')
  if (target.kind === 'new-space') host.replaceChildren(input)
  else if (title) title.replaceWith(input)
  else host.replaceChildren(input)
  input.addEventListener('mousedown', (e) => e.stopPropagation())
  input.addEventListener('dblclick', (e) => e.stopPropagation())
  let done = false
  const finish = (commit) => {
    if (done) return
    done = true
    renaming = null
    const value = input.value.trim()
    if (commit && value) {
      if (target.kind === 'new-space') valkyrie.send('new-space', value)
      else valkyrie.send('rename', { kind: target.kind, id: target.id, title: value })
    }
    render()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  if (focus) { input.focus(); input.select() }
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) { const hit = findNode(n.children, id); if (hit) return hit }
  }
  return null
}

// ---------- bookmarks (imported / ⌘D) ----------

const openFolders = new Set(store.get('openFolders', []))

function renderBookmarks(root) {
  const section = $('bookmarks-section')
  section.hidden = !root.children.length
  section.classList.toggle('open', store.get('bookmarksOpen', false))
  $('bookmarks').replaceChildren(...root.children.map(renderBookmarkNode))
}

function renderBookmarkNode(node) {
  const li = document.createElement('li')
  const row = el('div', 'row')
  row.title = node.type === 'url' ? `${node.title}\n${node.url}` : node.title
  if (node.type === 'folder') {
    row.classList.add('folder')
    row.classList.toggle('open', openFolders.has(node.id))
    row.insertAdjacentHTML('beforeend', ICON.chev)
    const icon = el('span', 'favicon')
    icon.innerHTML = ICON.folder
    row.append(icon, el('span', 'title', node.title))
    row.addEventListener('click', () => {
      if (openFolders.has(node.id)) openFolders.delete(node.id)
      else openFolders.add(node.id)
      row.classList.toggle('open')
      store.set('openFolders', [...openFolders])
    })
    const ul = el('ul')
    ul.append(...node.children.map(renderBookmarkNode))
    li.append(row, ul)
  } else {
    row.append(faviconEl({ url: node.url }), el('span', 'title', node.title))
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
    const li = el('li', i === selected ? 'sel' : '')
    const t = el('span', 's-title')
    if (s.type === 'bookmark') t.append(el('span', 'kind', '★'))
    t.append(s.title || s.url)
    li.append(t, el('span', 's-url', s.url.replace(/^https?:\/\/(www\.)?/, '')))
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
urlInput.addEventListener('blur', () => { editing = false; suggestions = []; renderSuggestions(); render(); maybeUnpeek() })
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
    if (!pointerInside && document.activeElement?.tagName !== 'INPUT') valkyrie.send('peek', false)
  }, 350)
}
const pointerIn = () => { pointerInside = true; clearTimeout(unpeekTimer) }
document.documentElement.addEventListener('mouseenter', pointerIn)
document.documentElement.addEventListener('mousemove', pointerIn)
document.documentElement.addEventListener('mouseleave', () => { pointerInside = false; maybeUnpeek() })
$('edge').addEventListener('mouseenter', () => { pointerIn(); valkyrie.send('peek', true) })

// ---------- buttons ----------

$('toggle-sidebar').addEventListener('click', () => valkyrie.send('toggle-sidebar'))
$('back').addEventListener('click', () => valkyrie.send('back'))
$('forward').addEventListener('click', () => valkyrie.send('forward'))
$('reload').addEventListener('click', () => valkyrie.send(state.active?.loading ? 'stop' : 'reload'))
$('star').addEventListener('click', () => valkyrie.send('toggle-bookmark'))
$('new-tab').addEventListener('click', () => valkyrie.send('new-tab'))
$('webstore').addEventListener('click', () => valkyrie.send('open-web-store'))
$('palette').addEventListener('click', () => valkyrie.send('open-palette'))
$('split-exit').addEventListener('click', () => valkyrie.send('unsplit'))
$('wellbeing').addEventListener('click', () => valkyrie.send('open-wellbeing'))
$('settings').addEventListener('click', () => valkyrie.send('open-settings'))
$('new-folder').addEventListener('click', () => valkyrie.send('new-folder'))
$('space-name').addEventListener('click', () => valkyrie.send('space-menu', state.spaceId))
$('space-name').addEventListener('dblclick', () => openRename({ kind: 'space', id: state.spaceId }))
$('clear-today').addEventListener('click', () => { for (const t of state.tabs) if (t.id !== state.activeId) valkyrie.send('close-tab', t.id) })

// ---------- today's screen time ----------

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}
let goalMinutes = 0
async function refreshToday() {
  try {
    const total = (await valkyrie.today()).total
    $('today-total').textContent = fmtDuration(total)
    const goal = goalMinutes * 60
    $('wellbeing').classList.toggle('over', goal > 0 && total > goal)
    $('goal-bar').querySelector('b').style.width = goal > 0 ? `${Math.min(100, (total / goal) * 100)}%` : '0'
    $('wellbeing').title = goal > 0 ? `Today ${fmtDuration(total)} of your ${fmtDuration(goal)} goal (⌘Y)` : 'Wellbeing & activity (⌘Y)'
  } catch {}
}
async function refreshPrefs() {
  try { goalMinutes = (await valkyrie.prefs()).dailyGoalMinutes || 0 } catch {}
  refreshToday()
}
refreshPrefs()
setInterval(refreshToday, 15000)
setInterval(refreshPrefs, 60000)

// ---------- toast ----------

let toastTimer
function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 1600)
}

// ---------- main process events ----------

valkyrie.onState((s) => { state = s; render() })
valkyrie.onLayout((l) => { layout = l; applyLayout(); if (l.peek && !pointerInside) maybeUnpeek() })
valkyrie.onBookmarks(renderBookmarks)
valkyrie.onFocusUrl(() => { urlInput.focus(); urlInput.select() })
valkyrie.onRename((target) => {
  if (layout.collapsed && !layout.peek) valkyrie.send('peek', true)
  setTimeout(() => openRename(target), 30)
})
valkyrie.onToast(toast)
