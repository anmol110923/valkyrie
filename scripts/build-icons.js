// Renders assets/icon.svg to PNGs and a macOS .icns using Electron's own renderer.
// Run: npm run icons
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8')
const OUT = path.join(ROOT, 'assets')

async function render(win, size) {
  const html = `<html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`
  win.setContentSize(size, size)
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await new Promise((r) => setTimeout(r, 150))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  })
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(win, 1024))

  if (process.platform === 'darwin') {
    const iconset = path.join(OUT, 'icon.iconset')
    fs.mkdirSync(iconset, { recursive: true })
    for (const s of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), await render(win, s))
      fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), await render(win, s * 2))
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT, 'icon.icns')])
    fs.rmSync(iconset, { recursive: true })
  }
  console.log('icons written to assets/')
  app.quit()
})
