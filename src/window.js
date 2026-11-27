// One browser window: a backdrop BrowserWindow, one WebContentsView per tab, the sidebar
// UI view on top (so it can float over the page when collapsed) and, above everything,
// the command bar view (⌘K) which is only visible while open.
//
// Arc-style model:
//   - Spaces: each tab belongs to a space; the window shows one space at a time.
//   - Favorites: global icon grid; a favorite opens one live tab (tab.favId).
//   - Pinned: per-space tree with folders; a pinned item opens one live tab (tab.pinnedId).
//     Closing that tab keeps the pinned item.
//   - Today: the ordinary tabs of the current space.
const path = require('path')
const { BrowserWindow, WebContentsView, Menu, clipboard } = require('electron')
const C = require('./constants')

const SIDEBAR_WIDTH = 264
const PEEK_WIDTH = SIDEBAR_WIDTH + 24 // room for the floating panel's shadow
const EDGE = 10 // hover strip that reveals a collapsed sidebar
const GAP = 8
const COLORS = ['violet', 'gold', 'rose', 'teal', 'blue', 'green', 'slate']

class WindowController {
  /**
   * @param ctx shared services: { ses, extensions, tracker, history, bookmarks, settings, spaces,
   *   blockedCounts, controllers, onFocus, onClosed, saveSessionSoon, toURL, searchUrl }
   * @param opts { tabs: [{ url, spaceId, pinnedId, favId, title }], active, spaceId } or legacy { urls }
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx
    this.tabs = []
    this.activeId = null
    this.closedUrls = []
    this.fullscreenTab = false
    this.peek = false
    this.split = null // { a, b } tab ids shown side by side
    this.lastActiveBySpace = new Map()
    this.spaceId = ctx.spaces.get(opts.spaceId).id

    this.win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 720,
      minHeight: 480,
      title: 'Valkyrie',
      icon: C.ICON_PNG,
      show: false,
      // macOS: traffic lights float over the sidebar. Windows/Linux: normal frame with native buttons.
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
        : { autoHideMenuBar: true }),
      backgroundColor: '#17161c',
      webPreferences: { session: ctx.ses, sandbox: true, contextIsolation: true },
    })
    this.win.loadFile(path.join(__dirname, 'ui', 'backdrop.html'))
    this.win.webContents.on('did-finish-load', () => this.paintBackdrop())

    this.ui = new WebContentsView({
      webPreferences: {
        session: ctx.ses,
        preload: path.join(__dirname, 'ui', 'preload.js'),
        sandbox: false, // UI preload needs node_modules for <browser-action-list>
        contextIsolation: true,
        transparent: true,
      },
    })
    this.ui.setBackgroundColor('#00000000')
    this.ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'))
    this.win.contentView.addChildView(this.ui)
    this.ui.webContents.on('did-finish-load', () => { this.sendState(); this.sendLayout(); this.sendBookmarks() })

    this.palette = null

    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('resize', () => this.layout())
    this.win.on('focus', () => ctx.onFocus(this))
    this.win.on('closed', () => ctx.onClosed(this))

    ctx.controllers.push(this)
    ctx.onFocus(this)

    const saved = opts.tabs || (opts.urls || []).map((url) => ({ url }))
    for (const t of saved) {
      // drop links to pinned items / favorites that no longer exist
      const pinnedId = t.pinnedId && ctx.spaces.find(t.pinnedId) ? t.pinnedId : null
      const favId = t.favId && ctx.spaces.favorites.some((f) => f.id === t.favId) ? t.favId : null
      const spaceId = ctx.spaces.get(t.spaceId).id
      const tab = this.createTab(t.url, { active: false, spaceId, pinnedId, favId })
      if (t.title) tab.customTitle = t.title
    }
    const first = this.tabs[Math.min(opts.active || 0, this.tabs.length - 1)]
    if (first) {
      this.spaceId = first.favId ? this.spaceId : first.spaceId
      this.selectTab(first.id)
    } else {
      this.createTab(C.NEWTAB_URL)
    }
  }

  get uiWc() { return this.ui.webContents }
  get activeTab() { return this.tabs.find((t) => t.id === this.activeId) || null }
  get collapsed() { return !!this.ctx.settings.get('sidebarCollapsed') }
  get space() { return this.ctx.spaces.get(this.spaceId) }

  tabsInSpace(spaceId = this.spaceId) {
    return this.tabs.filter((t) => !t.favId && t.spaceId === spaceId)
  }

  // ---------- tabs ----------

  createTab(url = C.NEWTAB_URL, { active = true, spaceId = this.spaceId, pinnedId = null, favId = null } = {}) {
    const { tracker, history, extensions, blockedCounts } = this.ctx
    const view = new WebContentsView({
      webPreferences: { session: this.ctx.ses, sandbox: true, contextIsolation: true, plugins: true }, // plugins = PDF viewer
    })
    view.setBorderRadius?.(10)
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.raiseOverlays()

    const wc = view.webContents
    const tab = { id: wc.id, view, favicon: null, spaceId, pinnedId, favId, customTitle: null, lastActive: Date.now() }
    this.tabs.push(tab)
    extensions.addTab(wc, this.win)

    const update = () => { this.sendState(); this.ctx.saveSessionSoon() }
    wc.on('page-title-updated', (_e, title) => {
      tracker.setTitle(tab, title)
      history.setTitle(wc.getURL(), title)
      update()
    })
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', update)
    wc.on('did-navigate', (_e, navUrl) => {
      blockedCounts.set(wc.id, 0)
      tab.favicon = null
      tracker.startVisit(tab, navUrl, wc.getTitle())
      history.record(navUrl, wc.getTitle())
      update()
    })
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) {
        tracker.startVisit(tab, navUrl, wc.getTitle()) // e.g. each YouTube video
        history.record(navUrl, wc.getTitle())
      }
      update()
    })
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0] || null
      tracker.setFavicon(wc.getURL(), tab.favicon)
      const linked = (tab.pinnedId && this.ctx.spaces.find(tab.pinnedId)?.node) || (tab.favId && this.ctx.spaces.item(tab.favId))
      if (linked && tab.favicon && linked.favicon !== tab.favicon) { linked.favicon = tab.favicon; this.ctx.spaces.save() }
      update()
    })
    wc.on('media-started-playing', update)
    wc.on('media-paused', update)
    wc.on('audio-state-changed', update)
    wc.on('focus', () => {
      tab.lastActive = Date.now()
      // clicking into the other half of a split makes it the active tab
      if (this.split && (this.split.a === tab.id || this.split.b === tab.id) && this.activeId !== tab.id) {
        this.activeId = tab.id
        this.ctx.extensions.selectTab(wc)
        this.sendState()
      }
    })
    wc.on('enter-html-full-screen', () => { this.fullscreenTab = true; this.layout() })
    wc.on('leave-html-full-screen', () => { this.fullscreenTab = false; this.layout() })
    wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params))

    // Links that want a new tab open as tabs; real popups (OAuth etc.) stay popups.
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      if (disposition === 'new-window') return { action: 'allow' }
      this.createTab(target, { active: disposition !== 'background-tab', spaceId: tab.favId ? this.spaceId : tab.spaceId })
      return { action: 'deny' }
    })

    wc.loadURL(url)
    this.layout()
    if (active) this.selectTab(tab.id)
    else this.sendState()
    return tab
  }

  selectTab(id, { focus = true } = {}) {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    if (!tab.favId && tab.spaceId !== this.spaceId) {
      this.spaceId = tab.spaceId
      this.paintBackdrop()
    }
    if (this.split && this.split.a !== id && this.split.b !== id) {
      // leaving the split keeps it around; it comes back when either half is selected
    }
    this.activeId = id
    tab.lastActive = Date.now()
    this.lastActiveBySpace.set(this.spaceId, id)
    this.ctx.extensions.selectTab(tab.view.webContents)
    this.layout()
    const url = tab.view.webContents.getURL()
    if (focus) {
      if (!url || url === C.NEWTAB_URL) this.focusUrlBar()
      else tab.view.webContents.focus()
    }
    this.sendState()
    this.ctx.saveSessionSoon()
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const [tab] = this.tabs.splice(i, 1)
    const url = tab.view.webContents.getURL()
    if (url && url !== C.NEWTAB_URL) this.closedUrls.push({ url, spaceId: tab.spaceId })
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    this.ctx.blockedCounts.delete(id)
    if (this.split && (this.split.a === id || this.split.b === id)) this.split = null

    if (this.activeId === id) {
      const rest = this.tabsInSpace()
      const pinnedOrFav = this.tabs.filter((t) => t.favId || (t.pinnedId && t.spaceId === this.spaceId))
      const next = rest[Math.min(i, rest.length - 1)] || rest[0] || pinnedOrFav[0]
      if (next) this.selectTab(next.id)
      else this.createTab(C.NEWTAB_URL)
    } else {
      this.sendState()
    }
    this.ctx.saveSessionSoon()
  }

  closeOtherTabs(id) {
    for (const t of this.tabsInSpace()) if (t.id !== id && !t.pinnedId) this.closeTab(t.id)
  }

  /** Focus an existing tab (in any space) showing this built-in page, or open one. */
  openSingleton(url) {
    const base = url.split('#')[0]
    const existing = this.tabs.find((t) => t.view.webContents.getURL().startsWith(base))
    if (existing) {
      if (existing.view.webContents.getURL() !== url) existing.view.webContents.loadURL(url)
      this.selectTab(existing.id)
    } else {
      this.createTab(url)
    }
  }

  /** Open (or focus) the live tab of a pinned item or favorite. */
  openItem(itemId, { newTab = false } = {}) {
    const item = this.ctx.spaces.item(itemId)
    if (!item || item.type === 'folder') return
    const isFav = this.ctx.spaces.favorites.some((f) => f.id === itemId)
    if (newTab) return this.createTab(item.url)
    const live = this.tabs.find((t) => (isFav ? t.favId : t.pinnedId) === itemId)
    if (live) return this.selectTab(live.id)
    const hit = !isFav && this.ctx.spaces.find(itemId)
    this.createTab(item.url, isFav ? { favId: itemId } : { pinnedId: itemId, spaceId: hit?.space?.id || this.spaceId })
  }

  /** Arc's "Back to pinned URL". */
  resetToPinnedUrl(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId)
    const item = tab && this.ctx.spaces.item(tab.pinnedId || tab.favId)
    if (item) tab.view.webContents.loadURL(item.url)
  }

  /** Called when pinned items/favorites are removed elsewhere. */
  unlinkMissing() {
    for (const t of this.tabs) {
      if (t.pinnedId && !this.ctx.spaces.find(t.pinnedId)) t.pinnedId = null
      if (t.favId && !this.ctx.spaces.favorites.some((f) => f.id === t.favId)) { t.favId = null; t.spaceId = this.spaceId }
    }
  }

  pinTab(tabId, parentId = null, index = -1) {
    const tab = this.tabs.find((t) => t.id === tabId)
    const wc = tab?.view.webContents
    if (!tab || !/^(https?|file|valkyrie):/.test(wc.getURL()) || wc.getURL() === C.NEWTAB_URL) return
    const node = this.ctx.spaces.pin(this.spaceId, { url: wc.getURL(), title: tab.customTitle || wc.getTitle() }, parentId, index)
    if (!node) return
    node.favicon = tab.favicon
    tab.pinnedId = node.id
    tab.favId = null
    tab.spaceId = this.spaceId
    this.ctx.spaces.save()
  }

  favoriteTab(tabId, index = -1) {
    const tab = this.tabs.find((t) => t.id === tabId)
    const wc = tab?.view.webContents
    if (!tab || !/^(https?|file|valkyrie):/.test(wc.getURL()) || wc.getURL() === C.NEWTAB_URL) return
    const fav = this.ctx.spaces.addFavorite({ url: wc.getURL(), title: tab.customTitle || wc.getTitle() }, index)
    if (!fav) return
    fav.favicon = tab.favicon
    tab.favId = fav.id
    tab.pinnedId = null
    this.ctx.spaces.save()
  }

  /** Turn a pinned/favorite tab back into a normal "Today" tab. */
  unpinTab(tabId, index = -1) {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const linked = tab.pinnedId || tab.favId
    tab.pinnedId = null
    tab.favId = null
    tab.spaceId = this.spaceId
    if (linked) this.ctx.spaces.remove(linked)
    if (index >= 0) this.moveTab(tabId, index)
  }

  reopenClosedTab() {
    const entry = this.closedUrls.pop()
    if (entry) this.createTab(entry.url, { spaceId: this.ctx.spaces.get(entry.spaceId).id })
  }

  cycleTab(delta) {
    const list = this.tabsInSpace()
    if (list.length < 2) return
    const i = list.findIndex((t) => t.id === this.activeId)
    this.selectTab(list[(i + delta + list.length) % list.length].id)
  }

  /** Reorder within the current space's Today list. `toIndex` is an index into that list. */
  moveTab(id, toIndex) {
    const list = this.tabsInSpace()
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    const others = list.filter((t) => t !== tab)
    const anchor = others[Math.max(0, Math.min(toIndex, others.length))]
    this.tabs.splice(this.tabs.indexOf(tab), 1)
    if (anchor) this.tabs.splice(this.tabs.indexOf(anchor), 0, tab)
    else this.tabs.push(tab)
    this.sendState()
    this.ctx.saveSessionSoon()
  }

  moveTabToSpace(tabId, spaceId) {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) return
    tab.spaceId = this.ctx.spaces.get(spaceId).id
    tab.favId = null
    if (tab.pinnedId) {
      this.ctx.spaces.move(tab.pinnedId, tab.spaceId, null, -1)
    }
    if (this.activeId === tabId) this.switchSpace(tab.spaceId, tabId)
    else this.sendState()
  }

  duplicateTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (tab) this.createTab(tab.view.webContents.getURL(), { spaceId: tab.favId ? this.spaceId : tab.spaceId })
  }

  toggleMute(tabId) {
    const wc = this.tabs.find((t) => t.id === tabId)?.view.webContents
    if (wc) { wc.setAudioMuted(!wc.isAudioMuted()); this.sendState() }
  }

  renameTab(tabId, title) {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) return
    tab.customTitle = title?.trim() ? title.trim().slice(0, 120) : null
    this.sendState()
    this.ctx.saveSessionSoon()
  }

  navigate(input) {
    const url = this.ctx.toURL(input)
    const tab = this.activeTab
    if (!url || !tab) return
    tab.view.webContents.loadURL(url)
    tab.view.webContents.focus()
  }

  copyUrl() {
    const url = this.activeTab?.view.webContents.getURL()
    if (!url || url === C.NEWTAB_URL) return
    clipboard.writeText(url)
    this.toast('Link copied')
  }

  toggleBookmark() {
    const wc = this.activeTab?.view.webContents
    const url = wc?.getURL()
    if (!url || url.startsWith('valkyrie:')) return
    const added = this.ctx.bookmarks.toggle(url, wc.getTitle())
    this.toast(added ? 'Bookmarked' : 'Bookmark removed')
  }

  // ---------- spaces ----------

  switchSpace(spaceId, preferTabId = null) {
    const space = this.ctx.spaces.get(spaceId)
    this.spaceId = space.id
    this.paintBackdrop()
    const remembered = preferTabId || this.lastActiveBySpace.get(space.id)
    const candidates = this.tabs.filter((t) => !t.favId && t.spaceId === space.id)
    const target = candidates.find((t) => t.id === remembered) || candidates.find((t) => !t.pinnedId) || candidates[0]
    if (target) this.selectTab(target.id)
    else this.createTab(C.NEWTAB_URL)
  }

  cycleSpace(delta) {
    const list = this.ctx.spaces.spaces
    const i = list.findIndex((s) => s.id === this.spaceId)
    this.switchSpace(list[(i + delta + list.length) % list.length].id)
  }

  /** Called after a space is deleted: move its tabs to the current/first space. */
  adoptOrphans() {
    for (const t of this.tabs) {
      if (!t.favId && !this.ctx.spaces.spaces.some((s) => s.id === t.spaceId)) t.spaceId = this.ctx.spaces.spaces[0].id
    }
    if (!this.ctx.spaces.spaces.some((s) => s.id === this.spaceId)) this.switchSpace(this.ctx.spaces.spaces[0].id)
  }

  paintBackdrop() {
    if (this.win.isDestroyed()) return
    const color = COLORS.includes(this.space.color) ? this.space.color : 'violet'
    this.win.webContents.executeJavaScript(`document.documentElement.dataset.color = ${JSON.stringify(color)}`).catch(() => {})
  }

  // ---------- split view ----------

  splitWith(otherId) {
    if (!this.activeId || otherId === this.activeId || !this.tabs.some((t) => t.id === otherId)) return
    this.split = { a: this.activeId, b: otherId }
    this.layout()
    this.sendState()
  }

  unsplit() {
    if (!this.split) return
    this.split = null
    this.layout()
    this.sendState()
  }

  // ---------- sidebar & overlays ----------

  toggleSidebar() {
    this.ctx.settings.set('sidebarCollapsed', !this.collapsed)
    this.peek = false
    for (const c of this.ctx.controllers) { c.layout(); c.sendLayout() }
  }

  setPeek(peek) {
    if (!this.collapsed || this.peek === peek) return
    this.peek = peek
    this.layout()
    this.sendLayout()
  }

  focusUrlBar() {
    if (this.collapsed) this.setPeek(true)
    this.uiWc.focus()
    this.uiWc.send('focus-url')
  }

  toast(text) {
    if (this.collapsed && !this.peek) return this.palette?.webContents.send('toast', text)
    this.uiWc.send('toast', text)
  }

  raiseOverlays() {
    this.win.contentView.addChildView(this.ui)
    if (this.palette?.getVisible()) this.win.contentView.addChildView(this.palette)
  }

  openPalette(mode = 'search') {
    if (!this.palette) {
      this.palette = new WebContentsView({
        webPreferences: { session: this.ctx.ses, preload: path.join(__dirname, 'ui', 'palette-preload.js'), sandbox: true, contextIsolation: true, transparent: true },
      })
      this.palette.setBackgroundColor('#00000000')
      this.palette.webContents.loadFile(path.join(__dirname, 'ui', 'palette.html'))
      this.paletteReady = new Promise((r) => this.palette.webContents.once('did-finish-load', r))
    }
    const [w, h] = this.win.getContentSize()
    this.palette.setBounds({ x: 0, y: 0, width: w, height: h })
    this.palette.setVisible(true)
    this.win.contentView.addChildView(this.palette)
    this.paletteReady.then(() => {
      this.palette.webContents.focus()
      this.palette.webContents.send('palette-open', { mode, url: this.activeTab?.view.webContents.getURL() || '' })
    })
  }

  closePalette() {
    if (!this.palette?.getVisible()) return
    this.palette.setVisible(false)
    this.activeTab?.view.webContents.focus()
  }

  layout() {
    if (this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize()
    let area
    let uiBounds
    if (this.fullscreenTab) {
      area = { x: 0, y: 0, width: w, height: h }
      uiBounds = { x: 0, y: 0, width: 0, height: 0 }
    } else if (this.collapsed) {
      area = { x: GAP, y: GAP, width: w - GAP * 2, height: h - GAP * 2 }
      uiBounds = { x: 0, y: 0, width: this.peek ? PEEK_WIDTH : EDGE, height: h }
    } else {
      area = { x: SIDEBAR_WIDTH, y: GAP, width: w - SIDEBAR_WIDTH - GAP, height: h - GAP * 2 }
      uiBounds = { x: 0, y: 0, width: SIDEBAR_WIDTH, height: h }
    }
    area.width = Math.max(0, area.width)
    area.height = Math.max(0, area.height)

    const inSplit = this.split && !this.fullscreenTab && (this.split.a === this.activeId || this.split.b === this.activeId)
    const half = Math.floor((area.width - GAP) / 2)
    for (const t of this.tabs) {
      if (inSplit && t.id === this.split.a) {
        t.view.setBounds({ ...area, width: half })
        t.view.setVisible(true)
      } else if (inSplit && t.id === this.split.b) {
        t.view.setBounds({ ...area, x: area.x + half + GAP, width: area.width - half - GAP })
        t.view.setVisible(true)
      } else {
        t.view.setBounds(area)
        t.view.setVisible(t.id === this.activeId)
      }
    }
    this.ui.setBounds(uiBounds)
    if (this.palette?.getVisible()) this.palette.setBounds({ x: 0, y: 0, width: w, height: h })
    if (process.platform === 'darwin') {
      this.win.setWindowButtonVisibility(!this.fullscreenTab && (!this.collapsed || this.peek))
    }
  }

  // ---------- UI sync ----------

  sendLayout() {
    if (this.uiWc.isDestroyed()) return
    this.uiWc.send('layout', { collapsed: this.collapsed, peek: this.peek })
  }

  sendBookmarks() {
    if (this.uiWc.isDestroyed()) return
    this.uiWc.send('bookmarks', this.ctx.bookmarks.root)
  }

  tabInfo(t) {
    const wc = t.view.webContents
    const url = wc.getURL()
    return {
      id: t.id,
      url,
      title: t.customTitle || (url === C.NEWTAB_URL ? 'New Tab' : wc.getTitle() || url || 'New Tab'),
      favicon: t.favicon,
      loading: wc.isLoading(),
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
      split: !!this.split && (this.split.a === t.id || this.split.b === t.id),
    }
  }

  sendState() {
    if (this.win.isDestroyed() || this.uiWc.isDestroyed()) return
    const { spaces, bookmarks, blockedCounts } = this.ctx
    const byFav = new Map(this.tabs.filter((t) => t.favId).map((t) => [t.favId, t]))
    const byPin = new Map(this.tabs.filter((t) => t.pinnedId).map((t) => [t.pinnedId, t]))
    const decorate = (nodes) => nodes.map((n) => {
      if (n.type === 'folder') return { ...n, children: decorate(n.children) }
      const t = byPin.get(n.id)
      return { ...n, tab: t ? this.tabInfo(t) : null }
    })
    const active = this.activeTab
    const wc = active?.view.webContents
    this.uiWc.send('state', {
      newTabUrl: C.NEWTAB_URL,
      activeId: this.activeId,
      spaceId: this.spaceId,
      spaces: spaces.spaces.map(({ id, name, icon, color }) => ({ id, name, icon, color })),
      favorites: spaces.favorites.map((f) => { const t = byFav.get(f.id); return { ...f, tab: t ? this.tabInfo(t) : null } }),
      pinned: decorate(this.space.pinned),
      tabs: this.tabsInSpace().filter((t) => !t.pinnedId).map((t) => this.tabInfo(t)),
      active: wc ? {
        ...this.tabInfo(active),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        blocked: blockedCounts.get(active.id) || 0,
        bookmarked: bookmarks.has(wc.getURL()),
        pinnedId: active.pinnedId,
        favId: active.favId,
      } : null,
      split: this.split,
    })
  }

  // ---------- menus ----------

  showTabMenu(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const wc = tab.view.webContents
    const url = wc.getURL()
    const others = this.tabs.filter((t) => t.id !== tabId && (t.favId || t.spaceId === this.spaceId))
    const spaces = this.ctx.spaces.spaces
    const items = [
      ...(tab.pinnedId || tab.favId
        ? [
            { label: tab.favId ? 'Remove from Favorites' : 'Unpin Tab', click: () => this.unpinTab(tabId) },
            { label: 'Back to Pinned URL', click: () => this.resetToPinnedUrl(tabId) },
          ]
        : [
            { label: 'Pin Tab', click: () => this.pinTab(tabId) },
            { label: 'Add to Favorites', click: () => this.favoriteTab(tabId) },
          ]),
      { type: 'separator' },
      this.split && (this.split.a === tabId || this.split.b === tabId)
        ? { label: 'Exit Split View', click: () => this.unsplit() }
        : { label: 'Open in Split View', enabled: !!this.activeId && this.activeId !== tabId, click: () => { this.splitWith(tabId) } },
      {
        label: 'Split With…',
        enabled: others.length > 0,
        submenu: others.slice(0, 20).map((o) => ({ label: this.tabInfo(o).title.slice(0, 50), click: () => { this.selectTab(tabId, { focus: false }); this.splitWith(o.id) } })),
      },
      { type: 'separator' },
      { label: 'Rename Tab…', click: () => this.uiWc.send('rename', { kind: 'tab', id: tabId }) },
      { label: 'Duplicate Tab', click: () => this.duplicateTab(tabId) },
      { label: wc.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => this.toggleMute(tabId) },
      { label: 'Copy Link', enabled: url !== C.NEWTAB_URL, click: () => { clipboard.writeText(url); this.toast('Link copied') } },
      {
        label: 'Move to Space',
        submenu: spaces.map((s) => ({ label: `${s.icon}  ${s.name}`, type: 'radio', checked: !tab.favId && tab.spaceId === s.id, click: () => this.moveTabToSpace(tabId, s.id) })),
      },
      { type: 'separator' },
      { label: 'Close Tab', click: () => this.closeTab(tabId) },
      { label: 'Close Other Tabs', click: () => this.closeOtherTabs(tabId) },
    ]
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  showItemMenu(itemId) {
    const { spaces } = this.ctx
    const isFav = spaces.favorites.some((f) => f.id === itemId)
    const hit = !isFav && spaces.find(itemId)
    const node = isFav ? spaces.item(itemId) : hit?.node
    if (!node) return
    const live = this.tabs.find((t) => (isFav ? t.favId : t.pinnedId) === itemId)
    const items = node.type === 'folder'
      ? [
          { label: 'Rename Folder…', click: () => this.uiWc.send('rename', { kind: 'node', id: itemId }) },
          { label: 'New Folder Inside', click: () => spaces.addFolder(this.spaceId, 'New Folder', itemId) },
          { label: 'Open All in Tabs', click: () => { for (const { node: n } of spaces.walk(node.children)) if (n.type === 'url') this.createTab(n.url, { active: false }) } },
          { type: 'separator' },
          { label: 'Delete Folder', click: () => spaces.remove(itemId) },
        ]
      : [
          { label: 'Open in New Tab', click: () => this.openItem(itemId, { newTab: true }) },
          { label: 'Rename…', click: () => this.uiWc.send('rename', { kind: 'node', id: itemId }) },
          { label: 'Copy Link', click: () => { clipboard.writeText(node.url); this.toast('Link copied') } },
          ...(live ? [{ label: 'Back to Pinned URL', click: () => this.resetToPinnedUrl(live.id) }, { label: 'Close Tab', click: () => this.closeTab(live.id) }] : []),
          { type: 'separator' },
          isFav
            ? { label: 'Remove from Favorites', click: () => spaces.remove(itemId) }
            : { label: 'Unpin', click: () => spaces.remove(itemId) },
          ...(!isFav ? [{ label: 'Add to Favorites', click: () => { spaces.addFavorite(node); spaces.remove(itemId) } }] : []),
        ]
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  showSpaceMenu(spaceId) {
    const { spaces } = this.ctx
    const s = spaces.get(spaceId)
    const icons = ['✦', '◆', '●', '▲', '✿', '☾', '☀', '♪', '⚡', '♥', '★', '✎', '⌘', '☕', '🎮', '📚']
    Menu.buildFromTemplate([
      { label: 'Rename Space…', click: () => this.uiWc.send('rename', { kind: 'space', id: spaceId }) },
      { label: 'Icon', submenu: icons.map((i) => ({ label: i, type: 'radio', checked: s.icon === i, click: () => spaces.updateSpace(spaceId, { icon: i }) })) },
      { label: 'Color', submenu: COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), type: 'radio', checked: s.color === c, click: () => spaces.updateSpace(spaceId, { color: c }) })) },
      { type: 'separator' },
      { label: 'New Space', click: () => this.uiWc.send('rename', { kind: 'new-space' }) },
      { label: 'Delete Space', enabled: spaces.spaces.length > 1, click: () => { if (spaces.deleteSpace(spaceId)) this.ctx.controllers.forEach((c) => c.adoptOrphans()) } },
    ]).popup({ window: this.win })
  }

  showContextMenu(wc, params) {
    const search = this.ctx.searchEngine()
    const items = []
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.createTab(params.linkURL, { active: false }) },
        { label: 'Open Link in Split View', click: () => { const t = this.createTab(params.linkURL, { active: false }); this.splitWith(t.id) } },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.createTab(params.srcURL, { active: false }) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { type: 'separator' },
      )
    }
    if (params.selectionText) {
      const q = params.selectionText.trim().slice(0, 60)
      items.push(
        { role: 'copy' },
        { label: `Search ${search.name} for “${q}”`, click: () => this.createTab(search.url + encodeURIComponent(params.selectionText)) },
        { type: 'separator' },
      )
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
    )
    const extItems = this.ctx.extensions.getContextMenuItems(wc, params)
    if (extItems.length) items.push({ type: 'separator' }, ...extItems)
    items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) })
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  // ---------- session ----------

  serialize() {
    return {
      spaceId: this.spaceId,
      active: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)),
      tabs: this.tabs.map((t) => ({
        url: t.view.webContents.getURL() || C.NEWTAB_URL,
        spaceId: t.spaceId,
        pinnedId: t.pinnedId,
        favId: t.favId,
        title: t.customTitle,
      })),
    }
  }
}

module.exports = { WindowController, COLORS }
