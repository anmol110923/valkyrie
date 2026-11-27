// Valkyrie — main process.
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const {
  app, BrowserWindow, session, ipcMain, Menu, dialog, protocol, net, powerMonitor, nativeImage, clipboard, nativeTheme, shell,
} = require('electron')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore, installExtension } = require('electron-chrome-web-store')
const { ElectronBlocker } = require('@ghostery/adblocker-electron')

const C = require('./constants')
const { Tracker, dayKey } = require('./tracker')
const { Settings, Bookmarks, History, Spaces, Archive, SEARCH_ENGINES, SPACE_COLORS } = require('./stores')
const { Passwords } = require('./passwords')
const chromeImport = require('./chrome-import')
const { WindowController } = require('./window')

app.setName('Valkyrie')

// Only one Valkyrie process: links opened from other apps go to the running one.
if (!app.requestSingleInstanceLock()) app.exit(0)

// valkyrie:// serves src/pages. crx is re-listed because each call replaces the list.
protocol.registerSchemesAsPrivileged([
  { scheme: 'crx', privileges: { bypassCSP: true } },
  { scheme: 'valkyrie', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Present as plain Chrome so Google sites and the Web Store treat us as a supported browser.
const CHROME_UA = app.userAgentFallback.replace(/\s(Electron|valkyrie|Valkyrie)\/\S+/g, '')
app.userAgentFallback = CHROME_UA

/** @type {WindowController[]} */
const controllers = []
let lastFocused = null
let quitting = false
let ready = false
const pendingOpen = [] // URLs macOS asked us to open before we were ready
const blockedCounts = new Map()

const ctx = {
  ses: null, extensions: null, tracker: null, history: null, bookmarks: null, settings: null, passwords: null,
  spaces: null, archive: null, blocker: null,
  controllers, blockedCounts,
  searchEngine: () => SEARCH_ENGINES[ctx.settings.get('searchEngine')] || SEARCH_ENGINES.google,
  onFocus: (c) => { lastFocused = c },
  onClosed: (c) => {
    const i = controllers.indexOf(c)
    if (i >= 0) controllers.splice(i, 1)
    if (lastFocused === c) lastFocused = null
    if (!quitting) saveSessionSoon()
  },
  saveSessionSoon: () => saveSessionSoon(),
  toURL: (s) => toURL(s),
}
if (process.env.VALKYRIE_DEBUG) global.__valkyrie = { controllers, ctx }

// ---------- helpers ----------

function toURL(input) {
  const s = (input || '').trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|chrome):/i.test(s)) return s
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s
  if (!/\s/.test(s) && /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s
  return ctx.searchEngine().url + encodeURIComponent(s)
}

function current() {
  const focused = BrowserWindow.getFocusedWindow()
  return controllers.find((c) => c.win === focused) || lastFocused || controllers[0] || null
}

function createWindow(opts) {
  return new WindowController(ctx, opts)
}

function currentOrNew() {
  return current() || createWindow()
}

const SESSION_FILE = () => path.join(app.getPath('userData'), 'open-tabs.json')
let saveTimer = null
function saveSessionSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSession, 500)
}
function saveSession() {
  const data = { windows: controllers.map((c) => c.serialize()) }
  try { fs.writeFileSync(SESSION_FILE(), JSON.stringify(data, null, 2)) } catch {}
}
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8')).windows || [] } catch { return [] }
}

// ---------- links & files from macOS / other apps ----------

function openExternal(url) {
  if (!ready) { pendingOpen.push(url); return }
  const c = currentOrNew()
  c.createTab(url)
  if (c.win.isMinimized()) c.win.restore()
  c.win.show()
  c.win.focus()
}

function urlsFromArgv(argv) {
  return argv.slice(1).filter((a) => /^https?:\/\//i.test(a) || (/\.(pdf|html?|svg)$/i.test(a) && fs.existsSync(a)))
    .map((a) => (/^https?:/i.test(a) ? a : pathToFileURL(path.resolve(a)).href))
}

app.on('open-url', (e, url) => { e.preventDefault(); openExternal(url) })
app.on('open-file', (e, file) => { e.preventDefault(); openExternal(pathToFileURL(file).href) })
app.on('second-instance', (_e, argv) => {
  const urls = urlsFromArgv(argv)
  if (urls.length) urls.forEach(openExternal)
  else { const c = currentOrNew(); c.win.show(); c.win.focus() }
})

// ---------- sidebar UI IPC ----------

function fromUI(e) {
  return controllers.find((c) => c.uiWc === e.sender) || null
}

ipcMain.on('ui:new-tab', (e) => fromUI(e)?.createTab())
ipcMain.on('ui:select-tab', (e, id) => fromUI(e)?.selectTab(id))
ipcMain.on('ui:close-tab', (e, id) => fromUI(e)?.closeTab(id))
ipcMain.on('ui:move-tab', (e, id, to) => fromUI(e)?.moveTab(id, to))
ipcMain.on('ui:navigate', (e, input) => fromUI(e)?.navigate(input))
ipcMain.on('ui:back', (e) => fromUI(e)?.activeTab?.view.webContents.navigationHistory.goBack())
ipcMain.on('ui:forward', (e) => fromUI(e)?.activeTab?.view.webContents.navigationHistory.goForward())
ipcMain.on('ui:reload', (e) => fromUI(e)?.activeTab?.view.webContents.reload())
ipcMain.on('ui:stop', (e) => fromUI(e)?.activeTab?.view.webContents.stop())
ipcMain.on('ui:open-web-store', (e) => fromUI(e)?.createTab(C.WEB_STORE_URL))
ipcMain.on('ui:open-wellbeing', (e) => fromUI(e)?.openSingleton(C.WELLBEING_URL))
ipcMain.on('ui:open-settings', (e) => fromUI(e)?.openSingleton(C.SETTINGS_URL))
ipcMain.on('ui:toggle-sidebar', (e) => fromUI(e)?.toggleSidebar())
ipcMain.on('ui:peek', (e, on) => fromUI(e)?.setPeek(!!on))
ipcMain.on('ui:toggle-bookmark', (e) => fromUI(e)?.toggleBookmark())
ipcMain.on('ui:open-bookmark', (e, url) => {
  const c = fromUI(e)
  if (!c || !/^(https?|file|valkyrie):/i.test(url)) return
  const open = c.tabs.find((t) => t.view.webContents.getURL() === url)
  if (open) c.selectTab(open.id)
  else c.createTab(url)
})
ipcMain.on('ui:bookmark-menu', (e, id) => {
  const c = fromUI(e)
  const found = c && [...ctx.bookmarks.walk()].find(({ node }) => node.id === id)?.node
  if (!found) return
  const items = found.type === 'url'
    ? [
        { label: 'Open in New Tab', click: () => c.createTab(found.url) },
        { label: 'Copy Link', click: () => clipboard.writeText(found.url) },
        { type: 'separator' },
        { label: 'Delete Bookmark', click: () => ctx.bookmarks.remove(id) },
      ]
    : [{ label: `Delete Folder “${found.title}”`, click: () => ctx.bookmarks.remove(id) }]
  Menu.buildFromTemplate(items).popup({ window: c.win })
})
// Arc-style organisation: spaces, favorites, pinned folders, split view
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')
ipcMain.on('ui:tab-menu', (e, id) => fromUI(e)?.showTabMenu(id))
ipcMain.on('ui:item-menu', (e, id) => fromUI(e)?.showItemMenu(str(id)))
ipcMain.on('ui:space-menu', (e, id) => fromUI(e)?.showSpaceMenu(str(id)))
ipcMain.on('ui:open-item', (e, id) => fromUI(e)?.openItem(str(id)))
ipcMain.on('ui:switch-space', (e, id) => fromUI(e)?.switchSpace(str(id)))
ipcMain.on('ui:new-space', (e, name) => {
  const c = fromUI(e)
  if (!c) return
  const space = ctx.spaces.createSpace(str(name, 40).trim() || 'New Space')
  c.switchSpace(space.id)
})
ipcMain.on('ui:rename', (e, { kind, id, title } = {}) => {
  const c = fromUI(e)
  if (!c) return
  if (kind === 'tab') c.renameTab(id, str(title, 120))
  if (kind === 'node') ctx.spaces.rename(str(id), str(title, 120))
  if (kind === 'space') ctx.spaces.updateSpace(str(id), { name: str(title, 40) })
})
ipcMain.on('ui:new-folder', (e, parentId) => {
  const c = fromUI(e)
  if (c) { const f = ctx.spaces.addFolder(c.spaceId, 'New Folder', parentId ? str(parentId) : null); if (f) c.uiWc.send('rename', { kind: 'node', id: f.id }) }
})
ipcMain.on('ui:toggle-folder', (e, id, open) => { if (fromUI(e)) ctx.spaces.setOpen(str(id), open) })
ipcMain.on('ui:toggle-mute', (e, id) => fromUI(e)?.toggleMute(id))
ipcMain.on('ui:unsplit', (e) => fromUI(e)?.unsplit())
ipcMain.on('ui:open-palette', (e) => fromUI(e)?.openPalette())
// drag & drop. target = { zone: 'favorites' | 'pinned' | 'today', parentId?, index }
ipcMain.on('ui:drop', (e, drag, target) => {
  const c = fromUI(e)
  if (!c || !drag || !target) return
  const index = Number.isInteger(target.index) ? target.index : -1
  const parentId = target.parentId ? str(target.parentId) : null
  if (drag.kind === 'tab') {
    const tab = c.tabs.find((t) => t.id === drag.id)
    if (!tab) return
    if (target.zone === 'space') {
      c.moveTabToSpace(tab.id, str(target.spaceId))
    } else if (target.zone === 'today') {
      if (tab.pinnedId || tab.favId) c.unpinTab(tab.id, index)
      else c.moveTab(tab.id, index)
    } else if (target.zone === 'pinned') {
      if (tab.pinnedId) ctx.spaces.move(tab.pinnedId, c.spaceId, parentId, index)
      else { if (tab.favId) { const f = tab.favId; tab.favId = null; ctx.spaces.remove(f) } c.pinTab(tab.id, parentId, index) }
    } else if (target.zone === 'favorites') {
      if (tab.favId) ctx.spaces.moveFavorite(tab.favId, index)
      else { if (tab.pinnedId) { const p = tab.pinnedId; tab.pinnedId = null; ctx.spaces.remove(p) } c.favoriteTab(tab.id, index) }
    }
  } else if (drag.kind === 'node') {
    const id = str(drag.id)
    const isFav = ctx.spaces.favorites.some((f) => f.id === id)
    const live = c.tabs.find((t) => t.pinnedId === id || t.favId === id)
    if (target.zone === 'pinned') {
      if (isFav) {
        const fav = ctx.spaces.item(id)
        ctx.spaces.remove(id)
        const node = ctx.spaces.pin(c.spaceId, fav, parentId, index)
        if (live && node) { live.favId = null; live.pinnedId = node.id; live.spaceId = c.spaceId }
      } else ctx.spaces.move(id, c.spaceId, parentId, index)
    } else if (target.zone === 'favorites') {
      if (isFav) ctx.spaces.moveFavorite(id, index)
      else {
        const node = ctx.spaces.item(id)
        if (node?.type !== 'url') return
        ctx.spaces.remove(id)
        const fav = ctx.spaces.addFavorite(node, index)
        if (live && fav) { live.pinnedId = null; live.favId = fav.id }
      }
    } else if (target.zone === 'today') {
      if (live) c.unpinTab(live.id, index)
      else ctx.spaces.remove(id)
    }
  }
  c.sendState()
})

ipcMain.handle('ui:suggest', (e, q) => {
  if (!fromUI(e) || typeof q !== 'string' || !q.trim()) return []
  const query = q.trim().slice(0, 200)
  const seen = new Set()
  const out = []
  for (const b of ctx.bookmarks.search(query, 3)) { seen.add(b.url); out.push({ type: 'bookmark', url: b.url, title: b.title }) }
  for (const h of ctx.history.search(query, 8)) {
    if (seen.has(h.url) || out.length >= 7) continue
    seen.add(h.url)
    out.push({ type: 'history', url: h.url, title: h.title })
  }
  return out
})

// ---------- command bar (⌘K) ----------

function fromPalette(e) {
  return controllers.find((c) => c.palette && c.palette.webContents === e.sender) || null
}

const COMMANDS = [
  { id: 'new-tab', title: 'New Tab', glyph: '+', hint: '⌘T' },
  { id: 'new-window', title: 'New Window', glyph: '⧉', hint: '⌘N' },
  { id: 'new-space', title: 'New Space', glyph: '✦' },
  { id: 'toggle-sidebar', title: 'Toggle Sidebar', glyph: '◧', hint: '⌘S' },
  { id: 'theme', title: 'Toggle Light / Dark Mode', glyph: '◐', hint: '⇧⌘L' },
  { id: 'split', title: 'Split View with Previous Tab', glyph: '◫', hint: '⌃⇧=' },
  { id: 'unsplit', title: 'Exit Split View', glyph: '▭' },
  { id: 'pin', title: 'Pin Current Tab', glyph: '📌' },
  { id: 'favorite', title: 'Add Current Tab to Favorites', glyph: '★' },
  { id: 'bookmark', title: 'Bookmark Current Page', glyph: '☆', hint: '⌘D' },
  { id: 'copy-url', title: 'Copy Current URL', glyph: '⎘', hint: '⇧⌘C' },
  { id: 'reopen', title: 'Reopen Closed Tab', glyph: '↺', hint: '⇧⌘T' },
  { id: 'wellbeing', title: 'Open Wellbeing', glyph: '◷', hint: '⌘Y' },
  { id: 'settings', title: 'Open Settings', glyph: '⚙', hint: '⌘,' },
  { id: 'import', title: 'Import from Chrome…', glyph: '⇣' },
  { id: 'webstore', title: 'Get Extensions (Chrome Web Store)', glyph: '⧩' },
  { id: 'downloads', title: 'Open Downloads Folder', glyph: '↓' },
]

ipcMain.handle('pal:query', (e, raw) => {
  const c = fromPalette(e)
  if (!c) return []
  const q = str(raw, 200).trim()
  const s = q.toLowerCase()
  const out = []
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
  if (q) {
    const url = toURL(q)
    const isSearch = url.startsWith(ctx.searchEngine().url)
    out.push({ group: 'action', type: 'open', url, title: isSearch ? `Search ${ctx.searchEngine().name} for “${q}”` : `Open ${q}`, glyph: isSearch ? '⌕' : '↗' })
  }
  const match = (...fields) => !s || fields.some((f) => (f || '').toLowerCase().includes(s))
  for (const t of c.tabs) {
    const info = c.tabInfo(t)
    if (info.url === C.NEWTAB_URL || !match(info.title, info.url)) continue
    const sp = t.favId ? 'Favorites' : ctx.spaces.get(t.spaceId).name
    out.push({ group: 'tab', type: 'tab', id: t.id, title: info.title, sub: `${host(info.url)} · ${sp}`, favicon: info.favicon, url: info.url, hint: t.id === c.activeId ? 'current' : 'switch' })
    if (out.filter((x) => x.group === 'tab').length >= (s ? 6 : 8)) break
  }
  if (s) {
    for (const p of ctx.spaces.search(q, 5)) out.push({ group: 'pinned', type: 'item', id: p.id, title: p.title, sub: `${host(p.url)} · ${p.kind === 'favorite' ? 'Favorite' : p.space}`, favicon: p.favicon, url: p.url })
    for (const sp of ctx.spaces.spaces) if (match(sp.name)) out.push({ group: 'space', type: 'space', id: sp.id, title: `Switch to ${sp.name}`, glyph: sp.icon, hint: sp.id === c.spaceId ? 'current' : '' })
    const seen = new Set(out.map((x) => x.url))
    for (const b of ctx.bookmarks.search(q, 5)) if (!seen.has(b.url)) { seen.add(b.url); out.push({ group: 'bookmark', type: 'open', url: b.url, title: b.title, sub: host(b.url) }) }
    for (const h of ctx.history.search(q, 8)) if (!seen.has(h.url)) { seen.add(h.url); out.push({ group: 'history', type: 'open', url: h.url, title: h.title || h.url, sub: host(h.url) }) }
  }
  for (const cmd of COMMANDS) if (s ? match(cmd.title, cmd.id) : out.length < 14) out.push({ group: 'command', type: 'command', ...cmd })
  return out.slice(0, 40)
})

ipcMain.on('pal:close', (e) => fromPalette(e)?.closePalette())
ipcMain.on('pal:run', (e, item = {}) => {
  const c = fromPalette(e)
  if (!c) return
  c.closePalette()
  runAction(c, item)
})

function runAction(c, item) {
  switch (item.type) {
    case 'tab': return c.selectTab(item.id)
    case 'item': return c.openItem(str(item.id), { newTab: !!item.newTab })
    case 'space': return c.switchSpace(str(item.id))
    case 'open': {
      const url = str(item.url, 4000)
      if (!/^(https?|file|valkyrie):/i.test(url)) return
      const cur = c.activeTab?.view.webContents.getURL()
      if (!item.newTab && cur === C.NEWTAB_URL) return c.navigate(url)
      return c.createTab(url)
    }
    case 'command': return runCommand(c, item.id)
  }
}

function runCommand(c, id) {
  switch (id) {
    case 'new-tab': return c.createTab()
    case 'new-window': return createWindow()
    case 'new-space': return c.uiWc.send('rename', { kind: 'new-space' })
    case 'toggle-sidebar': return c.toggleSidebar()
    case 'theme': return toggleTheme()
    case 'split': {
      const prev = c.tabs.filter((t) => t.id !== c.activeId && (t.favId || t.spaceId === c.spaceId)).sort((a, b) => b.lastActive - a.lastActive)[0]
      return prev && c.splitWith(prev.id)
    }
    case 'unsplit': return c.unsplit()
    case 'pin': return c.activeId && c.pinTab(c.activeId)
    case 'favorite': return c.activeId && c.favoriteTab(c.activeId)
    case 'bookmark': return c.toggleBookmark()
    case 'copy-url': return c.copyUrl()
    case 'reopen': return c.reopenClosedTab()
    case 'wellbeing': return c.openSingleton(C.WELLBEING_URL)
    case 'settings': return c.openSingleton(C.SETTINGS_URL)
    case 'import': return c.openSingleton(C.SETTINGS_URL + '#import')
    case 'webstore': return c.createTab(C.WEB_STORE_URL)
    case 'downloads': return shell.openPath(app.getPath('downloads'))
  }
}

// ---------- theme ----------

function applyTheme() {
  const t = ctx.settings.get('theme')
  nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'
}

function toggleTheme() {
  ctx.settings.set('theme', nativeTheme.shouldUseDarkColors ? 'light' : 'dark')
}

// ---------- valkyrie:// page + UI IPC (trusted senders only) ----------

function trustedSender(e) {
  if (fromUI(e)) return true
  return (e.senderFrame?.url || '').startsWith('valkyrie://')
}

function handleTrusted(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(e)) throw new Error('not allowed')
    return fn(...args)
  })
}

// wellbeing
handleTrusted('wb:today', () => ctx.tracker.summary(dayKey()))
handleTrusted('wb:day', (date) => ctx.tracker.day(date))
handleTrusted('wb:range', (dates) => ctx.tracker.range(dates.slice(0, 366)))
handleTrusted('wb:settings', () => ({ ...ctx.tracker.settings, dataDir: ctx.tracker.dir }))
handleTrusted('wb:set-enabled', (enabled) => { ctx.tracker.setEnabled(enabled); return ctx.tracker.settings })
handleTrusted('wb:clear', (date) => { ctx.tracker.clear(date); return true })

// settings / import / passwords
const isDefaultBrowser = () => app.isDefaultProtocolClient('https') && app.isDefaultProtocolClient('http')
handleTrusted('st:info', () => ({
  isDefault: isDefaultBrowser(),
  packaged: app.isPackaged,
  bookmarks: ctx.bookmarks.count(),
  history: ctx.history.count(),
  passwords: ctx.passwords.count(),
  extensions: ctx.ses.extensions.getAllExtensions().length,
}))
handleTrusted('st:make-default', () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' }
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
  return { ok: true, isDefault: isDefaultBrowser() }
})
handleTrusted('imp:browsers', () => chromeImport.listBrowsers())
handleTrusted('imp:run', async (opts) => {
  const report = await chromeImport.runImport(opts, {
    bookmarks: ctx.bookmarks,
    history: ctx.history,
    passwords: ctx.passwords,
    session: ctx.ses,
    installExtension: (id) => installExtension(id, { session: ctx.ses }),
  })
  ctx.settings.set('imported', true)
  return report
})
handleTrusted('pw:list', () => ctx.passwords.list())
handleTrusted('pw:reveal-saved', (id) => ctx.passwords.reveal(id)?.password ?? null)
handleTrusted('pw:delete', (id) => { ctx.passwords.remove(id); return true })
handleTrusted('hist:clear', () => { ctx.history.clear(); return true })

// dashboard (new tab)
handleTrusted('wb:overview', () => ({
  ...ctx.tracker.overview(),
  goalMinutes: ctx.settings.get('dailyGoalMinutes'),
  favorites: ctx.spaces.favorites.map(({ id, title, url, favicon }) => ({ id, title, url, favicon })),
  showStats: ctx.settings.get('newTabShowStats'),
  searchEngine: ctx.searchEngine(),
}))

// preferences
const SETTING_RULES = {
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  searchEngine: (v) => Object.hasOwn(SEARCH_ENGINES, v),
  startup: (v) => ['restore', 'newtab'].includes(v),
  autoArchiveHours: (v) => [0, 12, 24, 72, 168].includes(v),
  adBlock: (v) => typeof v === 'boolean',
  askDownloadLocation: (v) => typeof v === 'boolean',
  idleSeconds: (v) => [30, 60, 120, 300].includes(v),
  dailyGoalMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 1440,
  newTabShowStats: (v) => typeof v === 'boolean',
  sidebarCollapsed: (v) => typeof v === 'boolean',
}
handleTrusted('st:prefs', () => ({
  ...ctx.settings.all(),
  engines: Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v.name])),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  dataDir: app.getPath('userData'),
  spaces: ctx.spaces.spaces.map(({ id, name, icon, color }) => ({ id, name, icon, color })),
  colors: SPACE_COLORS,
}))
handleTrusted('st:set', (key, value) => {
  if (!SETTING_RULES[key]?.(value)) throw new Error(`Invalid setting ${key}`)
  ctx.settings.set(key, value)
  return ctx.settings.all()
})
handleTrusted('st:space', (id, patch) => { ctx.spaces.updateSpace(str(id), patch || {}); return true })
handleTrusted('st:delete-space', (id) => { const ok = ctx.spaces.deleteSpace(str(id)); if (ok) controllers.forEach((c) => c.adoptOrphans()); return ok })
handleTrusted('st:add-space', (name) => { ctx.spaces.createSpace(str(name, 40) || 'New Space'); return true })
handleTrusted('st:archive', () => ctx.archive.list())
handleTrusted('st:archive-clear', () => { ctx.archive.clear(); return true })
handleTrusted('st:open', (url) => { if (/^https?:\/\//.test(url)) currentOrNew().createTab(url) })
handleTrusted('st:open-data-folder', () => shell.openPath(app.getPath('userData')))
handleTrusted('st:clear-data', async (what = {}) => {
  if (what.cache) await ctx.ses.clearCache()
  if (what.cookies) await ctx.ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })
  if (what.history) ctx.history.clear()
  return true
})

// ---------- password autofill (called from websites; origin comes from the frame, not the page) ----------

function webOrigin(e) {
  const origin = e.senderFrame?.origin
  return origin && /^https?:\/\//.test(origin) ? origin : null
}

ipcMain.handle('pw:query', (e) => {
  const origin = webOrigin(e)
  return origin ? ctx.passwords.matches(origin).map(({ id, username, origin: o }) => ({ id, username, origin: o })) : []
})
ipcMain.handle('pw:fill', (e, id) => {
  const origin = webOrigin(e)
  return origin ? ctx.passwords.reveal(id, origin) : null
})
const offering = new Set()
ipcMain.on('pw:offer-save', async (e, { username = '', password = '' } = {}) => {
  const origin = webOrigin(e)
  if (!origin || !password || typeof password !== 'string' || password.length > 1000) return
  if ((ctx.settings.get('neverSavePasswords') || []).includes(origin)) return
  if (ctx.passwords.has(origin, username, password)) return
  const key = origin + '\u0000' + username
  if (offering.has(key)) return
  offering.add(key)
  try {
    const win = BrowserWindow.fromWebContents(e.sender) || current()?.win
    const existing = ctx.passwords.matches(origin).some((m) => m.username === username && m.origin === origin)
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      icon: nativeImage.createFromPath(C.ICON_PNG),
      message: existing ? 'Update saved password?' : 'Save password?',
      detail: `${username || '(no username)'} on ${new URL(origin).host}\nPasswords are encrypted with your macOS Keychain and stay on this device.`,
      buttons: [existing ? 'Update' : 'Save', 'Never for This Site', 'Not Now'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 0) ctx.passwords.add({ origin, username, password })
    if (response === 1) ctx.settings.set('neverSavePasswords', [...(ctx.settings.get('neverSavePasswords') || []), origin])
  } finally {
    offering.delete(key)
  }
})

// ---------- app menu / shortcuts ----------

function withTab(fn) {
  return () => { const t = current()?.activeTab; if (t) fn(t.view.webContents) }
}

function buildMenu() {
  const tabShortcuts = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    visible: false,
    click: () => {
      const c = current()
      const list = c?.tabsInSpace() || []
      if (!list.length) return
      const tab = i === 8 ? list[list.length - 1] : list[i]
      if (tab) c.selectTab(tab.id)
    },
  }))

  const spaceShortcuts = Array.from({ length: 9 }, (_, i) => ({
    label: `Space ${i + 1}`,
    accelerator: `Ctrl+${i + 1}`,
    visible: false,
    click: () => { const sp = ctx.spaces.spaces[i]; if (sp) current()?.switchSpace(sp.id) },
  }))

  const settingsItem = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => currentOrNew().openSingleton(C.SETTINGS_URL) }

  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            settingsItem,
            { label: 'Import Bookmarks, Passwords & More…', click: () => currentOrNew().openSingleton(C.SETTINGS_URL + '#import') },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => currentOrNew().createTab() },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => current()?.reopenClosedTab() },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => current()?.focusUrlBar() },
        { label: 'Command Bar…', accelerator: 'CmdOrCtrl+K', click: () => currentOrNew().openPalette() },
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: () => current()?.copyUrl() },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const c = currentOrNew()
            const { filePaths } = await dialog.showOpenDialog(c.win, {
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'Documents', extensions: ['pdf', 'html', 'htm', 'svg', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }],
            })
            for (const f of filePaths) c.createTab(pathToFileURL(f).href)
          },
        },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { const c = current(); if (c?.activeId) c.closeTab(c.activeId) } },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => current()?.win.close() },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, settingsItem]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: () => current()?.toggleSidebar() },
        { label: 'Toggle Light / Dark Mode', accelerator: 'CmdOrCtrl+Shift+L', click: () => toggleTheme() },
        { label: 'Split View with Previous Tab', accelerator: 'Ctrl+Shift+=', click: () => { const c = current(); if (c) runCommand(c, 'split') } },
        { label: 'Exit Split View', accelerator: 'Ctrl+Shift+-', click: () => current()?.unsplit() },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withTab((wc) => wc.reload()) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: withTab((wc) => wc.reloadIgnoringCache()) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: withTab((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: withTab((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: withTab((wc) => wc.setZoomLevel(0)) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: withTab((wc) => wc.toggleDevTools()) },
        { label: 'Browser UI DevTools', click: () => current()?.uiWc.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: withTab((wc) => wc.navigationHistory.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: withTab((wc) => wc.navigationHistory.goForward()) },
        { type: 'separator' },
        { label: 'Wellbeing & Activity', accelerator: 'CmdOrCtrl+Y', click: () => currentOrNew().openSingleton(C.WELLBEING_URL) },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => current()?.toggleBookmark() },
        { label: 'Pin Tab', accelerator: 'CmdOrCtrl+Shift+D', click: () => { const c = current(); if (c?.activeId) c.pinTab(c.activeId) } },
        { label: 'Add Tab to Favorites', click: () => { const c = current(); if (c?.activeId) c.favoriteTab(c.activeId) } },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => current()?.cycleTab(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => current()?.cycleTab(-1) },
        { label: 'Next Tab ', accelerator: 'Alt+CmdOrCtrl+Down', click: () => current()?.cycleTab(1) },
        { label: 'Previous Tab ', accelerator: 'Alt+CmdOrCtrl+Up', click: () => current()?.cycleTab(-1) },
        ...tabShortcuts,
        { type: 'separator' },
        { label: 'Next Space', accelerator: 'Ctrl+Alt+Right', click: () => current()?.cycleSpace(1) },
        { label: 'Previous Space', accelerator: 'Ctrl+Alt+Left', click: () => current()?.cycleSpace(-1) },
        { label: 'New Space', click: () => current()?.uiWc.send('rename', { kind: 'new-space' }) },
        ...spaceShortcuts,
      ],
    },
    {
      label: 'Extensions',
      submenu: [{ label: 'Chrome Web Store', click: () => currentOrNew().createTab(C.WEB_STORE_URL) }],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- permissions ----------

const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management'])
const ASK = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture'])

function setupPermissions(ses) {
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (ALWAYS_ALLOW.has(permission)) return callback(true)
    if (!ASK.has(permission)) return callback(false)
    let host = details.requestingUrl
    try { host = new URL(details.requestingUrl).host } catch {}
    const win = BrowserWindow.fromWebContents(wc) || current()?.win
    const label = permission === 'media' ? 'use your camera/microphone' : `use ${permission}`
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, message: `${host} wants to ${label}`,
    })
    callback(response === 0)
  })
}

// ---------- ad blocking ----------

const pendingState = new Set()
function scheduleState(c) {
  if (pendingState.has(c)) return
  pendingState.add(c)
  setTimeout(() => { pendingState.delete(c); c.sendState() }, 250)
}

async function enableAdblock(ses) {
  try {
    const cache = path.join(app.getPath('userData'), 'adblock-engine.bin')
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    })
    ctx.blocker = blocker
    if (ctx.settings.get('adBlock')) blocker.enableBlockingInSession(ses)
    blocker.on('request-blocked', (request) => {
      const id = request.tabId
      if (typeof id !== 'number' || id < 0) return
      blockedCounts.set(id, (blockedCounts.get(id) || 0) + 1)
      const c = controllers.find((ctl) => ctl.activeId === id)
      if (c) scheduleState(c)
    })
  } catch (err) {
    console.error('[valkyrie] ad blocker failed to start:', err)
  }
}

// ---------- built-in pages (valkyrie://) ----------

function setupPagesProtocol(ses) {
  ses.protocol.handle('valkyrie', (request) => {
    const { host, pathname } = new URL(request.url)
    const base = path.join(C.PAGES_DIR, host)
    const file = path.normalize(path.join(base, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)))
    if (!host || !file.startsWith(base + path.sep) || !fs.existsSync(file)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(file).href)
  })
  ses.registerPreloadScript({ type: 'frame', id: 'valkyrie-pages', filePath: path.join(C.PAGES_DIR, 'preload.js') })
}

// ---------- activity tracking ----------

function startTracking() {
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime() >= (ctx.settings.get('idleSeconds') || C.IDLE_SECONDS)
    const entries = []
    for (const c of controllers) {
      if (c.win.isDestroyed()) continue
      const focused = c.win.isFocused() && !c.win.isMinimized()
      for (const t of c.tabs) {
        const wc = t.view.webContents
        if (wc.isDestroyed()) continue
        const audible = wc.isCurrentlyAudible()
        if (audible || (focused && t.id === c.activeId && !idle)) entries.push({ tab: t, audible })
      }
    }
    ctx.tracker.tick(entries)
  }, 1000)
  setInterval(() => ctx.tracker.flush(), 15000)
}

// ---------- auto-archive (Arc: unpinned tabs close themselves after a while) ----------

function archiveIdleTabs() {
  const hours = ctx.settings.get('autoArchiveHours')
  if (!hours) return
  const cutoff = Date.now() - hours * 3600 * 1000
  for (const c of controllers) {
    const victims = c.tabs.filter((t) => {
      const wc = t.view.webContents
      return !t.pinnedId && !t.favId && t.id !== c.activeId && t.lastActive < cutoff && !wc.isCurrentlyAudible() && wc.getURL() !== C.NEWTAB_URL
    })
    if (!victims.length) continue
    ctx.archive.add(victims.map((t) => {
      const info = c.tabInfo(t)
      return { url: info.url, title: info.title, favicon: info.favicon, space: ctx.spaces.get(t.spaceId).name }
    }))
    for (const t of victims) c.closeTab(t.id)
  }
}

// ---------- downloads ----------

function setupDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    if (!ctx.settings.get('askDownloadLocation')) {
      const dir = app.getPath('downloads')
      const base = item.getFilename()
      let target = path.join(dir, base)
      const ext = path.extname(base)
      for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.basename(base, ext)} (${i})${ext}`)
      item.setSavePath(target)
    }
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return
      current()?.toast(`Downloaded ${path.basename(item.getSavePath())}`)
      if (process.platform === 'darwin') app.dock?.downloadFinished(item.getSavePath())
    })
  })
}

// ---------- startup ----------

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(C.ICON_PNG)) {
    app.dock?.setIcon(nativeImage.createFromPath(C.ICON_PNG))
  }

  const dataDir = app.getPath('userData')
  ctx.settings = new Settings(path.join(dataDir, 'settings.json'))
  ctx.bookmarks = new Bookmarks(path.join(dataDir, 'bookmarks.json'))
  ctx.history = new History(path.join(dataDir, 'history.db'))
  ctx.passwords = new Passwords(path.join(dataDir, 'passwords.json'))
  ctx.tracker = new Tracker(path.join(dataDir, 'wellbeing'))
  ctx.spaces = new Spaces(path.join(dataDir, 'spaces.json'))
  ctx.archive = new Archive(path.join(dataDir, 'archive.json'))
  ctx.bookmarks.onChange(() => controllers.forEach((c) => { c.sendBookmarks(); c.sendState() }))
  ctx.spaces.onChange(() => controllers.forEach((c) => { c.unlinkMissing(); c.sendState(); c.paintBackdrop() }))
  ctx.settings.onChange((key, value) => {
    if (key === 'theme') applyTheme()
    if (key === 'adBlock' && ctx.blocker) {
      if (value) ctx.blocker.enableBlockingInSession(ctx.ses)
      else ctx.blocker.disableBlockingInSession(ctx.ses)
    }
    if (key === 'sidebarCollapsed') controllers.forEach((c) => { c.layout(); c.sendLayout() })
  })
  applyTheme()

  const ses = session.fromPartition(C.PARTITION)
  ctx.ses = ses
  ses.setUserAgent(CHROME_UA)
  setupPermissions(ses)
  setupPagesProtocol(ses)
  setupDownloads(ses)
  startTracking()
  setInterval(archiveIdleTabs, 10 * 60 * 1000)

  ctx.extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: async (details) => {
      const c = (details.windowId && controllers.find((x) => x.win.id === details.windowId)) || currentOrNew()
      const tab = c.createTab(details.url || C.NEWTAB_URL, { active: details.active !== false })
      return [tab.view.webContents, c.win]
    },
    selectTab: (wc, win) => controllers.find((c) => c.win === win)?.selectTab(wc.id),
    removeTab: (wc, win) => controllers.find((c) => c.win === win)?.closeTab(wc.id),
    createWindow: async (details) => createWindow({ urls: details.url ? [].concat(details.url) : undefined }).win,
    // The library also calls this after a window has already closed on its own.
    removeWindow: (win) => { if (!win.isDestroyed()) win.close() },
  })
  ElectronChromeExtensions.handleCRXProtocol(ses)

  await installChromeWebStore({ session: ses })
  await enableAdblock(ses)
  buildMenu()

  const saved = ctx.settings.get('startup') === 'restore' ? loadSession() : []
  if (saved.length) saved.forEach((w) => createWindow(w))
  else createWindow()

  ready = true
  for (const url of [...pendingOpen, ...urlsFromArgv(process.argv)]) openExternal(url)
  pendingOpen.length = 0

  app.on('activate', () => { if (controllers.length === 0) createWindow() })
})

app.on('before-quit', () => { quitting = true; saveSession(); ctx.tracker?.flush() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
