// 更新检查与下载：双通道获取 GitHub 最新版本（API 优先，限速/不可达时退回 302 解析），
// 流式下载安装包到用户指定路径并维护进度，供 /api/update/* 路由使用
const axios = require('axios')
const fs = require('fs-extra')
const path = require('path')

const REPO = 'c347087870/AiRoute'
const CACHE_TTL = 30 * 60 * 1000

let cached = null // 检查结果缓存 { at, data }
let downloadState = { status: 'idle', tag: '', savePath: '', received: 0, total: 0, error: '' } // 下载状态

// 按平台挑选 Release 资产：macOS 的 dmg 带版本号与架构（AiRoute-1.6.1-x64.dmg），
// 不能写死文件名；优先匹配当前架构，找不到再退回任意 dmg（Intel 包可在 Apple Silicon 上经 Rosetta 运行）
function pickAsset(assets) {
  const list = assets || []
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const dmgs = list.filter(a => /\.dmg$/i.test(a.name))
    return dmgs.find(a => a.name.includes(arch)) || dmgs[0] || null
  }
  return list.find(a => a.name === 'AiRoute.exe') || null
}

// 按 tag 解析当前平台安装包；302 通道拿不到资产清单时由这里补齐
async function resolveAsset(tag) {
  const res = await axios.get(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
    timeout: 8000,
    headers: { 'User-Agent': 'AiRoute', Accept: 'application/vnd.github+json' },
    validateStatus: s => s === 200
  })
  const asset = pickAsset((res.data || {}).assets)
  if (!asset) throw new Error('该版本没有适用于当前平台的安装包，请前往 Release 页面查看')
  return asset
}

// 开发者选项构建完成后写入的数据目录；这里是主进程与 HTTP 网关共用的只读视图。
// 注意：只向 HTTP 返回版本与提交信息，绝不返回 dmg 绝对路径或项目路径
function getDevBuildPath() {
  let dataDir = process.env.AIROUTE_DATA_DIR || ''
  if (!dataDir) {
    try {
      const { app } = require('electron')
      if (app && typeof app.getPath === 'function') dataDir = require('path').join(app.getPath('userData'), 'data')
    } catch {}
  }
  return dataDir ? path.join(dataDir, 'dev-build.json') : ''
}

function readLocalBuild() {
  const file = getDevBuildPath()
  if (!file) return null
  try {
    const state = fs.readJsonSync(file)
    if (!state || typeof state !== 'object' || !state.version) return null
    return {
      version: String(state.version).replace(/^v/i, ''),
      builtAt: typeof state.builtAt === 'string' ? state.builtAt : '',
      gitCommit: typeof state.gitCommit === 'string' ? state.gitCommit : '',
      gitBranch: typeof state.gitBranch === 'string' ? state.gitBranch : '',
      gitDirty: !!state.gitDirty
    }
  } catch {
    return null
  }
}

// 本地构建写入后立即失效缓存，保证「检查更新」马上能看到新版本
function invalidateCache() {
  cached = null
}

// 读取本地版本号，兼容开发（server/../package.json）与打包（app/server/../../package.json）两种目录结构
function getLocalVersion() {
  const candidates = [path.join(__dirname, '..', 'package.json'), path.join(__dirname, '..', '..', 'package.json')]
  for (const file of candidates) {
    try {
      const pkg = require(file)
      if (pkg && pkg.version) return pkg.version
    } catch {}
  }
  return '0.0.0'
}

// 三段式版本比较：a > b 返回 1，相等 0，小于 -1（忽略 v 前缀与预发布后缀）
function compareVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

// 通道一：GitHub API，信息最全（更新说明 / 发布时间 / 安装包大小）
async function fetchByApi() {
  const res = await axios.get(`https://api.github.com/repos/${REPO}/releases/latest`, {
    timeout: 8000,
    headers: { 'User-Agent': 'AiRoute', Accept: 'application/vnd.github+json' },
    validateStatus: s => s === 200
  })
  const data = res.data || {}
  if (!data.tag_name) throw new Error('API 返回缺少 tag_name')
  const asset = pickAsset(data.assets)
  return {
    tag: data.tag_name,
    notes: data.body || '',
    publishedAt: data.published_at || '',
    size: asset ? asset.size : 0,
    canDownload: !!asset,
    assetName: asset ? asset.name : '',
    pageUrl: data.html_url || `https://github.com/${REPO}/releases/tag/${data.tag_name}`
  }
}

// 通道二：读取 releases/latest 的 302 重定向地址解析最新 tag（api.github.com 会被限速）
async function fetchByRedirect() {
  const res = await axios.get(`https://github.com/${REPO}/releases/latest`, {
    timeout: 8000,
    maxRedirects: 0,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    validateStatus: s => s >= 200 && s < 400
  })
  const location = (res.headers && res.headers.location) || ''
  const matched = location.match(/\/releases\/tag\/([^/?#]+)/)
  if (!matched) throw new Error('无法解析最新版本号')
  // 302 通道拿不到资产清单；标记为未知，下载时再解析实际文件名
  return { tag: matched[1], notes: '', publishedAt: '', size: 0, canDownload: true, assetName: '', pageUrl: `https://github.com/${REPO}/releases/tag/${matched[1]}` }
}

// 检查更新：force=true 跳过 30 分钟缓存（设置页手动检查用）
async function checkUpdate(force) {
  const current = getLocalVersion()
  // 本地构建优先：开发者刚在「开发者选项」里构建出的版本就在本机，
  // 直接提示安装，不必先去 GitHub 绕一圈
  const local = readLocalBuild()
  if (local && compareVersion(local.version, current) > 0) {
    return {
      current,
      latest: local.version,
      tag: `v${local.version}`,
      hasUpdate: true,
      channel: 'local',
      source: 'local',
      installable: true,
      localBuild: {
        builtAt: local.builtAt,
        gitCommit: local.gitCommit,
        gitBranch: local.gitBranch,
        gitDirty: local.gitDirty
      },
      pageUrl: '',
      notes: '',
      publishedAt: local.builtAt,
      size: 0,
      canDownload: false,
      platform: process.platform,
      assetName: '',
      downloadUrl: ''
    }
  }
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.data
  let info
  let channel = 'api'
  try {
    info = await fetchByApi()
  } catch {
    channel = 'redirect'
    info = await fetchByRedirect()
  }
  const latest = info.tag.replace(/^v/i, '')
  const data = {
    current,
    latest,
    tag: info.tag,
    hasUpdate: compareVersion(latest, current) > 0,
    channel,
    source: 'github',
    installable: false,
    pageUrl: info.pageUrl,
    notes: info.notes,
    publishedAt: info.publishedAt,
    size: info.size,
    // 当前平台安装包在 Release 中不存在时，前端只展示「查看 Release 页面」
    canDownload: info.canDownload !== false,
    platform: process.platform,
    assetName: info.assetName || '',
    // 资产名在下载时最终确定（302 通道拿不到清单），这里只在已知时给出
    downloadUrl: info.assetName ? `https://github.com/${REPO}/releases/download/${info.tag}/${info.assetName}` : ''
  }
  cached = { at: Date.now(), data }
  return data
}

// 下载状态快照（前端轮询用），附带百分比
function getDownloadState() {
  return {
    ...downloadState,
    percent: downloadState.total ? Math.min(100, Math.round((downloadState.received / downloadState.total) * 100)) : 0
  }
}

// 启动下载：校验并重置状态后异步执行；下载中重复触发直接抛错
function startDownload(tag, savePath, assetName) {
  if (downloadState.status === 'downloading') throw new Error('已有下载任务进行中')
  if (!tag || !savePath) throw new Error('缺少版本号或保存路径')
  downloadState = { status: 'downloading', tag, savePath, assetName: assetName || '', received: 0, total: 0, error: '' }
  runDownload(tag, savePath)
  return getDownloadState()
}

// 实际执行下载：流式写盘，完成后按 Content-Length 校验大小，异常写入错误状态
async function runDownload(tag, savePath) {
  try {
    fs.ensureDirSync(path.dirname(savePath))
    // 302 通道检查更新时没有资产清单，这里按 tag 重新解析，拿到平台对应的真实文件名
    let assetName = downloadState.assetName
    if (!assetName) {
      const asset = await resolveAsset(tag)
      assetName = asset.name
      downloadState.assetName = assetName
    }
    const url = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(assetName)}`
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    downloadState.total = Number(res.headers['content-length'] || 0)
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(savePath)
      res.data.on('data', chunk => { downloadState.received += chunk.length })
      res.data.on('error', reject)
      ws.on('error', reject)
      ws.on('finish', resolve)
      res.data.pipe(ws)
    })
    if (downloadState.total && downloadState.received !== downloadState.total) {
      throw new Error('文件大小校验失败，请重试')
    }
    downloadState.status = 'done'
  } catch (e) {
    downloadState.status = 'error'
    downloadState.error = e.message || '下载失败'
  }
}

module.exports = { checkUpdate, startDownload, getDownloadState, getLocalVersion, invalidateCache, readLocalBuild }
