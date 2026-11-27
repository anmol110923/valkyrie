// Preload for the browser UI (sidebar). Runs unsandboxed so it can load the
// <browser-action-list> element that shows Chrome extension buttons.
const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

injectBrowserAction()

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data))

contextBridge.exposeInMainWorld('valkyrie', {
  platform: process.platform,
  send: (channel, ...args) => ipcRenderer.send(`ui:${channel}`, ...args),
  suggest: (q) => ipcRenderer.invoke('ui:suggest', q),
  today: () => ipcRenderer.invoke('wb:today'),
  prefs: () => ipcRenderer.invoke('st:prefs'),
  onState: on('state'),
  onLayout: on('layout'),
  onBookmarks: on('bookmarks'),
  onFocusUrl: on('focus-url'),
  onRename: on('rename'),
  onToast: on('toast'),
})
