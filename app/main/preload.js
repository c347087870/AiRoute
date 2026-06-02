const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  onTraySwitchModel: (callback) => ipcRenderer.on('tray-switch-model', (_, model) => callback(model)),
  showWindow: () => ipcRenderer.send('show-window'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled)
})
