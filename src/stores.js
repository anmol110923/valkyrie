// Small local stores: settings, bookmarks (JSON) and browsing history (SQLite).
const fs = require('fs')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

const isWeb = (url) => /^https?:\/\//i.test(url || '')

// ---------- settings ----------

const SETTINGS_DEFAULTS = {
  sidebarCollapsed: false,
  neverSavePasswords: [],
  theme: 'system', // system | light | dark
  searchEngine: 'google', // see SEARCH_ENGINES
  startup: 'restore', // restore | newtab
  autoArchiveHours: 12, // 0 = never
  adBlock: true,
  askDownloadLocation: false,
  idleSeconds: 60,
  dailyGoalMinutes: 180, // 0 = no goal
  newTabShowStats: true,
}

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  perplexity: { name: 'Perplexity', url: 'https://www.perplexity.ai/search?q=' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
}

class Settings {
  constructor(file) {
    this.file = file
    this.data = { ...SETTINGS_DEFAULTS, ...readJson(file, {}) }
    this.listeners = new Set()
  }
  get(key) { return this.data[key] }
  set(key, value) {
    this.data[key] = value
    writeJson(this.file, this.data)
    for (const fn of this.listeners) fn(key, value)
  }
  all() { return { ...this.data } }
  onChange(fn) { this.listeners.add(fn) }
  searchUrl() { return (SEARCH_ENGINES[this.data.searchEngine] || SEARCH_ENGINES.google).url }
}

// ---------- spaces, favorites & pinned (Arc-style) ----------
// spaces.json: { favorites: [{id,title,url}], spaces: [{id,name,icon,color,pinned:[tree]}] }
// Pinned tree nodes: { id, type: 'url' | 'folder', title, url?, children?, open? }

const SPACE_COLORS = ['violet', 'gold', 'rose', 'teal', 'blue', 'green', 'slate']

class Spaces {
  constructor(file) {
    this.file = file
    const data = readJson(file, null) || {}
    this.favorites = data.favorites || []
    this.spaces = data.spaces?.length ? data.spaces : [{ id: crypto.randomUUID(), name: 'Personal', icon: '✦', color: 'violet', pinned: [] }]
    this.listeners = new Set()
  }

  save() {
    writeJson(this.file, { favorites: this.favorites, spaces: this.spaces })
    for (const fn of this.listeners) fn()
  }

  onChange(fn) { this.listeners.add(fn) }
  get(id) { return this.spaces.find((s) => s.id === id) || this.spaces[0] }

  createSpace(name, color) {
    const used = new Set(this.spaces.map((s) => s.color))
    const space = {
      id: crypto.randomUUID(),
      name: (name || 'New Space').slice(0, 40),
      icon: ['✦', '◆', '●', '▲', '✿', '☾', '☀', '♪'][this.spaces.length % 8],
      color: color || SPACE_COLORS.find((c) => !used.has(c)) || 'violet',
      pinned: [],
    }
    this.spaces.push(space)
    this.save()
    return space
  }

  updateSpace(id, patch) {
    const s = this.spaces.find((x) => x.id === id)
    if (!s) return
    if (typeof patch.name === 'string') s.name = patch.name.slice(0, 40) || s.name
    if (typeof patch.icon === 'string') s.icon = [...patch.icon][0] || s.icon
    if (SPACE_COLORS.includes(patch.color)) s.color = patch.color
    this.save()
  }

  deleteSpace(id) {
    if (this.spaces.length <= 1) return false
    this.spaces = this.spaces.filter((s) => s.id !== id)
    this.save()
    return true
  }

  // --- tree helpers (work across all spaces) ---
  * walk(nodes, parent = null, space = null) {
    for (const node of nodes) {
      yield { node, parent, siblings: nodes, space }
      if (node.children) yield* this.walk(node.children, node, space)
    }
  }

  find(id) {
    for (const space of this.spaces) {
      for (const hit of this.walk(space.pinned, null, space)) if (hit.node.id === id) return hit
    }
    return null
  }

  pin(spaceId, { url, title }, parentId = null, index = -1) {
    const space = this.get(spaceId)
    const node = { id: crypto.randomUUID(), type: 'url', title: title || url, url }
    const list = parentId ? this.find(parentId)?.node.children : space.pinned
    if (!list) return null
    if (index < 0 || index > list.length) list.push(node)
    else list.splice(index, 0, node)
    this.save()
    return node
  }

  addFolder(spaceId, title = 'New Folder', parentId = null) {
    const space = this.get(spaceId)
    const node = { id: crypto.randomUUID(), type: 'folder', title, children: [], open: true }
    const list = parentId ? this.find(parentId)?.node.children : space.pinned
    if (!list) return null
    list.push(node)
    this.save()
    return node
  }

  /** Move a pinned node (or favorite) into a folder / the root of a space at an index. */
  move(id, spaceId, parentId = null, index = -1) {
    const hit = this.find(id)
    if (!hit) return false
    // can't drop a folder into itself or its descendants
    if (parentId && hit.node.type === 'folder') {
      for (const inner of this.walk(hit.node.children)) if (inner.node.id === parentId) return false
      if (parentId === id) return false
    }
    const target = parentId ? this.find(parentId)?.node.children : this.get(spaceId).pinned
    if (!target) return false
    const from = hit.siblings.indexOf(hit.node)
    hit.siblings.splice(from, 1)
    if (target === hit.siblings && index > from) index--
    if (index < 0 || index > target.length) target.push(hit.node)
    else target.splice(index, 0, hit.node)
    this.save()
    return true
  }

  rename(id, title) {
    const hit = this.find(id)
    const fav = this.favorites.find((f) => f.id === id)
    const node = hit?.node || fav
    if (!node || !title?.trim()) return
    node.title = title.trim().slice(0, 120)
    this.save()
  }

  setOpen(id, open) {
    const hit = this.find(id)
    if (hit?.node.type === 'folder') { hit.node.open = !!open; this.save() }
  }

  remove(id) {
    const hit = this.find(id)
    if (hit) {
      hit.siblings.splice(hit.siblings.indexOf(hit.node), 1)
      this.save()
      return true
    }
    const before = this.favorites.length
    this.favorites = this.favorites.filter((f) => f.id !== id)
    if (this.favorites.length !== before) { this.save(); return true }
    return false
  }

  addFavorite({ url, title }, index = -1) {
    if (this.favorites.some((f) => f.url === url)) return null
    const fav = { id: crypto.randomUUID(), title: title || url, url }
    if (index < 0 || index > this.favorites.length) this.favorites.push(fav)
    else this.favorites.splice(index, 0, fav)
    this.save()
    return fav
  }

  moveFavorite(id, index) {
    const from = this.favorites.findIndex((f) => f.id === id)
    if (from < 0) return
    const [fav] = this.favorites.splice(from, 1)
    this.favorites.splice(Math.max(0, Math.min(index > from ? index - 1 : index, this.favorites.length)), 0, fav)
    this.save()
  }

  /** The pinned item or favorite with this id (for opening its tab). */
  item(id) {
    return this.favorites.find((f) => f.id === id) || this.find(id)?.node || null
  }

  search(q, limit = 6) {
    const s = q.toLowerCase()
    const out = []
    for (const f of this.favorites) if (f.title.toLowerCase().includes(s) || f.url.toLowerCase().includes(s)) out.push({ ...f, kind: 'favorite' })
    for (const space of this.spaces) {
      for (const { node } of this.walk(space.pinned)) {
        if (node.type === 'url' && (node.title.toLowerCase().includes(s) || node.url.toLowerCase().includes(s))) out.push({ ...node, kind: 'pinned', space: space.name })
      }
    }
    return out.slice(0, limit)
  }
}

// ---------- archived tabs ----------

class Archive {
  constructor(file) {
    this.file = file
    this.items = readJson(file, [])
  }
  add(entries) {
    if (!entries.length) return
    this.items = [...entries.map((e) => ({ ...e, archivedAt: Date.now() })), ...this.items].slice(0, 300)
    writeJson(this.file, this.items)
  }
  list() { return this.items }
  clear() { this.items = []; writeJson(this.file, this.items) }
}

// ---------- bookmarks ----------
// Tree of { id, type: 'folder' | 'url', title, url?, children? } under a root folder.

class Bookmarks {
  constructor(file) {
    this.file = file
    this.root = readJson(file, null) || { id: 'root', type: 'folder', title: 'Bookmarks', children: [] }
    this.listeners = new Set()
  }

  save() {
    writeJson(this.file, this.root)
    for (const fn of this.listeners) fn()
  }

  onChange(fn) { this.listeners.add(fn) }

  * walk(node = this.root, parent = null) {
    yield { node, parent }
    for (const child of node.children || []) yield* this.walk(child, node)
  }

  findByUrl(url) {
    for (const { node, parent } of this.walk()) if (node.type === 'url' && node.url === url) return { node, parent }
    return null
  }

  has(url) { return !!this.findByUrl(url) }

  add(url, title, parent = this.root) {
    const node = { id: crypto.randomUUID(), type: 'url', title: title || url, url }
    parent.children.push(node)
    this.save()
    return node
  }

  remove(id) {
    for (const { node, parent } of this.walk()) {
      if (node.id === id && parent) {
        parent.children.splice(parent.children.indexOf(node), 1)
        this.save()
        return true
      }
    }
    return false
  }

  /** Bookmark or un-bookmark a page. Returns the new state. */
  toggle(url, title) {
    const found = this.findByUrl(url)
    if (found) {
      found.parent.children.splice(found.parent.children.indexOf(found.node), 1)
      this.save()
      return false
    }
    this.add(url, title)
    return true
  }

  count() {
    let n = 0
    for (const { node } of this.walk()) if (node.type === 'url') n++
    return n
  }

  search(q, limit = 4) {
    const s = q.toLowerCase()
    const out = []
    for (const { node } of this.walk()) {
      if (node.type !== 'url') continue
      if (node.url.toLowerCase().includes(s) || (node.title || '').toLowerCase().includes(s)) out.push(node)
      if (out.length >= limit) break
    }
    return out
  }

  /** Import a Chrome-style bookmark tree (bookmark_bar, other, synced). Skips URLs we already have. */
  importChrome(roots) {
    const known = new Set()
    for (const { node } of this.walk()) if (node.type === 'url') known.add(node.url)
    let added = 0
    const convert = (n) => {
      if (n.type === 'url') {
        if (!n.url || known.has(n.url)) return null
        known.add(n.url)
        added++
        return { id: crypto.randomUUID(), type: 'url', title: n.name || n.url, url: n.url }
      }
      const children = (n.children || []).map(convert).filter(Boolean)
      return children.length ? { id: crypto.randomUUID(), type: 'folder', title: n.name || 'Folder', children } : null
    }
    // Bookmarks-bar items go to the top level; other folders stay grouped.
    for (const child of roots.bookmark_bar?.children || []) {
      const c = convert(child)
      if (c) this.root.children.push(c)
    }
    for (const [key, label] of [['other', 'Other bookmarks'], ['synced', 'Mobile bookmarks']]) {
      if (!roots[key]?.children?.length) continue
      const folder = convert({ type: 'folder', name: label, children: roots[key].children })
      if (folder) this.root.children.push(folder)
    }
    this.save()
    return added
  }
}

// ---------- history ----------

class History {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS urls (
        url TEXT PRIMARY KEY,
        title TEXT,
        visit_count INTEGER NOT NULL DEFAULT 0,
        last_visit INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS urls_rank ON urls (visit_count DESC, last_visit DESC);
    `)
    this.upsert = this.db.prepare(`
      INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, 1, ?)
      ON CONFLICT(url) DO UPDATE SET
        visit_count = visit_count + 1,
        last_visit = excluded.last_visit,
        title = COALESCE(NULLIF(excluded.title, ''), title)`)
    this.titleStmt = this.db.prepare(`UPDATE urls SET title = ? WHERE url = ?`)
    this.searchStmt = this.db.prepare(`
      SELECT url, title FROM urls
      WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
      ORDER BY (url LIKE ? ESCAPE '\\') DESC, visit_count DESC, last_visit DESC
      LIMIT ?`)
    this.importStmt = this.db.prepare(`
      INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        visit_count = MAX(visit_count, excluded.visit_count),
        last_visit = MAX(last_visit, excluded.last_visit),
        title = COALESCE(NULLIF(title, ''), excluded.title)`)
  }

  record(url, title) {
    if (isWeb(url)) this.upsert.run(url, title || '', Date.now())
  }

  setTitle(url, title) {
    if (isWeb(url) && title) this.titleStmt.run(title, url)
  }

  search(q, limit = 6) {
    const esc = q.replace(/[\\%_]/g, (c) => '\\' + c)
    const any = `%${esc}%`
    // prefer matches at the start of the host
    return this.searchStmt.all(any, any, `%://${esc}%`, limit)
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM urls').get().n
  }

  importRows(rows) {
    this.db.exec('BEGIN')
    try {
      for (const r of rows) if (isWeb(r.url)) this.importStmt.run(r.url, r.title || '', r.visitCount || 1, r.lastVisit || 0)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return rows.length
  }

  clear() {
    this.db.exec('DELETE FROM urls')
  }
}

module.exports = { Settings, Bookmarks, History, Spaces, Archive, SEARCH_ENGINES, SPACE_COLORS, readJson, writeJson }
