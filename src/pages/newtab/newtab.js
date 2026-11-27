const $ = (id) => document.getElementById(id)
const api = window.valkyrie

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

// ---------- greeting + clock ----------

function tick() {
  const d = new Date()
  $('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const h = d.getHours()
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  $('greeting').replaceChildren(document.createTextNode(`${part}`), el('em', null, '.'))
  $('date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
tick()
setInterval(tick, 10000)

// ---------- search box: URLs open directly, text goes to the chosen engine ----------

let engineUrl = 'https://www.google.com/search?q='
$('search').addEventListener('submit', (e) => {
  e.preventDefault()
  const v = $('q').value.trim()
  if (!v) return
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || (!/\s/.test(v) && /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(v))
  location.href = looksLikeUrl ? (/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`) : engineUrl + encodeURIComponent(v)
})

// ---------- tiles ----------

function tile(url, title, favicon, fav) {
  const a = el('a', 'tile' + (fav ? ' fav' : ''))
  a.href = url
  a.title = title
  const ico = el('span', 'ico')
  ico.append(siteIcon(new URL(url).hostname.replace(/^www\./, ''), favicon))
  ico.firstChild.style.cssText = 'width:22px;height:22px'
  a.append(ico, el('span', null, title))
  return a
}

// ---------- dashboard ----------

const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null)

function stat(label, value, note, cls) {
  const d = el('div', 'stat')
  d.append(el('small', null, label), el('b', null, value))
  if (note) d.append(el('em', cls || null, note))
  return d
}

function renderStats(o) {
  const goal = (o.goalMinutes || 0) * 60
  const today = stat('Today', fmtDuration(o.today), goal ? `${Math.round((o.today / goal) * 100)}% of ${fmtDuration(goal)} goal` : o.yesterday ? `${fmtDuration(Math.abs(o.today - o.yesterday))} ${o.today >= o.yesterday ? 'more' : 'less'} than yesterday` : 'Have a good one')
  if (goal) {
    const bar = el('i', 'bar' + (o.today > goal ? ' over' : ''))
    bar.style.width = `${Math.min(100, (o.today / goal) * 100)}%`
    today.append(bar)
  }
  const wk = pct(o.week, o.lastWeek)
  $('stats').replaceChildren(
    today,
    stat('This week', fmtDuration(o.week), wk == null ? 'last 7 days' : `${wk > 0 ? '▲' : '▼'} ${Math.abs(wk)}% vs last week`, wk == null ? null : wk > 0 ? 'up' : 'down'),
    stat('Daily average', fmtDuration(o.avgPerDay), 'active days, last 30'),
    stat('Streak', `${o.streak} day${o.streak === 1 ? '' : 's'}`, o.best.total ? `best day ${fmtDuration(o.best.total)}` : 'days in a row'),
    stat('All time', fmtDuration(o.allTime), `${o.activeDays} active day${o.activeDays === 1 ? '' : 's'}`),
  )
}

const tip = $('tip')
function hoverTip(node, text) {
  node.addEventListener('mouseenter', () => {
    const r = node.getBoundingClientRect()
    tip.textContent = text
    tip.style.left = `${r.left + r.width / 2}px`
    tip.style.top = `${r.top}px`
    tip.hidden = false
  })
  node.addEventListener('mouseleave', () => { tip.hidden = true })
}

function level(v, max) {
  if (!v) return 0
  const r = v / max
  return r > 0.75 ? 4 : r > 0.45 ? 3 : r > 0.2 ? 2 : 1
}

function renderYear(days) {
  // GitHub-style: columns are weeks (Sun..Sat), last column holds today
  const today = days[days.length - 1].date
  const [ty, tm, td] = today.split('-').map(Number)
  const todayDow = new Date(ty, tm - 1, td).getDay()
  const cells = days.slice(-(52 * 7 + todayDow + 1))
  const max = Math.max(3600, ...cells.map((d) => d.total))
  const heat = $('heat')
  const months = $('heat-months')
  const frag = []
  const monthLabels = []
  let lastMonth = -1
  cells.forEach((d, i) => {
    const [y, m, dd] = d.date.split('-').map(Number)
    const date = new Date(y, m - 1, dd)
    const cell = el('i', `l${level(d.total, max)}`)
    if (d.date === today) cell.classList.add('today')
    hoverTip(cell, `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.total ? fmtDuration(d.total) : 'no browsing'}`)
    frag.push(cell)
    const col = Math.floor(i / 7)
    if (date.getDate() <= 7 && date.getMonth() !== lastMonth && date.getDay() === 0) {
      lastMonth = date.getMonth()
      monthLabels.push([col, date.toLocaleDateString([], { month: 'short' })])
    }
  })
  for (let i = 0; i < 6 - todayDow; i++) frag.push(el('i', 'future'))
  heat.replaceChildren(...frag)
  months.replaceChildren(...monthLabels.map(([col, label]) => { const s = el('span', null, label); s.style.left = `${col * 16}px`; return s }))
  const yearTotal = cells.reduce((a, d) => a + d.total, 0)
  $('year-total').textContent = `${fmtDuration(yearTotal)} in the last year`
  heat.parentElement.scrollLeft = heat.scrollWidth
}

function renderHourWeek(hw) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const order = [1, 2, 3, 4, 5, 6, 0]
  const max = Math.max(600, ...hw.flat())
  const frag = []
  for (const d of order) {
    frag.push(el('span', null, names[d]))
    hw[d].forEach((v, h) => {
      const c = el('i', `l${level(v, max)}`)
      hoverTip(c, `${names[d]} ${String(h).padStart(2, '0')}:00 · ${v ? fmtDuration(v) : '—'}`)
      frag.push(c)
    })
  }
  $('hourweek').replaceChildren(...frag)
}

function renderSites(list) {
  const top = list.filter((s) => s.seconds > 0).slice(0, 8)
  $('sites-empty').hidden = top.length > 0
  const max = top[0]?.seconds || 1
  $('sites').replaceChildren(...top.map((s) => {
    const a = el('a', 'site')
    a.href = `https://${s.domain}/`
    const track = el('span', 'track')
    const fill = el('span', 'fill')
    fill.style.width = `${(s.seconds / max) * 100}%`
    fill.style.display = 'block'
    track.append(fill)
    a.append(siteIcon(s.domain, s.favicon), el('span', 'name', s.domain), track, el('span', 'time', fmtDuration(s.seconds)))
    return a
  }))
}

function pageRow(p, right, favicons) {
  const a = el('a', 'page')
  a.href = p.url
  a.title = p.url
  const t = el('span', 't')
  t.append(el('b', null, p.title || p.url), el('small', null, p.domain))
  a.append(siteIcon(p.domain, p.favicon || favicons[p.domain]), t, el('span', 'r', right))
  return a
}

async function load() {
  if (!api) return
  const o = await api.overview()
  engineUrl = o.searchEngine.url
  $('q').placeholder = `Search ${o.searchEngine.name} or type a URL`

  const favicons = Object.fromEntries(o.topDomains.map((d) => [d.domain, d.favicon]))
  const favs = o.favorites.slice(0, 8).map((f) => tile(f.url, f.title, f.favicon, true))
  const favHosts = new Set(o.favorites.map((f) => { try { return new URL(f.url).hostname.replace(/^www\./, '') } catch { return '' } }))
  const tops = o.topDomains.filter((d) => !favHosts.has(d.domain)).slice(0, 8 - favs.length).map((d) => tile(`https://${d.domain}/`, d.domain, d.favicon, false))
  $('tiles').replaceChildren(...favs, ...tops)

  $('stats-block').hidden = !o.showStats
  if (!o.showStats) return
  renderStats(o)
  renderYear(o.days)
  renderHourWeek(o.hourWeek)
  renderSites(o.topDomains)

  $('pages-empty').hidden = o.topPages.length > 0
  $('pages').replaceChildren(...o.topPages.slice(0, 7).map((p) => pageRow(p, `${fmtDuration(p.seconds)} · ${p.visits}×`, favicons)))
  $('recent-empty').hidden = o.recent.length > 0
  $('recent').replaceChildren(...o.recent.slice(0, 7).map((p) => pageRow(p, new Date(p.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), favicons)))

  const info = await api.info()
  $('import-link').hidden = !!(info.bookmarks || info.passwords)
}

load()
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load() })
