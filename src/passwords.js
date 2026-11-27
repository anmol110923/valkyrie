// Saved logins, encrypted at rest with the OS keychain via Electron's safeStorage.
const crypto = require('crypto')
const { safeStorage } = require('electron')
const { readJson, writeJson } = require('./stores')

// "accounts.google.com" -> "google.com", "bbc.co.uk" -> "bbc.co.uk" (good-enough eTLD+1)
function baseDomain(host) {
  const parts = host.replace(/^www\./, '').split('.')
  if (parts.length <= 2) return parts.join('.')
  const sld = parts[parts.length - 2]
  const twoLevel = sld.length <= 3 && parts[parts.length - 1].length === 2 // co.uk, com.au, co.in ...
  return parts.slice(twoLevel ? -3 : -2).join('.')
}

function originOf(url) {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}

class Passwords {
  constructor(file) {
    this.file = file
    this.entries = readJson(file, [])
  }

  save() { writeJson(this.file, this.entries) }

  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available')
    return safeStorage.encryptString(text).toString('base64')
  }

  decrypt(b64) {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  }

  count() { return this.entries.length }

  list() {
    return this.entries
      .map(({ id, origin, username, updated }) => ({ id, origin, username, updated }))
      .sort((a, b) => a.origin.localeCompare(b.origin))
  }

  /** Logins usable on `origin`: same host first, then same site (e.g. accounts.google.com on mail.google.com). */
  matches(origin) {
    let host
    try { host = new URL(origin).hostname } catch { return [] }
    const site = baseDomain(host)
    return this.entries
      .filter((e) => { try { return baseDomain(new URL(e.origin).hostname) === site } catch { return false } })
      .map((e) => ({ id: e.id, username: e.username, origin: e.origin, exact: new URL(e.origin).hostname === host }))
      .sort((a, b) => Number(b.exact) - Number(a.exact))
  }

  /** Returns the login only if it belongs to the same site as `origin`. */
  reveal(id, origin = null) {
    const e = this.entries.find((x) => x.id === id)
    if (!e) return null
    if (origin && !this.matches(origin).some((m) => m.id === id)) return null
    return { username: e.username, password: this.decrypt(e.password) }
  }

  has(origin, username, password) {
    return this.entries.some((e) => e.origin === origin && e.username === username && this.decrypt(e.password) === password)
  }

  upsert({ origin, username, password }) {
    origin = originOf(origin)
    if (!origin || !password) return false
    const enc = this.encrypt(password)
    const existing = this.entries.find((e) => e.origin === origin && e.username === (username || ''))
    if (existing) {
      existing.password = enc
      existing.updated = Date.now()
    } else {
      this.entries.push({ id: crypto.randomUUID(), origin, username: username || '', password: enc, updated: Date.now() })
    }
    return true
  }

  add(login) {
    const ok = this.upsert(login)
    if (ok) this.save()
    return ok
  }

  importMany(logins) {
    let n = 0
    for (const l of logins) if (this.upsert(l)) n++
    this.save()
    return n
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.save()
  }
}

module.exports = { Passwords, originOf }
