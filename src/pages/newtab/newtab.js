function tick() {
  const d = new Date()
  document.getElementById('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const h = d.getHours()
  document.getElementById('greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
tick()
setInterval(tick, 10000)

async function loadToday() {
  if (!window.valkyrie) return
  const s = await window.valkyrie.today()
  const nav = document.getElementById('today')
  const main = document.createElement('a')
  main.className = 'chip main'
  main.href = 'valkyrie://wellbeing/'
  main.innerHTML = `Today <strong>${fmtDuration(s.total)}</strong>`
  const chips = s.top.slice(0, 3).filter((t) => t.seconds > 0).map((t) => {
    const a = document.createElement('a')
    a.className = 'chip'
    a.href = 'valkyrie://wellbeing/'
    a.append(siteIcon(t.domain, t.favicon), `${t.domain} · ${fmtDuration(t.seconds)}`)
    return a
  })
  nav.replaceChildren(main, ...chips)

  // First run: point people at the importer.
  const info = await window.valkyrie.info()
  if (!info.bookmarks && !info.passwords) {
    const imp = document.createElement('a')
    imp.className = 'chip'
    imp.href = 'valkyrie://settings/#import'
    imp.textContent = 'Import bookmarks & passwords from Chrome →'
    nav.append(imp)
  }
}
loadToday()
