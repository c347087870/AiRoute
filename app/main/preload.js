const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  onTraySwitchModel: (callback) => ipcRenderer.on('tray-switch-model', (_, model) => callback(model)),
  showWindow: () => ipcRenderer.send('show-window'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  // 模型或 Provider 配置变化后通知主进程刷新托盘菜单
  notifyModelChanged: () => ipcRenderer.send('model-data-changed')
})
