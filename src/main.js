// Valkyrie — main process.
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const {
  app, BrowserWindow, session, ipcMain, Menu, dialog, protocol, net, powerMonitor, nativeImage, clipboard,
} = require('electron')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore, installExtension } = require('electron-chrome-web-store')
const { ElectronBlocker } = require('@ghostery/adblocker-electron')

const C = require('./constants')
const { Tracker, dayKey } = require('./tracker')
const { Settings, Bookmarks, History } = require('./stores')
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
  controllers, blockedCounts,
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
  return C.SEARCH_URL + encodeURIComponent(s)
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
  const data = {
    windows: controllers.map((c) => ({
      urls: c.tabs.map((t) => t.view.webContents.getURL() || C.NEWTAB_URL),
      active: Math.max(0, c.tabs.findIndex((t) => t.id === c.activeId)),
    })),
  }
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
      if (!c || !c.tabs.length) return
      const tab = i === 8 ? c.tabs[c.tabs.length - 1] : c.tabs[i]
      if (tab) c.selectTab(tab.id)
    },
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
    blocker.enableBlockingInSession(ses)
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
    const idle = powerMonitor.getSystemIdleTime() >= C.IDLE_SECONDS
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
  ctx.bookmarks.onChange(() => controllers.forEach((c) => { c.sendBookmarks(); c.sendState() }))

  const ses = session.fromPartition(C.PARTITION)
  ctx.ses = ses
  ses.setUserAgent(CHROME_UA)
  setupPermissions(ses)
  setupPagesProtocol(ses)
  startTracking()

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

  const saved = loadSession()
  if (saved.length) saved.forEach((w) => createWindow(w))
  else createWindow()

  ready = true
  for (const url of [...pendingOpen, ...urlsFromArgv(process.argv)]) openExternal(url)
  pendingOpen.length = 0

  app.on('activate', () => { if (controllers.length === 0) createWindow() })
})

app.on('before-quit', () => { quitting = true; saveSession(); ctx.tracker?.flush() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
