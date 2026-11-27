const $ = (id) => document.getElementById(id)
const api = window.valkyrie

let range = 'day'
let date = dayKey()
let currentVisits = []

const addDays = (key, n) => { const d = parseDay(key); d.setDate(d.getDate() + n); return dayKey(d) }
const isToday = (key) => key === dayKey()

function weekDates(end) {
  return Array.from({ length: 7 }, (_, i) => addDays(end, i - 6))
}

function label() {
  const fmt = (k, opts) => parseDay(k).toLocaleDateString([], opts)
  if (range === 'day') {
    if (isToday(date)) return 'Today'
    if (date === addDays(dayKey(), -1)) return 'Yesterday'
    return fmt(date, { weekday: 'short', month: 'short', day: 'numeric' })
  }
  const start = addDays(date, -6)
  return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(date, { month: 'short', day: 'numeric' })}`
}

// ---------- rendering ----------

function renderStats(total, domains, pages, compareText) {
  $('s-total').textContent = fmtDuration(total)
  $('s-compare').textContent = compareText || ''
  $('s-sites').textContent = domains.filter((d) => d.seconds > 0 || d.visits > 0).length
  $('s-pages').textContent = pages
  const top = domains[0]
  $('s-top').textContent = top && top.seconds > 0 ? `${top.domain} · ${fmtDuration(top.seconds)}` : '–'
}

function renderChart(values, ticks, currentIndex, title) {
  $('chart-title').textContent = title
  const max = Math.max(60, ...values)
  const chart = $('chart')
  chart.replaceChildren(...values.map((v, i) => {
    const col = document.createElement('div')
    col.className = 'bar-col' + (i === currentIndex ? ' current' : '')
    col.title = `${ticks.full[i]} — ${fmtDuration(v)}`
    const bar = document.createElement('div')
    bar.className = 'bar' + (v === 0 ? ' zero' : '')
    bar.style.height = `${Math.max(1.5, (v / max) * 100)}%`
    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.textContent = ticks.short[i]
    col.append(bar, tick)
    return col
  }))
}

function renderSites(domains) {
  const list = domains.filter((d) => d.seconds > 0)
  const max = list[0]?.seconds || 1
  $('sites-empty').hidden = list.length > 0
  $('sites').replaceChildren(...list.slice(0, 25).map((d) => {
    const li = document.createElement('li')
    li.className = 'site'
    const name = document.createElement('a')
    name.className = 'name'
    name.textContent = d.domain
    name.href = `https://${d.domain}/`
    name.style.color = 'inherit'
    name.style.textDecoration = 'none'
    const track = document.createElement('div')
    track.className = 'track'
    const fill = document.createElement('div')
    fill.className = 'fill'
    fill.style.width = `${(d.seconds / max) * 100}%`
    track.append(fill)
    const time = document.createElement('span')
    time.className = 'time'
    time.textContent = fmtDuration(d.seconds)
    const visits = document.createElement('span')
    visits.className = 'visits'
    visits.textContent = `${d.visits} visit${d.visits === 1 ? '' : 's'}`
    li.append(siteIcon(d.domain, d.favicon), name, track, time, visits)
    return li
  }))
}

function renderVisits(visits, faviconByDomain) {
  const q = $('search').value.trim().toLowerCase()
  const rows = visits
    .filter((v) => !q || v.title?.toLowerCase().includes(q) || v.url.toLowerCase().includes(q))
    .slice()
    .reverse()
    .slice(0, 1000)
  $('visits-empty').hidden = rows.length > 0
  $('visits').replaceChildren(...rows.map((v) => {
    const tr = document.createElement('tr')
    const when = document.createElement('td')
    when.className = 'when'
    when.textContent = new Date(v.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    const pageTd = document.createElement('td')
    const page = document.createElement('div')
    page.className = 'page'
    const text = document.createElement('div')
    text.className = 'page-text'
    const a = document.createElement('a')
    a.href = v.url
    a.textContent = v.title || v.url
    a.title = v.url
    const dom = document.createElement('div')
    dom.className = 'dom'
    dom.textContent = v.domain
    if (v.audible) {
      const b = document.createElement('span')
      b.className = 'badge'
      b.textContent = '♪ played media'
      dom.append(b)
    }
    text.append(a, dom)
    page.append(siteIcon(v.domain, faviconByDomain[v.domain]), text)
    pageTd.append(page)

    const spent = document.createElement('td')
    spent.className = 'num'
    spent.textContent = v.seconds ? fmtDuration(v.seconds) : '–'
    tr.append(when, pageTd, spent)
    return tr
  }))
}

// ---------- loading ----------

async function load() {
  $('date-label').textContent = label()
  $('next').disabled = isToday(date)
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.range === range))
  $('footprint-card').hidden = range !== 'day'
  $('clear-day').textContent = range === 'day' ? 'Delete this day' : 'Delete this week'

  if (range === 'day') {
    const [day, prev] = await Promise.all([api.day(date), api.day(addDays(date, -1))])
    const diff = day.total - prev.total
    const compare = prev.total > 0 && day.total > 0
      ? `${fmtDuration(Math.abs(diff))} ${diff >= 0 ? 'more' : 'less'} than the day before`
      : ''
    renderStats(day.total, day.top, day.visitCount, compare)
    const hours = Array.from({ length: 24 }, (_, h) => h)
    renderChart(
      day.hours,
      {
        short: hours.map((h) => (h % 6 === 0 ? (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`) : '')),
        full: hours.map((h) => `${String(h).padStart(2, '0')}:00`),
      },
      isToday(date) ? new Date().getHours() : -1,
      'Activity by hour',
    )
    renderSites(day.top)
    currentVisits = day.visits
    const favicons = Object.fromEntries(day.top.map((d) => [d.domain, d.favicon]))
    renderVisits(currentVisits, favicons)
    $('search').oninput = () => renderVisits(currentVisits, favicons)
  } else {
    const dates = weekDates(date)
    const days = await api.range(dates)
    const merged = {}
    let total = 0
    let pages = 0
    for (const d of days) {
      total += d.total
      pages += d.visitCount
      for (const t of d.top) {
        const m = (merged[t.domain] ||= { domain: t.domain, seconds: 0, visits: 0, favicon: t.favicon })
        m.seconds += t.seconds
        m.visits += t.visits
        m.favicon = t.favicon || m.favicon
      }
    }
    const domains = Object.values(merged).sort((a, b) => b.seconds - a.seconds)
    const activeDays = days.filter((d) => d.total > 0).length
    renderStats(total, domains, pages, activeDays ? `avg ${fmtDuration(total / activeDays)} per active day` : '')
    renderChart(
      days.map((d) => d.total),
      {
        short: dates.map((k) => parseDay(k).toLocaleDateString([], { weekday: 'short' })),
        full: dates.map((k) => parseDay(k).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })),
      },
      dates.indexOf(dayKey()),
      'Screen time by day',
    )
    renderSites(domains)
  }
}

async function loadSettings() {
  const s = await api.settings()
  $('enabled').checked = s.enabled
  $('data-path').textContent = `Saved locally in ${s.dataDir}`
}

// ---------- events ----------

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { range = b.dataset.range; load() }))
$('prev').addEventListener('click', () => { date = addDays(date, range === 'day' ? -1 : -7); load() })
$('next').addEventListener('click', () => {
  const next = addDays(date, range === 'day' ? 1 : 7)
  date = next > dayKey() ? dayKey() : next
  load()
})
$('enabled').addEventListener('change', async (e) => { await api.setEnabled(e.target.checked) })
$('clear-day').addEventListener('click', async () => {
  const dates = range === 'day' ? [date] : weekDates(date)
  if (!confirm(`Permanently delete activity for ${label()}? This can't be undone.`)) return
  for (const d of dates) await api.clear(d)
  load()
})
$('clear-all').addEventListener('click', async () => {
  if (!confirm('Permanently delete ALL recorded activity? This can\'t be undone.')) return
  await api.clear('all')
  load()
})

if (!api) {
  document.body.textContent = 'Wellbeing data is only available inside Valkyrie.'
} else {
  loadSettings()
  load()
  // keep "Today" live
  setInterval(() => { if (isToday(date) && document.visibilityState === 'visible') load() }, 30000)
}
