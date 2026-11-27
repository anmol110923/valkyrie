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

These builds are not yet signed with a paid Apple/Microsoft certificate, so the first launch shows a warning:

- **macOS**: open the DMG and drag Valkyrie to Applications. If macOS says it "can't be verified", go to **System Settings → Privacy & Security** and click **Open Anyway**. If it says the app "is damaged", run `xattr -cr /Applications/Valkyrie.app` in Terminal and open it again.
- **Windows**: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

## Build from source

```bash
npm install
npm start          # run from source
npm run dist       # build dist/mac-arm64/Valkyrie.app
npm run release    # build the .dmg (Apple Silicon + Intel) and .exe installers
```

To use Valkyrie as your default browser, build the app, move `Valkyrie.app` to /Applications, open it, and go to **Settings (⌘,) → Make Valkyrie default**.

## What's in the MVP

- **Vertical sidebar tabs** (Arc style): favicons, loading spinners, drag to reorder, middle-click to close
- **Collapsible sidebar**: ⌘S (or the sidebar button) hides it, and hovering the left edge slides it back over the page
- **Omnibox** with suggestions from your bookmarks and history (↑/↓ to pick)
- **Bookmarks**: ⌘D or the ★ in the URL bar. They show in a collapsible sidebar section; right-click for options
- **Import from Chrome, Brave, Arc, Edge, Vivaldi or Chromium** (Settings → Import): bookmarks, history, saved passwords, cookies (so you stay signed in) and Web Store extensions. On macOS, passwords and cookies need you to allow Keychain access once.
- **Password manager**: offers to save logins and fills them from a small dropdown on login fields. Passwords are encrypted with the macOS Keychain (Electron `safeStorage`). Manage them in Settings.
- **PDF viewer**: PDFs open inside Valkyrie. ⌘O opens local PDF and HTML files.
- **Default browser**: the packaged app registers for http/https links and for HTML and PDF files
- **Chrome extensions**: install from the Chrome Web Store with the store's own "Add to Chrome" button. Extension icons and popups appear in the sidebar. Extensions auto-update every 5 hours.
- **Ad and tracker blocking** (Brave-style) via Ghostery's engine with the EasyList/EasyPrivacy lists. The shield in the URL bar shows how many requests were blocked on the current page.
- **Tabs restore** after a restart
- **Permission prompts** for camera, mic, location and notifications
- Context menu: open link in new tab, copy, search selection, extension menu items, Inspect

## Wellbeing & footprint

Open it with the **Today** button at the bottom of the sidebar, **⌘Y**, or `valkyrie://wellbeing`.

- **Screen time per site**: a second counts when a tab is the active tab of the focused window and you're not idle (60s without input), **or** when a tab is playing audio. That way a YouTube video you're watching still counts, but a tab left open overnight doesn't.
- **Footprint**: every page you opened, when you opened it, and how long you spent on it. Each YouTube video is its own entry, and media that played is tagged.
- **Day and Week views**: an hourly or daily chart, top sites, a comparison with the previous day, and a searchable list of pages.
- **Private by design**: data lives only in `~/Library/Application Support/Valkyrie/wellbeing/YYYY-MM-DD.json` (plain JSON you own). You can pause tracking or delete a day or all data from the dashboard.
- The new tab page shows today's total and your top 3 sites.

## Shortcuts

| Keys | Action |
|---|---|
| ⌘T / ⌘W / ⇧⌘T | New tab / close tab / reopen closed tab |
| ⌘L | Focus URL bar |
| ⌘R / ⇧⌘R | Reload / hard reload |
| ⌘[ / ⌘] | Back / forward |
| ⌘1–⌘9, ⌃Tab, ⌥⌘↑/↓ | Switch tabs |
| ⌘= / ⌘- / ⌘0 | Zoom |
| ⌥⌘I | DevTools for the page |
| ⌘N | New window |
| ⌘Y | Wellbeing & activity |
| ⌘S | Toggle sidebar |
| ⌘D | Bookmark page |
| ⌘O | Open file (PDF, HTML…) |
| ⌘, | Settings & import |

## Layout

```
src/
  main.js          main process: app setup, IPC, menu, permissions, ad blocking, valkyrie:// pages
  window.js        a browser window: tabs, sidebar view, collapse/peek layout
  stores.js        settings, bookmarks (JSON) and history (SQLite)
  passwords.js     saved logins, encrypted with the OS keychain
  chrome-import.js import from Chrome/Brave/Arc/Edge/Vivaldi
  tracker.js       local activity tracker (time per site + footprint)
  ui/              sidebar UI (index.html, styles.css, renderer.js, preload.js)
  pages/           built-in pages served at valkyrie://<folder>/
    newtab/        new tab page
    wellbeing/     wellbeing dashboard
    settings/      settings, import, passwords, default browser
    assets/        shared icon + helpers
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
- Wellbeing: daily limits per site, focus mode, break reminders
- Accountability tracker: goals, streaks, weekly reports

## Website

The landing page lives in [`website/`](website) (plain HTML/CSS/JS, no build step) and is deployed to Vercel:

```bash
cd website
npx vercel deploy --prod
```

`website/og.html` is the source of the link-preview image. Regenerate it with `npx electron scripts/build-og.js`.
