const { contextBridge, ipcRenderer } = require('electron')

// 统一的事件订阅：始终返回取消函数，组件卸载时避免监听器泄漏
function subscribe(channel, callback) {
  const listener = (_, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  onTraySwitchModel: (callback) => ipcRenderer.on('tray-switch-model', (_, model) => callback(model)),
  showWindow: () => ipcRenderer.send('show-window'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  // 系统状态：应用各进程内存占用（字节）
  getAppMemory: () => ipcRenderer.invoke('get-app-memory'),
  // 模型或 Provider 配置变化后通知主进程刷新托盘菜单
  notifyModelChanged: () => ipcRenderer.send('model-data-changed'),
  // 端口修改并重启服务后，通知主进程把窗口切到新端口
  notifyServerPortChanged: (port) => ipcRenderer.send('server-port-changed', port),
  // 个性化外观：自定义应用背景与主题色（图片保存在 userData/appearance）
  appearance: {
    get: () => ipcRenderer.invoke('appearance:get'),
    save: (patch) => ipcRenderer.invoke('appearance:save', patch),
    chooseBackground: () => ipcRenderer.invoke('appearance:choose-background'),
    clearBackground: () => ipcRenderer.invoke('appearance:clear-background')
  },
  // 更新功能：另存为对话框 / 用系统浏览器打开外链 / 打开文件夹并选中文件
  saveFileDialog: (defaultName) => ipcRenderer.invoke('save-file-dialog', defaultName),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  // 开发者选项：内嵌终端（仅主窗口 IPC，绝不暴露到 HTTP 网关）
  devTerminal: {
    start: (opts) => ipcRenderer.invoke('dev-terminal:start', opts),
    write: (data) => ipcRenderer.invoke('dev-terminal:write', data),
    resize: (size) => ipcRenderer.invoke('dev-terminal:resize', size),
    restart: (opts) => ipcRenderer.invoke('dev-terminal:restart', opts),
    stop: () => ipcRenderer.invoke('dev-terminal:stop'),
    status: () => ipcRenderer.invoke('dev-terminal:status'),
    onData: (callback) => subscribe('dev-terminal:data', callback),
    onExit: (callback) => subscribe('dev-terminal:exit', callback),
    onState: (callback) => subscribe('dev-terminal:state', callback)
  },
  // 开发者选项：本地构建与覆盖安装
  devBuild: {
    check: () => ipcRenderer.invoke('dev-build:check'),
    chooseProject: () => ipcRenderer.invoke('dev-build:choose-project'),
    start: (opts) => ipcRenderer.invoke('dev-build:start', opts),
    cancel: () => ipcRenderer.invoke('dev-build:cancel'),
    install: () => ipcRenderer.invoke('dev-build:install'),
    openProject: () => ipcRenderer.invoke('dev-build:open-project'),
    openDmg: () => ipcRenderer.invoke('dev-build:open-dmg'),
    status: () => ipcRenderer.invoke('dev-build:status'),
    onLog: (callback) => subscribe('dev-build:log', callback),
    onStatus: (callback) => subscribe('dev-build:status', callback),
    onDone: (callback) => subscribe('dev-build:done', callback),
    onInstalling: (callback) => subscribe('dev-build:installing', callback)
  }
})
