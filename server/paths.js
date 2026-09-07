const fs = require('fs-extra')
const path = require('path')

// 数据目录：生产模式由 Electron 主进程注入 AIROUTE_DATA_DIR，开发模式直接用 server 目录
function getDataDir() {
  return process.env.AIROUTE_DATA_DIR || __dirname
}

function getConfigPath() {
  return path.join(getDataDir(), 'models.json')
}

function getStatePath() {
  return path.join(getDataDir(), 'state.json')
}

function getFallbackPath() {
  return path.join(getDataDir(), 'fallback.json')
}

function getRulesPath() {
  return path.join(getDataDir(), 'rules.json')
}

function getServerConfigPath() {
  return path.join(getDataDir(), 'server-config.json')
}

function getLogDir() {
  return path.join(getDataDir(), 'logs')
}

// 读取服务端口，供 Electron 主进程与托盘在没有启动 server 的情况下使用
function getServerPort() {
  try {
    const configPath = getServerConfigPath()
    if (fs.existsSync(configPath)) {
      return fs.readJsonSync(configPath).port || 3000
    }
  } catch {
    // 配置损坏时回落到默认端口
  }
  return 3000
}

module.exports = {
  getDataDir,
  getConfigPath,
  getStatePath,
  getFallbackPath,
  getRulesPath,
  getServerConfigPath,
  getLogDir,
  getServerPort
}
