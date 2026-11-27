// Import data from Chromium-based browsers (Chrome, Brave, Arc, Edge, Vivaldi, Chromium).
//
// Bookmarks, history and extensions are plain files. Passwords and cookies are
// encrypted with a key kept in the macOS Keychain ("Chrome Safe Storage" etc.);
// reading it makes macOS ask the user for permission.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { DatabaseSync } = require('node:sqlite')

const HOME = os.homedir()
const MAC_SUPPORT = path.join(HOME, 'Library', 'Application Support')
const WIN_LOCAL = process.env.LOCALAPPDATA || ''

const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', mac: 'Google/Chrome', win: 'Google/Chrome/User Data', linux: '.config/google-chrome', keychain: 'Chrome Safe Storage' },
  { id: 'brave', name: 'Brave', mac: 'BraveSoftware/Brave-Browser', win: 'BraveSoftware/Brave-Browser/User Data', linux: '.config/BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { id: 'arc', name: 'Arc', mac: 'Arc/User Data', win: null, linux: null, keychain: 'Arc Safe Storage' },
  { id: 'edge', name: 'Microsoft Edge', mac: 'Microsoft Edge', win: 'Microsoft/Edge/User Data', linux: '.config/microsoft-edge', keychain: 'Microsoft Edge Safe Storage' },
  { id: 'vivaldi', name: 'Vivaldi', mac: 'Vivaldi', win: 'Vivaldi/User Data', linux: '.config/vivaldi', keychain: 'Vivaldi Safe Storage' },
  { id: 'chromium', name: 'Chromium', mac: 'Chromium', win: 'Chromium/User Data', linux: '.config/chromium', keychain: 'Chromium Safe Storage' },
]

function userDataDir(b) {
  if (process.platform === 'darwin') return b.mac && path.join(MAC_SUPPORT, b.mac)
  if (process.platform === 'win32') return b.win && path.join(WIN_LOCAL, b.win)
  return b.linux && path.join(HOME, b.linux)
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

/** Installed browsers and their profiles: [{ id, name, profiles: [{ dir, name }] }] */
function listBrowsers() {
  const out = []
  for (const b of BROWSERS) {
    const root = userDataDir(b)
    if (!root || !fs.existsSync(root)) continue
    const info = readJson(path.join(root, 'Local State'))?.profile?.info_cache || {}
    let dirs = Object.keys(info)
    if (!dirs.length) dirs = fs.readdirSync(root).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    const profiles = dirs
      .filter((d) => fs.existsSync(path.join(root, d)))
      .map((d) => ({ dir: d, name: info[d]?.name || d }))
    if (profiles.length) out.push({ id: b.id, name: b.name, profiles })
  }
  return out
}

function profilePath(browserId, profileDir) {
  const b = BROWSERS.find((x) => x.id === browserId)
  if (!b) throw new Error('Unknown browser')
  if (!/^(Default|Profile \d+|[\w .-]+)$/.test(profileDir) || profileDir.includes('..')) throw new Error('Bad profile')
  const dir = path.join(userDataDir(b), profileDir)
  if (!fs.existsSync(dir)) throw new Error('Profile not found')
  return { browser: b, dir }
}

/** Open a copy of a (possibly locked, in-use) SQLite file. */
function openCopy(file) {
  if (!fs.existsSync(file)) return null
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'valkyrie-import-'))
  const copy = path.join(tmp, 'db')
  fs.copyFileSync(file, copy)
  for (const ext of ['-wal', '-journal']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext)
  const db = new DatabaseSync(copy)
  return { db, cleanup: () => { try { db.close() } catch {} fs.rmSync(tmp, { recursive: true, force: true }) } }
}

// Chrome timestamps are microseconds since 1601-01-01 — too big for a JS number, so the
// queries divide in SQL first. These convert the reduced values to Unix time.
const EPOCH_DIFF_S = 11644473600
const msSince1601ToUnixMs = (t) => (t ? Number(t) - EPOCH_DIFF_S * 1000 : 0)
const sSince1601ToUnixS = (t) => (t ? Number(t) - EPOCH_DIFF_S : 0)

// ---------- plain data ----------

function readBookmarks(dir) {
  return readJson(path.join(dir, 'Bookmarks'))?.roots || null
}

function readHistory(dir, limit = 100000) {
  const h = openCopy(path.join(dir, 'History'))
  if (!h) return []
  try {
    return h.db.prepare(
      `SELECT url, title, visit_count AS visitCount, CAST(last_visit_time / 1000 AS INTEGER) AS t
       FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?`,
    ).all(limit).map((r) => ({ url: r.url, title: r.title, visitCount: Number(r.visitCount), lastVisit: msSince1601ToUnixMs(r.t) }))
  } finally {
    h.cleanup()
  }
}

/** Chrome Web Store extension ids installed in the profile. */
function readExtensionIds(dir) {
  const settings = {
    ...(readJson(path.join(dir, 'Preferences'))?.extensions?.settings || {}),
    ...(readJson(path.join(dir, 'Secure Preferences'))?.extensions?.settings || {}),
  }
  return Object.entries(settings)
    .filter(([id, s]) => /^[a-p]{32}$/.test(id) && s && (s.location === 1 || s.from_webstore) && !s.was_installed_by_default)
    .map(([id]) => id)
}

// ---------- encrypted data (macOS) ----------

function getMacKey(service) {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-w', '-s', service], (err, stdout) => {
      if (err) return reject(new Error(`Keychain access to "${service}" was denied or not found`))
      resolve(crypto.pbkdf2Sync(stdout.trim(), 'saltysalt', 1003, 16, 'sha1'))
    })
  })
}

function decryptValue(buf, key) {
  if (!buf || !buf.length) return null
  const b = Buffer.from(buf)
  const prefix = b.subarray(0, 3).toString()
  if (prefix !== 'v10' && prefix !== 'v11') return b.toString('utf8') // stored unencrypted
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([decipher.update(b.subarray(3)), decipher.final()])
}

function readPasswords(dir, key) {
  const h = openCopy(path.join(dir, 'Login Data'))
  if (!h) return []
  try {
    const rows = h.db.prepare(
      `SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0`,
    ).all()
    const out = []
    for (const r of rows) {
      if (!/^https?:\/\//.test(r.origin_url)) continue
      try {
        const pw = decryptValue(r.password_value, key)
        if (pw && pw.length) out.push({ origin: r.origin_url, username: r.username_value, password: pw.toString('utf8') })
      } catch { /* skip undecryptable entry */ }
    }
    return out
  } finally {
    h.cleanup()
  }
}

function readCookies(dir, key) {
  const file = [path.join(dir, 'Network', 'Cookies'), path.join(dir, 'Cookies')].find((f) => fs.existsSync(f))
  const h = file && openCopy(file)
  if (!h) return []
  try {
    const version = Number(h.db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get()?.value || 0)
    const rows = h.db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc / 1000000 AS INTEGER) AS expires_s,
              has_expires, is_secure, is_httponly, samesite FROM cookies`,
    ).all()
    const now = Date.now() / 1000
    const out = []
    for (const r of rows) {
      let value = r.value
      if (!value && r.encrypted_value?.length) {
        try {
          let buf = decryptValue(r.encrypted_value, key)
          if (version >= 24) buf = buf.subarray(32) // newer Chrome prefixes SHA-256(domain)
          value = buf.toString('utf8')
        } catch { continue }
      }
      const expires = r.has_expires ? sSince1601ToUnixS(r.expires_s) : undefined
      if (expires && expires < now) continue
      out.push({
        host: r.host_key, name: r.name, value: value ?? '', path: r.path || '/', expires,
        secure: !!r.is_secure, httpOnly: !!r.is_httponly, sameSite: r.samesite,
      })
    }
    return out
  } finally {
    h.cleanup()
  }
}

const SAME_SITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' }

async function applyCookies(ses, cookies) {
  let n = 0
  for (const c of cookies) {
    const host = c.host.replace(/^\./, '')
    const details = {
      url: `${c.secure ? 'https' : 'http'}://${host}${c.path}`,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    }
    if (c.host.startsWith('.') && !c.name.startsWith('__Host-')) details.domain = c.host
    if (c.expires) details.expirationDate = c.expires
    if (SAME_SITE[c.sameSite]) details.sameSite = SAME_SITE[c.sameSite]
    if (details.sameSite === 'no_restriction') details.secure = true
    try { await ses.cookies.set(details); n++ } catch { /* invalid or rejected cookie */ }
  }
  await ses.cookies.flushStore()
  return n
}

/**
 * Run an import. `what` = { bookmarks, history, passwords, cookies, extensions }.
 * `targets` = { bookmarks, history, passwords, session, installExtension }.
 */
async function runImport({ browser, profile, what }, targets) {
  const { browser: b, dir } = profilePath(browser, profile)
  const report = { browser: b.name }
  const errors = []

  if (what.bookmarks) {
    try {
      const roots = readBookmarks(dir)
      report.bookmarks = roots ? targets.bookmarks.importChrome(roots) : 0
    } catch (e) { errors.push(`Bookmarks: ${e.message}`) }
  }

  if (what.history) {
    try { report.history = targets.history.importRows(readHistory(dir)) } catch (e) { errors.push(`History: ${e.message}`) }
  }

  if (what.passwords || what.cookies) {
    if (process.platform !== 'darwin') {
      errors.push('Passwords and cookies can only be imported on macOS for now.')
    } else {
      let key = null
      try { key = await getMacKey(b.keychain) } catch (e) { errors.push(e.message) }
      if (key) {
        if (what.passwords) {
          try { report.passwords = targets.passwords.importMany(readPasswords(dir, key)) } catch (e) { errors.push(`Passwords: ${e.message}`) }
        }
        if (what.cookies) {
          try { report.cookies = await applyCookies(targets.session, readCookies(dir, key)) } catch (e) { errors.push(`Cookies: ${e.message}`) }
        }
      }
    }
  }

  if (what.extensions) {
    const ids = readExtensionIds(dir)
    const installed = new Set(targets.session.extensions.getAllExtensions().map((e) => e.id))
    let n = 0
    for (const id of ids) {
      if (installed.has(id)) continue
      try { await targets.installExtension(id); n++ } catch { /* removed from store, etc. */ }
    }
    report.extensions = n
  }

  report.errors = errors
  return report
}

module.exports = { listBrowsers, runImport, readBookmarks, readHistory, readExtensionIds, decryptValue }
