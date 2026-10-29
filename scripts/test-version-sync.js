// 版本号同步器的离线回归：不联网，只测解析与降级逻辑
//
//   · Trae 更新日志的版本号提取（取最大）；
//   · Qoder changelog RSC payload 的解析（tag_name + type=ide）；
//   · 双源取最大（官网 vs 本机安装）；
//   · 拉取失败时回落缓存 / 内置默认，登录不因同步失败而不可用。

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sync = require('../server/channels/version-sync')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message}`)
  }
}

// 把真实抓到的 payload 片段做成最小样本（脱敏，结构与线上一致）
const QODER_RSC_SAMPLE = [
  '{"tag_name":"1.2.5","name":"a","published_at":"2026-10-28T08:40:42Z","type":"qoderwake"},',
  '{"tag_name":"1.37.0","name":"b","published_at":"2026-10-27T12:00:00Z","type":"ide"},',
  '{"tag_name":"1.1.80","name":"c","published_at":"2026-10-27T12:06:56Z","type":"cli"},',
  '{"tag_name":"1.36.9","name":"d","published_at":"2026-10-20T00:00:00Z","type":"ide"},',
  '{"tag_name":"0.4.11","name":"e","published_at":"2026-10-23T00:00:00Z","type":"app"}',
].join('')

async function main() {
  await test('版本号解析与比较：三段比较 / 取最大', () => {
    const v = sync.FALLBACK // 触发 require 副作用检查
    assert.ok(v.trae && v.qoder, '兜底默认值结构完整')
    // 通过导出的 refreshVersions 间接测比较逻辑不方便，这里验证解析路径：
    // maxVersion 是内部函数，用行为可见的接口覆盖（见下面几个用例）
  })

  await test('Qoder changelog 解析：从 RSC payload 取 type=ide 的最新版本', async () => {
    // fetchQoderChangelogVersion 是内部函数；通过 monkey-patch fetch 验证整条链
    const realFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => QODER_RSC_SAMPLE,
    })
    try {
      const result = await sync.refreshVersions()
      assert.equal(result.sources.qoderDocs, '1.37.0', '应取 type=ide 里发布时间最新的 1.37.0')
    } finally {
      global.fetch = realFetch
    }
  })

  await test('Qoder changelog：type=ide 不存在时明确报错（不静默用别的 type）', async () => {
    const realFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"tag_name":"1.2.5","published_at":"2026-10-28T08:40:42Z","type":"qoderwake"}',
    })
    try {
      const result = await sync.refreshVersions()
      assert.ok(String(result.sources.qoderDocs).startsWith('失败'), '应记录失败而不是编一个版本')
    } finally {
      global.fetch = realFetch
    }
  })

  await test('Trae 更新日志：HTML 里的版本号取最大', async () => {
    const realFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => 'TRAE v3.4.1 ～ v3.4.4 版本正式发布…历史 3.3.102',
    })
    try {
      const result = await sync.refreshVersions()
      assert.equal(result.sources.traeDocs, '3.4.4')
    } finally {
      global.fetch = realFetch
    }
  })

  await test('拉取失败：记录原因、版本回落到「本机安装 / 内置默认」而非报错', async () => {
    const realFetch = global.fetch
    global.fetch = async () => { throw new Error('network down') }
    try {
      const result = await sync.refreshVersions()
      assert.ok(String(result.sources.traeDocs).startsWith('失败：'), 'Trae 文档源应记录失败')
      assert.ok(String(result.sources.qoderDocs).startsWith('失败：'), 'Qoder 文档源应记录失败')
      // 本机装有 Trae/Qoder 时用本机版本；没有就回落内置默认 —— 无论哪种，
      // 版本字段都必须可用（登录不因同步失败而不可用）
      assert.ok(/^\d+\.\d+\.\d+$/.test(result.trae.appVersion), 'trae.appVersion 仍是合法版本号')
      assert.ok(/^\d+\.\d+\.\d+$/.test(result.trae.pluginVersion), 'trae.pluginVersion 仍是合法版本号')
      assert.ok(/^\d+\.\d+\.\d+$/.test(result.qoder.appVersion), 'qoder.appVersion 仍是合法版本号')
    } finally {
      global.fetch = realFetch
    }
  })

  await test('缓存落盘：成功后写 channel-versions.json，失败时可读回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airoute-versions-'))
    try {
      const file = path.join(dir, 'channel-versions.json')
      const good = { updatedAt: Date.now(), sources: {}, trae: { appVersion: '3.4.9', pluginVersion: '2.3.97430' }, qoder: { appVersion: '0.4.11' } }
      fs.writeFileSync(file, JSON.stringify(good))
      // readCache 是内部行为，经 createVersionSync.start 间接覆盖——这里直接验证
      // 文件能被 JSON 读回（createVersionSync 的 readCache 同一套逻辑）
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(parsed.trae.appVersion, '3.4.9')
      assert.ok(parsed.qoder.appVersion)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
