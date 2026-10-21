// 更新检查与下载：双通道获取 GitHub 最新版本（API 优先，限速/不可达时退回 302 解析），
// 支持两种下载方式：
//   1. 一键升级：下载到托管目录并用 SHA-256 校验，供 Electron 主进程替换安装（见 app/main/updater.js）
//   2. 手动下载：另存为到用户指定路径（Windows / 无法自动替换时的兜底）
// 替换、备份、回滚与重启由主进程负责，本模块只做网络与文件校验
const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const REPO = 'c347087870/AiRoute'
const CACHE_TTL = 30 * 60 * 1000
const CHECKSUM_ASSET = 'SHA256SUMS.txt'

// 发布资产名：AiRoute-<version>-<arch>.<ext>（与 electron-builder.json 的 artifactName 模板一致）
// 架构取运行时的 process.arch：Apple Silicon / Windows on ARM 上 Electron 原生报 arm64，其余按 x64
const IS_MAC = process.platform === 'darwin'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const EXT = IS_MAC ? 'dmg' : 'exe'

// 一键升级的托管下载目录：生产模式由主进程注入 AIROUTE_UPDATE_DIR（userData/updates），
// 开发模式落到系统临时目录，避免把上百 MB 安装包写进仓库
const UPDATE_DIR = process.env.AIROUTE_UPDATE_DIR || path.join(os.tmpdir(), 'airoute-updates')

// 候选资产名，按优先级排列：Windows 早期版本（≤ v1.7.0-beta.1）发的是不带版本/架构的
// AiRoute.exe，留作兜底，否则旧安装包的应用内更新会 404（新版本 Release 仍会额外上传这个命名的 x64 副本）
function assetCandidates(version) {
  const v = String(version).replace(/^v/i, '')
  const names = [`AiRoute-${v}-${ARCH}.${EXT}`]
  if (!IS_MAC) names.push('AiRoute.exe')
  return names
}

// 版本校验文件固定跟着 tag 走；API 通道优先用资产里的 browser_download_url，302 通道按约定拼
function checksumsUrl(tag) {
  return `https://github.com/${REPO}/releases/download/${tag}/${CHECKSUM_ASSET}`
}

// 统一 SHA-256 形态：小写、去掉 GitHub API 的 "sha256:" 前缀
function normalizeSha(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '')
}

// 解析 sha256sum 格式（<64 位十六进制><空格><可选 *><文件名>），返回 { 文件名: 哈希 }
function parseChecksums(text) {
  const map = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const matched = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (matched) map[matched[2].trim()] = matched[1].toLowerCase()
  }
  return map
}

let cached = null // 检查结果缓存 { at, data }
let downloadState = { status: 'idle', mode: '', stage: '', tag: '', assetName: '', savePath: '', received: 0, total: 0, error: '', sha256: '', version: '', artifactPath: '' } // 下载状态

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

// 通道一：GitHub API，信息最全（更新说明 / 发布时间 / 安装包大小 / 资产 digest）
async function fetchByApi() {
  const res = await axios.get(`https://api.github.com/repos/${REPO}/releases/latest`, {
    timeout: 8000,
    headers: { 'User-Agent': 'AiRoute', Accept: 'application/vnd.github+json' },
    validateStatus: s => s === 200
  })
  const data = res.data || {}
  if (!data.tag_name) throw new Error('API 返回缺少 tag_name')
  const names = assetCandidates(data.tag_name)
  const asset = names.map(name => (data.assets || []).find(a => a.name === name)).find(Boolean)
  const checksumAsset = (data.assets || []).find(a => a.name === CHECKSUM_ASSET)
  return {
    tag: data.tag_name,
    notes: data.body || '',
    publishedAt: data.published_at || '',
    size: asset ? asset.size : 0,
    assetName: asset ? asset.name : '',
    assetDigest: asset ? asset.digest || '' : '',
    checksumsUrl: checksumAsset ? checksumAsset.browser_download_url || '' : '',
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
  return { tag: matched[1], notes: '', publishedAt: '', size: 0, assetName: '', assetDigest: '', checksumsUrl: '', pageUrl: `https://github.com/${REPO}/releases/tag/${matched[1]}` }
}

// 检查更新：force=true 跳过 30 分钟缓存（设置页手动检查用）
async function checkUpdate(force) {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.data
  let info
  let channel = 'api'
  try {
    info = await fetchByApi()
  } catch {
    channel = 'redirect'
    info = await fetchByRedirect()
  }
  const current = getLocalVersion()
  const latest = info.tag.replace(/^v/i, '')
  const assetName = info.assetName || assetCandidates(info.tag)[0]
  const data = {
    current,
    latest,
    tag: info.tag,
    hasUpdate: compareVersion(latest, current) > 0,
    channel,
    pageUrl: info.pageUrl,
    notes: info.notes,
    publishedAt: info.publishedAt,
    size: info.size,
    platform: IS_MAC ? 'mac' : 'win',
    arch: ARCH,
    assetName,
    // GitHub API 对资产直接给出的 SHA-256（部分版本才有），没有时由 SHA256SUMS.txt 兜底
    sha256: info.assetName === assetName ? normalizeSha(info.assetDigest) : '',
    checksumsUrl: info.checksumsUrl || checksumsUrl(info.tag),
    downloadUrl: `https://github.com/${REPO}/releases/download/${info.tag}/${assetName}`
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

// 下载 SHA256SUMS.txt 并解析；网络不可用/404 时抛错，由调用方决定是否降级到 API digest
async function fetchChecksums(url) {
  const res = await axios.get(url, {
    timeout: 10000,
    responseType: 'text',
    transformResponse: [data => data],
    headers: { 'User-Agent': 'Mozilla/5.0' },
    maxRedirects: 5,
    validateStatus: s => s === 200
  })
  const map = parseChecksums(res.data)
  if (!Object.keys(map).length) throw new Error('校验文件内容为空')
  return map
}

// 启动一键升级下载：校验并重置状态后异步执行；下载中重复触发直接抛错
function startInstall(tag) {
  if (downloadState.status === 'downloading') throw new Error('已有下载任务进行中')
  if (!tag || typeof tag !== 'string') throw new Error('缺少版本号')
  downloadState = {
    status: 'downloading',
    mode: 'install',
    stage: 'downloading',
    tag,
    assetName: '',
    savePath: '',
    received: 0,
    total: 0,
    error: '',
    sha256: '',
    version: String(tag).replace(/^v/i, ''),
    artifactPath: ''
  }
  runInstall(tag)
  return getDownloadState()
}

// 单个资产的流式下载：边下边算 SHA-256，完成后按 Content-Length 校验大小
function downloadInstallAsset(tag, assetName, partPath) {
  const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`
  return axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }).then(res => {
    downloadState.received = 0
    downloadState.total = Number(res.headers['content-length'] || 0)
    const hash = crypto.createHash('sha256')
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(partPath)
      res.data.on('data', chunk => {
        hash.update(chunk)
        downloadState.received += chunk.length
      })
      res.data.on('error', reject)
      ws.on('error', reject)
      ws.on('finish', () => {
        if (downloadState.total && downloadState.received !== downloadState.total) {
          reject(new Error('文件大小校验失败，请重试'))
          return
        }
        resolve(hash.digest('hex'))
      })
      res.data.pipe(ws)
    })
  })
}

// 实际执行一键升级下载：按候选资产名依次尝试（Windows 新命名优先，回落到旧名 AiRoute.exe），
// 下载完成后必须拿到 SHA-256 并校验通过才置为 done；校验值缺失时拒绝自动升级（不静默降级）
async function runInstall(tag) {
  const version = String(tag).replace(/^v/i, '')
  const dir = path.join(UPDATE_DIR, tag.replace(/[^\w.-]/g, '_'))
  const info = cached && cached.data && cached.data.tag === tag ? cached.data : null
  let sums = null
  let sumsError = ''
  try {
    sums = await fetchChecksums((info && info.checksumsUrl) || checksumsUrl(tag))
  } catch (e) {
    sumsError = e.message || '校验文件获取失败'
  }
  try {
    fs.ensureDirSync(dir)
  } catch (e) {
    downloadState.status = 'error'
    downloadState.stage = 'error'
    downloadState.error = e.message || '无法创建下载目录'
    return
  }
  const errors = []
  for (const assetName of assetCandidates(tag)) {
    const partPath = path.join(dir, `${assetName}.part`)
    const destPath = path.join(dir, assetName)
    try {
      const actual = await downloadInstallAsset(tag, assetName, partPath)
      downloadState.stage = 'verifying'
      const expected = (info && info.assetName === assetName && info.sha256) || (sums && sums[assetName]) || ''
      if (!expected) {
        throw new Error(sumsError ? `无法获取 SHA-256 校验文件（${sumsError}）` : '该版本未提供 SHA-256 校验值')
      }
      if (actual !== expected) throw new Error('SHA-256 校验失败')
      fs.moveSync(partPath, destPath, { overwrite: true })
      downloadState.assetName = assetName
      downloadState.savePath = destPath
      downloadState.artifactPath = destPath
      downloadState.sha256 = expected
      downloadState.version = version
      downloadState.stage = 'done'
      downloadState.status = 'done'
      return
    } catch (e) {
      errors.push(`${assetName}: ${e.message || '下载失败'}`)
      try { fs.removeSync(partPath) } catch {}
      try { fs.removeSync(destPath) } catch {}
      // 已经拿到文件但校验不通过时，换资产名重试没有意义，直接失败
      if (/SHA-256|校验/.test(e.message || '')) break
    }
  }
  downloadState.status = 'error'
  downloadState.stage = 'error'
  downloadState.error = errors.join('；') || '下载失败'
}

// 启动手动下载（另存为）：保持旧行为，供 Windows 与自动替换失败时使用
function startDownload(tag, savePath) {
  if (downloadState.status === 'downloading') throw new Error('已有下载任务进行中')
  if (!tag || !savePath) throw new Error('缺少版本号或保存路径')
  downloadState = {
    status: 'downloading',
    mode: 'manual',
    stage: 'downloading',
    tag,
    assetName: '',
    savePath,
    received: 0,
    total: 0,
    error: '',
    sha256: '',
    version: String(tag).replace(/^v/i, ''),
    artifactPath: ''
  }
  runDownload(tag, savePath)
  return getDownloadState()
}

// 单个资产的流式下载：完成后按 Content-Length 校验大小，异常抛错交给候选循环
async function downloadAsset(tag, assetName, savePath) {
  const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  downloadState.received = 0
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
}

// 实际执行手动下载：按候选资产名依次尝试（新命名优先，Windows 回落到旧名 AiRoute.exe），
// 失败的分支会清掉半截文件，全部失败才置为 error 并汇总原因
async function runDownload(tag, savePath) {
  try {
    fs.ensureDirSync(path.dirname(savePath))
  } catch (e) {
    downloadState.status = 'error'
    downloadState.stage = 'error'
    downloadState.error = e.message || '下载失败'
    return
  }
  const errors = []
  for (const assetName of assetCandidates(tag)) {
    try {
      await downloadAsset(tag, assetName, savePath)
      downloadState.assetName = assetName
      downloadState.stage = 'done'
      downloadState.status = 'done'
      return
    } catch (e) {
      errors.push(`${assetName}: ${e.message || '下载失败'}`)
      try { fs.removeSync(savePath) } catch {}
    }
  }
  downloadState.status = 'error'
  downloadState.stage = 'error'
  downloadState.error = errors.join('；')
}

// assetCandidates 一并导出：离线测试用来锁死「构建产物名 ↔ 应用内更新拼出的下载名」这条约定
module.exports = {
  checkUpdate,
  startDownload,
  startInstall,
  getDownloadState,
  getLocalVersion,
  assetCandidates,
  compareVersion,
  parseChecksums,
  normalizeSha,
  UPDATE_DIR
}
