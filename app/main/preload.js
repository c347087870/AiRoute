const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  onTraySwitchModel: (callback) => ipcRenderer.on('tray-switch-model', (_, model) => callback(model)),
  showWindow: () => ipcRenderer.send('show-window'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  // 系统状态：应用各进程内存占用（字节）
  getAppMemory: () => ipcRenderer.invoke('get-app-memory'),
  // 模型或 Provider 配置变化后通知主进程刷新托盘菜单
  notifyModelChanged: () => ipcRenderer.send('model-data-changed'),
  // 更新功能：另存为对话框 / 用系统浏览器打开外链 / 打开文件夹并选中文件
  saveFileDialog: (defaultName) => ipcRenderer.invoke('save-file-dialog', defaultName),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath)
})
