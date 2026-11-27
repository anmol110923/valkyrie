// One browser window: a backdrop BrowserWindow, one WebContentsView per tab and,
// on top of them, the sidebar UI view (so it can float over the page when collapsed).
const path = require('path')
const { BrowserWindow, WebContentsView, Menu, clipboard } = require('electron')
const C = require('./constants')

const SIDEBAR_WIDTH = 260
const PEEK_WIDTH = SIDEBAR_WIDTH + 24 // room for the floating panel's shadow
const EDGE = 10 // hover strip that reveals a collapsed sidebar
const GAP = 8

class WindowController {
  /**
   * @param ctx shared app services: { ses, extensions, tracker, history, bookmarks, settings,
   *   blockedCounts, controllers, onFocus, onClosed, saveSessionSoon, toURL }
   */
  constructor(ctx, { urls = [C.NEWTAB_URL], active = 0 } = {}) {
    this.ctx = ctx
    this.tabs = []
    this.activeId = null
    this.closedUrls = []
    this.fullscreenTab = false
    this.peek = false

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

    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('resize', () => this.layout())
    this.win.on('focus', () => ctx.onFocus(this))
    this.win.on('closed', () => ctx.onClosed(this))

    ctx.controllers.push(this)
    ctx.onFocus(this)

    const list = urls.length ? urls : [C.NEWTAB_URL]
    list.forEach((u) => this.createTab(u, { active: false }))
    this.selectTab(this.tabs[Math.min(active, this.tabs.length - 1)].id)
  }

  get uiWc() { return this.ui.webContents }

  get activeTab() {
    return this.tabs.find((t) => t.id === this.activeId) || null
  }

  get collapsed() { return !!this.ctx.settings.get('sidebarCollapsed') }

  // ---------- tabs ----------

  createTab(url = C.NEWTAB_URL, { active = true } = {}) {
    const { tracker, history, extensions, blockedCounts } = this.ctx
    const view = new WebContentsView({
      webPreferences: { session: this.ctx.ses, sandbox: true, contextIsolation: true, plugins: true }, // plugins = PDF viewer
    })
    view.setBorderRadius?.(10)
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.win.contentView.addChildView(this.ui) // keep the sidebar on top

    const wc = view.webContents
    const tab = { id: wc.id, view, favicon: null }
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
      update()
    })
    wc.on('enter-html-full-screen', () => { this.fullscreenTab = true; this.layout() })
    wc.on('leave-html-full-screen', () => { this.fullscreenTab = false; this.layout() })
    wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params))

    // Links that want a new tab open as tabs; real popups (OAuth etc.) stay popups.
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      if (disposition === 'new-window') return { action: 'allow' }
      this.createTab(target, { active: disposition !== 'background-tab' })
      return { action: 'deny' }
    })

    wc.loadURL(url)
    this.layout()
    if (active) this.selectTab(tab.id)
    else this.sendState()
    return tab
  }

  selectTab(id) {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    this.activeId = id
    for (const t of this.tabs) t.view.setVisible(t.id === id)
    this.ctx.extensions.selectTab(tab.view.webContents)
    this.layout()
    const url = tab.view.webContents.getURL()
    if (!url || url === C.NEWTAB_URL) this.focusUrlBar()
    else tab.view.webContents.focus()
    this.sendState()
    this.ctx.saveSessionSoon()
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const [tab] = this.tabs.splice(i, 1)
    const url = tab.view.webContents.getURL()
    if (url && url !== C.NEWTAB_URL) this.closedUrls.push(url)
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    this.ctx.blockedCounts.delete(id)

    if (this.tabs.length === 0) this.createTab(C.NEWTAB_URL)
    else if (this.activeId === id) this.selectTab(this.tabs[Math.min(i, this.tabs.length - 1)].id)
    else this.sendState()
    this.ctx.saveSessionSoon()
  }

  /** Focus an existing tab whose URL starts with `prefix`, or open one. */
  openSingleton(url) {
    const base = url.split('#')[0]
    const existing = this.tabs.find((t) => t.view.webContents.getURL().startsWith(base))
    if (existing) {
      existing.view.webContents.loadURL(url)
      this.selectTab(existing.id)
    } else {
      this.createTab(url)
    }
  }

  reopenClosedTab() {
    const url = this.closedUrls.pop()
    if (url) this.createTab(url)
  }

  cycleTab(delta) {
    if (this.tabs.length < 2) return
    const i = this.tabs.findIndex((t) => t.id === this.activeId)
    this.selectTab(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id)
  }

  moveTab(id, toIndex) {
    const from = this.tabs.findIndex((t) => t.id === id)
    if (from < 0) return
    const [tab] = this.tabs.splice(from, 1)
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab)
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

  toggleBookmark() {
    const wc = this.activeTab?.view.webContents
    const url = wc?.getURL()
    if (!url || url.startsWith('valkyrie:')) return
    this.ctx.bookmarks.toggle(url, wc.getTitle())
  }

  // ---------- sidebar ----------

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

  layout() {
    if (this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize()
    let tabBounds
    let uiBounds
    if (this.fullscreenTab) {
      tabBounds = { x: 0, y: 0, width: w, height: h }
      uiBounds = { x: 0, y: 0, width: 0, height: 0 }
    } else if (this.collapsed) {
      tabBounds = { x: GAP, y: GAP, width: w - GAP * 2, height: h - GAP * 2 }
      uiBounds = { x: 0, y: 0, width: this.peek ? PEEK_WIDTH : EDGE, height: h }
    } else {
      tabBounds = { x: SIDEBAR_WIDTH, y: GAP, width: w - SIDEBAR_WIDTH - GAP, height: h - GAP * 2 }
      uiBounds = { x: 0, y: 0, width: SIDEBAR_WIDTH, height: h }
    }
    tabBounds.width = Math.max(0, tabBounds.width)
    tabBounds.height = Math.max(0, tabBounds.height)
    for (const t of this.tabs) t.view.setBounds(tabBounds)
    this.ui.setBounds(uiBounds)
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

  sendState() {
    if (this.win.isDestroyed() || this.uiWc.isDestroyed()) return
    const active = this.activeTab?.view.webContents
    this.uiWc.send('state', {
      newTabUrl: C.NEWTAB_URL,
      activeId: this.activeId,
      bookmarked: active ? this.ctx.bookmarks.has(active.getURL()) : false,
      tabs: this.tabs.map((t) => {
        const wc = t.view.webContents
        return {
          id: t.id,
          url: wc.getURL(),
          title: wc.getTitle() || wc.getURL() || 'New Tab',
          favicon: t.favicon,
          loading: wc.isLoading(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          blocked: this.ctx.blockedCounts.get(t.id) || 0,
        }
      }),
    })
  }

  showContextMenu(wc, params) {
    const items = []
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.createTab(params.linkURL, { active: false }) },
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
        { label: `Search Google for “${q}”`, click: () => this.createTab(C.SEARCH_URL + encodeURIComponent(params.selectionText)) },
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
}

module.exports = { WindowController }
