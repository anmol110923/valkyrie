// Renders website/og.html to website/assets/og.png (the 1200x630 link-preview image).
// Run: npx electron scripts/build-og.js
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')

const SITE = path.join(__dirname, '..', 'website')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 630, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadFile(path.join(SITE, 'og.html'))
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await new Promise((r) => setTimeout(r, 800))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 630 })
  fs.writeFileSync(path.join(SITE, 'assets', 'og.png'), img.resize({ width: 1200, height: 630, quality: 'best' }).toPNG())
  console.log('wrote website/assets/og.png')
  app.quit()
})
