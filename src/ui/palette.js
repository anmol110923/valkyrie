const q = document.getElementById('q')
const list = document.getElementById('results')
let items = []
let sel = 0
let seq = 0

const GROUPS = { action: 'Go to', tab: 'Open tabs', pinned: 'Pinned & favorites', bookmark: 'Bookmarks', history: 'History', command: 'Commands', space: 'Spaces' }

function icon(item) {
  const el = document.createElement('span')
  el.className = 'icon'
  if (item.favicon) {
    const img = document.createElement('img')
    img.src = item.favicon
    img.onerror = () => { img.remove(); el.textContent = '•' }
    el.append(img)
  } else if (item.glyph) {
    el.textContent = item.glyph
  } else {
    el.classList.add('letter')
    try { el.textContent = new URL(item.url).hostname.replace(/^www\./, '')[0].toUpperCase() } catch { el.textContent = '•' }
  }
  return el
}

function render() {
  const frag = []
  let lastGroup = null
  items.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      const g = document.createElement('li')
      g.className = 'group'
      g.textContent = GROUPS[item.group] || item.group
      frag.push(g)
    }
    const li = document.createElement('li')
    li.className = 'item' + (i === sel ? ' sel' : '')
    const text = document.createElement('div')
    text.className = 'text'
    const t = document.createElement('span')
    t.className = 'title'
    t.textContent = item.title
    text.append(t)
    if (item.sub) {
      const s = document.createElement('span')
      s.className = 'sub'
      s.textContent = item.sub
      text.append(s)
    }
    li.append(icon(item), text)
    if (item.hint) {
      const h = document.createElement('span')
      h.className = 'hint'
      h.textContent = item.hint
      li.append(h)
    }
    li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render() } })
    li.addEventListener('mousedown', (e) => { e.preventDefault(); run(item, e.metaKey || e.ctrlKey) })
    frag.push(li)
  })
  list.replaceChildren(...frag)
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
}

async function update() {
  const s = ++seq
  const res = await palette.query(q.value)
  if (s !== seq) return
  items = res
  sel = 0
  render()
}

function run(item, newTab = false) {
  palette.run({ ...item, newTab })
}

q.addEventListener('input', update)
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); palette.close() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render() }
  else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel], e.metaKey || e.ctrlKey) }
})
document.getElementById('scrim').addEventListener('mousedown', () => palette.close())
window.addEventListener('blur', () => palette.close())

palette.onOpen(({ mode }) => {
  q.value = ''
  q.placeholder = mode === 'new-tab' ? 'Search or enter a URL to open in a new tab' : 'Search tabs, bookmarks, history — or type a command'
  q.focus()
  update()
})

let toastTimer
palette.onToast((text) => {
  const t = document.getElementById('toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 1600)
})
