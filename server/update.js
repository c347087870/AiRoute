// 更新检查与下载：双通道获取 GitHub 最新版本（API 优先，限速/不可达时退回 302 解析），
// 流式下载安装包到用户指定路径并维护进度，供 /api/update/* 路由使用
const axios = require('axios')
const fs = require('fs-extra')
const path = require('path')

const REPO = 'c347087870/AiRoute'
const ASSET_NAME = 'AiRoute.exe'
const CACHE_TTL = 30 * 60 * 1000

let cached = null // 检查结果缓存 { at, data }
let downloadState = { status: 'idle', tag: '', savePath: '', received: 0, total: 0, error: '' } // 下载状态

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
  const asset = (data.assets || []).find(a => a.name === ASSET_NAME)
  return {
    tag: data.tag_name,
    notes: data.body || '',
    publishedAt: data.published_at || '',
    size: asset ? asset.size : 0,
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
  return { tag: matched[1], notes: '', publishedAt: '', size: 0, pageUrl: `https://github.com/${REPO}/releases/tag/${matched[1]}` }
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
    downloadUrl: `https://github.com/${REPO}/releases/download/${info.tag}/${ASSET_NAME}`
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
function startDownload(tag, savePath) {
  if (downloadState.status === 'downloading') throw new Error('已有下载任务进行中')
  if (!tag || !savePath) throw new Error('缺少版本号或保存路径')
  downloadState = { status: 'downloading', tag, savePath, received: 0, total: 0, error: '' }
  runDownload(tag, savePath)
  return getDownloadState()
}

// 实际执行下载：流式写盘，完成后按 Content-Length 校验大小，异常写入错误状态
async function runDownload(tag, savePath) {
  try {
    fs.ensureDirSync(path.dirname(savePath))
    const url = `https://github.com/${REPO}/releases/download/${tag}/${ASSET_NAME}`
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

module.exports = { checkUpdate, startDownload, getDownloadState, getLocalVersion }
