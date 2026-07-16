const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('krash', {
  config: {
    get: () => ipcRenderer.invoke('config:get')
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    maximizeToggle: () => ipcRenderer.send('window:maximize-toggle')
  },
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key)
  },
  game: {
    chooseFolder: () => ipcRenderer.invoke('game:chooseFolder'),
    sync: () => ipcRenderer.invoke('game:sync'),
    checkVersion: () => ipcRenderer.invoke('game:checkVersion'),
    onSyncProgress: (callback) => {
      const handler = (_e, progress) => callback(progress)
      ipcRenderer.on('game:sync-progress', handler)
      return () => ipcRenderer.removeListener('game:sync-progress', handler)
    },
    play: () => ipcRenderer.invoke('game:play'),
    findObsolete: () => ipcRenderer.invoke('game:findObsolete'),
    deleteObsolete: (files) => ipcRenderer.invoke('game:deleteObsolete', files),
    openLogs: () => ipcRenderer.invoke('game:openLogs')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback) => {
      const handler = (_e, status) => callback(status)
      ipcRenderer.on('update:status', handler)
      return () => ipcRenderer.removeListener('update:status', handler)
    }
  }
})
