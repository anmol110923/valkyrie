// Shared helpers for valkyrie:// pages.
window.fmtDuration = function fmtDuration(sec) {
  sec = Math.round(sec || 0)
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

window.dayKey = function dayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

window.parseDay = function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

window.siteIcon = function siteIcon(domain, favicon) {
  const span = document.createElement('span')
  span.className = 'site-icon'
  const letter = () => {
    span.textContent = (domain || '?')[0].toUpperCase()
    span.classList.add('letter')
  }
  if (favicon) {
    const img = document.createElement('img')
    img.src = favicon
    img.alt = ''
    img.onerror = () => { img.remove(); letter() }
    span.append(img)
  } else {
    letter()
  }
  return span
}
