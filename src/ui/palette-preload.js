// Command bar (⌘K) preload — sandboxed; only talks to the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('palette', {
  query: (q) => ipcRenderer.invoke('pal:query', q),
  run: (item) => ipcRenderer.send('pal:run', item),
  close: () => ipcRenderer.send('pal:close'),
  onOpen: (cb) => ipcRenderer.on('palette-open', (_e, d) => cb(d)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
})
