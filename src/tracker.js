// Local activity tracker ("footprint"). Everything stays on disk in
// <userData>/wellbeing/YYYY-MM-DD.json — nothing is ever sent anywhere.
//
// A second of time is counted for a tab when it is either
//   - the active tab of the focused window and the user is not idle, or
//   - playing audio (e.g. a YouTube video running while you do something else).
//
// Day file shape:
// {
//   date: '2026-11-27',
//   total: 7260,                         // seconds of attended browsing that day
//   hours: [0, 0, ..., 1800, ...],       // 24 buckets of seconds
//   domains: { 'youtube.com': { seconds, visits, favicon } },
//   visits: [{ url, title, domain, start, seconds, audible }]   // every page you opened
// }

const fs = require('fs')
const path = require('path')

const IGNORED_PROTOCOLS = new Set(['valkyrie:', 'file:', 'about:', 'chrome:', 'chrome-extension:', 'devtools:', 'data:', 'blob:'])

function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function domainOf(url) {
  try {
    const u = new URL(url)
    if (IGNORED_PROTOCOLS.has(u.protocol) || !u.hostname) return null
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function samePath(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.pathname === y.pathname && x.searchParams.get('v') === y.searchParams.get('v')
  } catch {
    return false
  }
}

function emptyDay(date) {
  return { date, total: 0, hours: new Array(24).fill(0), domains: {}, visits: [] }
}

class Tracker {
  constructor(dir) {
    this.dir = dir
    this.settingsFile = path.join(dir, 'settings.json')
    this.days = new Map()
    this.dirty = new Set()
    fs.mkdirSync(dir, { recursive: true })
    try {
      this.settings = { enabled: true, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) }
    } catch {
      this.settings = { enabled: true }
    }
  }

  // ----- storage -----

  file(date) {
    return path.join(this.dir, `${date}.json`)
  }

  getDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date')
    if (this.days.has(date)) return this.days.get(date)
    let day
    try {
      day = { ...emptyDay(date), ...JSON.parse(fs.readFileSync(this.file(date), 'utf8')) }
    } catch {
      day = emptyDay(date)
    }
    this.days.set(date, day)
    return day
  }

  readDayFile(date) {
    if (this.days.has(date)) return this.days.get(date)
    try { return { ...emptyDay(date), ...JSON.parse(fs.readFileSync(this.file(date), 'utf8')) } } catch { return null }
  }

  // ----- summary index (fast history for the dashboard) -----
  // index.json: { 'YYYY-MM-DD': { total, hours[24], domains: { domain: seconds } (top 15), favicons: {...} } }

  summarize(day) {
    const top = Object.entries(day.domains).sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 15)
    return {
      total: day.total,
      hours: day.hours,
      domains: Object.fromEntries(top.map(([d, v]) => [d, v.seconds])),
      favicons: Object.fromEntries(top.filter(([, v]) => v.favicon).map(([d, v]) => [d, v.favicon])),
    }
  }

  loadIndex() {
    if (this.index) return this.index
    const file = path.join(this.dir, 'index.json')
    try { this.index = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { this.index = {} }
    let changed = false
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
      if (!m || this.index[m[1]]) continue
      const day = this.readDayFile(m[1])
      if (day) { this.index[m[1]] = this.summarize(day); changed = true }
    }
    if (changed) this.saveIndex()
    return this.index
  }

  saveIndex() {
    if (!this.index) return
    const file = path.join(this.dir, 'index.json')
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.index))
    fs.renameSync(file + '.tmp', file)
  }

  /** Everything the new-tab dashboard needs, computed from the index (cheap). */
  overview() {
    const idx = this.loadIndex()
    const today = dayKey()
    idx[today] = this.summarize(this.getDay(today))
    const dateAt = (back) => dayKey(Date.now() - back * 86400000)
    const days = []
    for (let i = 370; i >= 0; i--) { const d = dateAt(i); days.push({ date: d, total: idx[d]?.total || 0 }) }

    const sumRange = (n) => { let s = 0; for (let i = 0; i < n; i++) s += idx[dateAt(i)]?.total || 0; return s }
    const hourWeek = Array.from({ length: 7 }, () => new Array(24).fill(0))
    for (let i = 0; i < 90; i++) {
      const d = dateAt(i)
      const e = idx[d]
      if (!e) continue
      const [y, m, dd] = d.split('-').map(Number)
      const wd = new Date(y, m - 1, dd).getDay()
      e.hours.forEach((s, h) => { hourWeek[wd][h] += s })
    }
    const domainTotals = {}
    const favicons = {}
    for (let i = 0; i < 30; i++) {
      const e = idx[dateAt(i)]
      if (!e) continue
      for (const [d, s] of Object.entries(e.domains)) domainTotals[d] = (domainTotals[d] || 0) + s
      Object.assign(favicons, e.favicons)
    }
    const topDomains = Object.entries(domainTotals).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([domain, seconds]) => ({ domain, seconds, favicon: favicons[domain] || null }))

    let allTime = 0
    let activeDays = 0
    let best = { date: null, total: 0 }
    for (const [d, e] of Object.entries(idx)) {
      allTime += e.total
      if (e.total >= 60) activeDays++
      if (e.total > best.total) best = { date: d, total: e.total }
    }
    let streak = 0
    for (let i = (idx[today]?.total >= 60 ? 0 : 1); ; i++) {
      if ((idx[dateAt(i)]?.total || 0) >= 60) streak++
      else break
    }
    const active30 = Array.from({ length: 30 }, (_, i) => idx[dateAt(i)]?.total || 0).filter((t) => t >= 60)

    return {
      today: idx[today].total,
      todayHours: idx[today].hours,
      yesterday: idx[dateAt(1)]?.total || 0,
      week: sumRange(7),
      lastWeek: sumRange(14) - sumRange(7),
      month: sumRange(30),
      allTime,
      activeDays,
      avgPerDay: active30.length ? Math.round(active30.reduce((a, b) => a + b, 0) / active30.length) : 0,
      streak,
      best,
      days,
      hourWeek,
      topDomains,
      topPages: this.topPages(),
      recent: this.getDay(today).visits.slice(-8).reverse().map(({ url, title, domain, start, seconds }) => ({ url, title, domain, start, seconds, favicon: favicons[domain] || null })),
    }
  }

  /** Most-used pages over the last 30 days (reads day files, cached for 2 minutes). */
  topPages() {
    if (this.pagesCache && Date.now() - this.pagesCache.at < 120000) return this.pagesCache.list
    const pages = new Map()
    for (let i = 0; i < 30; i++) {
      const day = this.readDayFile(dayKey(Date.now() - i * 86400000))
      if (!day) continue
      for (const v of day.visits) {
        const key = v.url.split('#')[0]
        const p = pages.get(key) || { url: key, title: v.title, domain: v.domain, seconds: 0, visits: 0 }
        p.seconds += v.seconds
        p.visits += 1
        if (v.title && v.title !== v.url) p.title = v.title
        pages.set(key, p)
      }
    }
    const list = [...pages.values()].sort((a, b) => b.seconds - a.seconds || b.visits - a.visits).slice(0, 12)
    this.pagesCache = { at: Date.now(), list }
    return list
  }

  flush() {
    for (const date of this.dirty) {
      const day = this.days.get(date)
      if (!day) continue
      const tmp = this.file(date) + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(day))
      fs.renameSync(tmp, this.file(date))
      if (this.index) this.index[date] = this.summarize(day)
    }
    if (this.dirty.size) this.saveIndex()
    this.dirty.clear()
    // keep only today + yesterday cached
    const keep = new Set([dayKey(), dayKey(Date.now() - 86400000)])
    for (const date of this.days.keys()) if (!keep.has(date)) this.days.delete(date)
  }

  // ----- recording -----

  /** Called when a tab commits a new URL (including in-page navigations like YouTube videos). */
  startVisit(tab, url, title) {
    tab.prevVisit = tab.visit
    tab.visit = null
    if (!this.settings.enabled) return
    const domain = domainOf(url)
    if (!domain) return
    // In-page navigations that only change the hash aren't new visits.
    if (tab.lastUrl && tab.lastUrl.split('#')[0] === url.split('#')[0]) {
      tab.lastUrl = url
      return this.resumeVisit(tab)
    }
    // Same page re-written by a redirect within a few seconds (e.g. YouTube's
    // ?themeRefresh=1 bounce) — keep it as one visit instead of several.
    const prev = tab.visit || tab.prevVisit
    if (prev && prev.domain === domain && Date.now() - prev.start < 5000 && samePath(prev.url, url)) {
      prev.url = url
      if (title) prev.title = title
      tab.visit = prev
      tab.lastUrl = url
      this.dirty.add(tab.visitDate)
      return
    }
    tab.lastUrl = url
    const date = dayKey()
    const day = this.getDay(date)
    const visit = { url, title: title || url, domain, start: Date.now(), seconds: 0 }
    day.visits.push(visit)
    const d = (day.domains[domain] ||= { seconds: 0, visits: 0, favicon: null })
    d.visits += 1
    tab.visit = visit
    tab.visitDate = date
    this.dirty.add(date)
  }

  resumeVisit(tab) {
    const date = dayKey()
    const day = this.getDay(date)
    const last = [...day.visits].reverse().find((v) => v.url.split('#')[0] === tab.lastUrl.split('#')[0])
    if (last) { tab.visit = last; tab.visitDate = date }
  }

  setTitle(tab, title) {
    if (!tab.visit || !title) return
    tab.visit.title = title
    this.dirty.add(tab.visitDate)
  }

  setFavicon(url, favicon) {
    const domain = domainOf(url)
    if (!domain || !favicon || !this.settings.enabled) return
    const date = dayKey()
    const d = this.getDay(date).domains[domain]
    if (d && d.favicon !== favicon) { d.favicon = favicon; this.dirty.add(date) }
  }

  /** Add one second to each attended tab. `entries` = [{ tab, audible }] */
  tick(entries) {
    if (!this.settings.enabled || !entries.length) return
    const now = Date.now()
    const date = dayKey(now)
    const hour = new Date(now).getHours()
    const day = this.getDay(date)
    let counted = false
    for (const { tab, audible } of entries) {
      if (!tab.visit) continue
      // crossed midnight: continue the same page as a new visit on the new day
      if (tab.visitDate !== date) {
        const { url, title } = tab.visit
        tab.lastUrl = null
        this.startVisit(tab, url, title)
        if (!tab.visit) continue
      }
      tab.visit.seconds += 1
      if (audible) tab.visit.audible = true
      const d = (day.domains[tab.visit.domain] ||= { seconds: 0, visits: 0, favicon: null })
      d.seconds += 1
      counted = true
    }
    // Wall-clock screen time: one second total even if two tabs count at once.
    if (counted) {
      day.total += 1
      day.hours[hour] += 1
      this.dirty.add(date)
    }
  }

  // ----- queries -----

  summary(date) {
    const day = this.getDay(date)
    const top = Object.entries(day.domains)
      .map(([domain, d]) => ({ domain, ...d }))
      .sort((a, b) => b.seconds - a.seconds)
    return { date, total: day.total, hours: day.hours, top, visitCount: day.visits.length }
  }

  day(date) {
    return { ...this.summary(date), visits: this.getDay(date).visits }
  }

  range(dates) {
    return dates.map((d) => this.summary(d))
  }

  clear(date) {
    if (date === 'all') {
      for (const f of fs.readdirSync(this.dir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) fs.rmSync(path.join(this.dir, f))
      this.days.clear()
    } else {
      this.getDay(date)
      this.days.set(date, emptyDay(date))
      fs.rmSync(this.file(date), { force: true })
    }
    this.dirty.clear()
    this.loadIndex()
    if (date === 'all') this.index = {}
    else delete this.index[date]
    this.saveIndex()
    this.pagesCache = null
  }

  setEnabled(enabled) {
    this.settings.enabled = !!enabled
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings))
  }
}

module.exports = { Tracker, dayKey, domainOf }
