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

class Settings {
  constructor(file) {
    this.file = file
    this.data = { sidebarCollapsed: false, neverSavePasswords: [], ...readJson(file, {}) }
  }
  get(key) { return this.data[key] }
  set(key, value) { this.data[key] = value; writeJson(this.file, this.data) }
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

module.exports = { Settings, Bookmarks, History, readJson, writeJson }
