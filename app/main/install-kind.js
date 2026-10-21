// 运行形态判定：Windows 上「安装版（NSIS）」支持一键升级，「便携版（portable）」不支持。
// 唯一的可靠信号是 electron-builder 的 portable 目标为子进程注入的环境变量
// PORTABLE_EXECUTABLE_FILE / PORTABLE_EXECUTABLE_DIR：便携版运行时会自行解包到临时目录，
// 解包后的目录结构与安装版完全一致，靠文件特征无法区分。
// 本模块不依赖 Electron，便于离线单测；main.js 会把结果写入 AIROUTE_INSTALL_KIND 供 server 复用。
const KIND = {
  MAC: 'mac',
  INSTALLER: 'installer',
  PORTABLE: 'portable'
}

// 判定当前运行形态。未显式传入 env 时读 process.env（打包后的进程已带上 electron-builder 注入的变量）
function detectInstallKind({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return KIND.MAC
  if (env && (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR)) return KIND.PORTABLE
  return KIND.INSTALLER
}

// 是否支持应用内一键升级：macOS 走原子替换，Windows 只有安装版能静默运行安装包
function supportsOneClick(kind, platform = process.platform) {
  return platform === 'darwin' || kind === KIND.INSTALLER
}

module.exports = { KIND, detectInstallKind, supportsOneClick }
