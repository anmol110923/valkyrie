# Valkyrie

An Arc-style browser built on Chromium (via Electron), with Chrome extension support, built-in ad/tracker blocking and a private, on-device wellbeing tracker.

**Website & downloads: [tryvalkyrie.vercel.app](https://tryvalkyrie.vercel.app)**

## Download

Get the latest installer from **[Releases](https://github.com/anmol110923/valkyrie/releases/latest)**:

| Your computer | File |
|---|---|
| Mac with Apple Silicon (M1–M4) | `Valkyrie-…-mac-arm64.dmg` |
| Mac with Intel | `Valkyrie-…-mac-x64.dmg` |
| Windows (most PCs) | `Valkyrie-…-win-x64.exe` |
| Windows on ARM | `Valkyrie-…-win-arm64.exe` |

### Easiest: one-line install (no security pop-ups)

```bash
# macOS (Terminal)
curl -fsSL https://tryvalkyrie.vercel.app/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://tryvalkyrie.vercel.app/install.ps1 | iex
```

The scripts ([install.sh](website/install.sh), [install.ps1](website/install.ps1)) download the latest release from GitHub, check its SHA-256 against the release's `SHA256SUMS.txt`, and install Valkyrie. Files fetched this way aren't marked as "downloaded from the internet", so the unsigned app isn't blocked. Run the same command again to update.

### Or download the installer

These builds are not yet signed with a paid Apple/Microsoft certificate, so opening a downloaded installer shows a warning:

- **macOS**: open the DMG and drag Valkyrie to Applications. If macOS says it "can't be verified", go to **System Settings → Privacy & Security** and click **Open Anyway**. If it says the app "is damaged", run `xattr -cr /Applications/Valkyrie.app` in Terminal and open it again.
- **Windows**: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

## Build from source

```bash
npm install
npm start          # run from source
npm run dist       # build dist/mac-arm64/Valkyrie.app
npm run release    # build the .dmg (Apple Silicon + Intel) and .exe installers + dist/SHA256SUMS.txt
```

To use Valkyrie as your default browser, build the app, move `Valkyrie.app` to /Applications, open it, and go to **Settings (⌘,) → Make Valkyrie default**.

## Features

### Arc-style organization
- **Spaces**: separate workspaces (Work, Study, Personal…), each with its own color, pinned tabs and tabs. Switch with the icons at the bottom of the sidebar or **⌃1–⌃9**. Right-click a space to rename it, change its icon or color, or delete it.
- **Favorites**: an icon grid at the top of the sidebar. Drag a tab there, or right-click a tab → **Add to Favorites**.
- **Pinned tabs and folders**: drag tabs into **Pinned**, or press **⇧⌘D**. Create folders with the folder button, nest them, and drag items between them. Closing a pinned tab keeps it pinned. **Back to Pinned URL** resets it.
- **Today tabs**: everything else. **Clear** closes them all, and auto-archive closes tabs you haven't looked at in 12 hours (configurable). You can reopen them from Settings → Tabs.
- **Command bar (⌘K)**: search open tabs, pinned items, bookmarks and history, open URLs, or run commands such as new space, split view, theme or copy URL.
- **Split view**: right-click a tab → **Open in Split View**, or press **⌃⇧=**.
- **Tab extras**: rename tabs (double-click), mute (speaker icon), duplicate, move to another space, copy URL (**⇧⌘C**).
- **Collapsible sidebar**: **⌘S** hides it, and hovering the left edge slides it back over the page.

### Browsing
- **Chrome extensions** from the Chrome Web Store, with buttons and popups in the sidebar
- **Ad and tracker blocking** (Brave-style, EasyList/EasyPrivacy). You can turn it off in Settings.
- **Smart URL bar** with suggestions from your bookmarks and history. Choose your **search engine** (Google, DuckDuckGo, Bing, Brave, Perplexity, Ecosia).
- **Bookmarks** (**⌘D**), **PDF viewer**, **⌘O** to open files, and tabs that restore after a restart
- **Import from Chrome, Brave, Arc, Edge, Vivaldi or Chromium**: bookmarks, history, passwords, cookies and extensions
- **Password manager** with autofill, encrypted with your system keychain
- **Light / dark mode**: System, Light or Dark in Settings, or **⇧⌘L**
- **Typography**: Instrument Serif and Inter, bundled with the app
- **Default browser** support for http/https links, HTML and PDF files

### Wellbeing dashboard (new tab page)
Every new tab shows:
- Greeting, clock and search
- Favorites and your most-used sites as tiles
- **Today** (with your daily-goal progress), **this week** vs last week, **daily average**, **streak** and **all-time** screen time
- **Your year in browsing**: a GitHub-style heatmap of daily screen time for the last 12 months
- **When you browse**: an hour-by-weekday heatmap for the last 90 days
- **Most used sites** and **most visited pages** (30 days), plus **recently today**

The full **Wellbeing** page (**⌘Y**) has day and week views and a searchable footprint of every page.

A second counts only when the tab is in front of you and you're active, or when it's playing audio. That way a 2-hour YouTube session shows up as 2 hours, but a tab left open overnight adds nothing. Data is stored only in `~/Library/Application Support/Valkyrie/wellbeing/` as plain JSON.

### Settings
General (default browser, startup, search engine) · Appearance (theme, sidebar, dashboard) · Spaces · Tabs (auto-archive and archived tabs) · Wellbeing (tracking, daily goal, idle time) · Privacy (ad blocking, clear browsing data) · Passwords · Import · Downloads · Shortcuts · About

## Shortcuts

On Windows, use Ctrl instead of ⌘.

| Keys | Action |
|---|---|
| ⌘K | Command bar |
| ⌘T / ⌘W / ⇧⌘T | New tab / close tab / reopen closed tab |
| ⌘L | Focus URL bar |
| ⌘S | Toggle sidebar |
| ⇧⌘L | Toggle light / dark mode |
| ⌘D / ⇧⌘D | Bookmark page / pin tab |
| ⇧⌘C | Copy URL |
| ⌃⇧= / ⌃⇧- | Split view / exit split view |
| ⌃1–⌃9, ⌃⌥← / → | Switch spaces |
| ⌘1–⌘9, ⌃Tab, ⌥⌘↑/↓ | Switch tabs |
| ⌘R / ⇧⌘R | Reload / hard reload |
| ⌘[ / ⌘] | Back / forward |
| ⌘= / ⌘- / ⌘0 | Zoom |
| ⌘Y | Wellbeing |
| ⌘, | Settings |
| ⌘O | Open file (PDF, HTML…) |
| ⌥⌘I | Developer tools |
| ⌘N | New window |

## Layout

```
src/
  main.js          main process: app setup, IPC, menu, permissions, ad blocking, valkyrie:// pages
  window.js        a browser window: tabs, spaces, pinned/favorites, split view, command bar, collapse/peek
  stores.js        settings, spaces + pinned tree, archive, bookmarks (JSON) and history (SQLite)
  passwords.js     saved logins, encrypted with the OS keychain
  chrome-import.js import from Chrome/Brave/Arc/Edge/Vivaldi
  tracker.js       local activity tracker (time per site + footprint)
  ui/              sidebar UI (index.html, styles.css, renderer.js, preload.js) and command bar (palette.*)
  pages/           built-in pages served at valkyrie://<folder>/
    newtab/        new tab dashboard (screen-time history, heatmaps, top sites & pages)
    wellbeing/     wellbeing dashboard
    settings/      settings, import, passwords, default browser
    assets/        shared icon, fonts (Instrument Serif + Inter, OFL) and helpers
    preload.js     browser API on valkyrie:// pages, password autofill on websites
assets/            app icon (icon.svg source, icon.png, icon.icns). Rebuild with `npm run icons`
```

## Debugging

`VALKYRIE_DEBUG=1 npm start` logs blocked requests and exposes `global.__valkyrie`.

## Known limits

- Chrome extension API coverage comes from `electron-chrome-extensions`. Most popular extensions work (uBlock Origin Lite, Dark Reader, password managers, Grammarly). Extensions that rely on less common APIs (`chrome.commands`, side panels) may not.
- Google account sync, Widevine DRM (Netflix etc.), and auto-updating the app itself are not set up yet.

## Roadmap

- To-do list in the sidebar and on the new tab page
- Wellbeing: per-site daily limits, focus mode, break reminders
- Accountability tracker: goals, streaks, weekly reports

## Website

The landing page lives in [`website/`](website) (plain HTML/CSS/JS, no build step) and is deployed to Vercel:

```bash
cd website
npx vercel deploy --prod
```

When you publish a release, upload `dist/SHA256SUMS.txt` with the installers. The one-line installers refuse to install without it.

`website/og.html` is the source of the link-preview image. Regenerate it with `npx electron scripts/build-og.js`.
