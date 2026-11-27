// ---------- reveal on scroll ----------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
}, { threshold: 0.15 })
document.querySelectorAll('.reveal, .wb-visual').forEach((el) => io.observe(el))

// ---------- hero mockup tilts upright as you scroll ----------
const mock = document.querySelector('.mock')
const dock = document.getElementById('dock')
const hero = document.querySelector('.hero')
function onScroll() {
  const p = Math.min(1, window.scrollY / (window.innerHeight * 0.6))
  mock.style.setProperty('--tilt', `${14 * (1 - p)}deg`)
  mock.style.setProperty('--lift', `${30 * (1 - p)}px`)
  // past the hero only the pill stays; hide it where a download button is already on screen
  dock.classList.toggle('floating', window.scrollY > 120)
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight * 0.85 && r.bottom > innerHeight * 0.15 }
  dock.classList.toggle('away', visible(document.getElementById('download')) || visible(document.querySelector('.final')))
}
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

// stagger hero chart bars
document.querySelectorAll('.m-chart i').forEach((el, i) => el.style.setProperty('--i', i))

// ---------- numbered steps: activate by scroll position or click ----------
const steps = [...document.querySelectorAll('.step')]
const visuals = [...document.querySelectorAll('.sv')]
function activate(i) {
  steps.forEach((s, j) => s.classList.toggle('active', i === j))
  visuals.forEach((v, j) => v.classList.toggle('show', i === j))
}
steps.forEach((s, i) => s.addEventListener('click', () => activate(i)))
const stepIO = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) activate(steps.indexOf(e.target))
}, { rootMargin: '-45% 0px -45% 0px' })
steps.forEach((s) => stepIO.observe(s))

// ---------- downloads: newest release + recommend the right file ----------
const REPO = 'anmol110923/valkyrie'
const cards = Object.fromEntries([...document.querySelectorAll('.dl')].map((a) => [a.dataset.asset, a]))
const LABELS = {
  'mac-arm64': ['for Mac', 'macOS · Apple Silicon'],
  'mac-x64': ['for Mac', 'macOS · Intel'],
  'win-x64': ['for Windows', 'Windows 10 & 11'],
  'win-arm64': ['for Windows', 'Windows on ARM'],
}

async function detectAsset() {
  const ua = navigator.userAgent
  const uaData = navigator.userAgentData
  if (/Windows/i.test(ua)) {
    try {
      const { architecture } = (await uaData?.getHighEntropyValues(['architecture'])) || {}
      if (architecture === 'arm') return 'win-arm64'
    } catch {}
    return 'win-x64'
  }
  if (/Mac/i.test(ua) && !/iPhone|iPad/i.test(ua) && navigator.maxTouchPoints < 2) {
    try {
      const { architecture } = (await uaData?.getHighEntropyValues(['architecture'])) || {}
      if (architecture === 'x86') return 'mac-x64'
    } catch {}
    // Safari/Firefox don't expose the CPU; WebGL renderer usually does.
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      const r = gl && gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)
      if (r && /Intel|AMD|Radeon/i.test(r) && !/Apple M/i.test(r)) return 'mac-x64'
    } catch {}
    return 'mac-arm64'
  }
  return null // phone, Linux, etc.
}

async function loadRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return
    const rel = await res.json()
    const version = rel.tag_name.replace(/^v/, '')
    document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = `Version ${version}` })
    for (const asset of rel.assets) {
      const m = asset.name.match(/-(mac-arm64|mac-x64|win-x64|win-arm64)\.(dmg|exe)$/)
      const card = m && cards[m[1]]
      if (!card) continue
      card.href = asset.browser_download_url
      card.querySelector('[data-size]').textContent = `${Math.round(asset.size / 1048576)} MB`
    }
  } catch { /* offline or rate-limited: the built-in v0.1.0 links still work */ }
}

;(async () => {
  await loadRelease()
  const key = await detectAsset()
  const primaries = document.querySelectorAll('[data-primary]')
  const notes = document.querySelectorAll('[data-primary-note]')
  if (!key) {
    notes.forEach((n) => { n.textContent = 'Valkyrie is for Mac and Windows computers. Send this link to yourself for later.' })
    return
  }
  const card = cards[key]
  card.classList.add('recommended')
  const [short, long] = LABELS[key]
  primaries.forEach((a) => {
    a.href = card.href
    a.innerHTML = `Download Valkyrie ${short} <span class="arrow">↓</span>`
    a.addEventListener('click', () => setTimeout(() => document.getElementById('g-first-launch').scrollIntoView({ behavior: 'smooth' }), 600))
  })
  notes.forEach((n) => {
    n.innerHTML = `${long} · ${card.querySelector('[data-size]').textContent} · <a href="#download">Other platforms</a>`
  })
})()

// ---------- guide: tabs, copy buttons, active TOC ----------
document.querySelectorAll('[data-tabs]').forEach((box) => {
  const buttons = box.querySelectorAll('[data-tab]')
  buttons.forEach((b) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.setAttribute('aria-selected', String(x === b)))
    box.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab })
  }))
  if (/Windows/i.test(navigator.userAgent)) box.querySelector('[data-tab="win"]').click()
})

document.querySelectorAll('.copy').forEach((btn) => btn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(btn.dataset.copy)
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  } catch {}
}))

const tocLinks = [...document.querySelectorAll('.toc a')]
const tocIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue
    tocLinks.forEach((a) => a.classList.toggle('current', a.getAttribute('href') === `#${e.target.id}`))
  }
}, { rootMargin: '-30% 0px -60% 0px' })
document.querySelectorAll('.doc article').forEach((a) => tocIO.observe(a))

document.getElementById('year').textContent = `© ${new Date().getFullYear()}`
