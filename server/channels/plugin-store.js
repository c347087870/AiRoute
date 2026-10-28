// 渠道插件清单：装了什么、开没开、从哪来
//
// 状态落在 `<dataDir>/channels-plugins.json`，与账号凭据分开：
// 凭据是「用户的数据」，清单是「用户装了什么」—— 重置清单不该动账号，
// 反过来也一样。
//
// 三条硬规则（都是踩过的坑）：
//   1. **内置插件不允许被删**：删掉 qoder 的包，已登录的账号就再也读不到目录，
//      而用户只会看到「渠道不见了」。所以内置项只允许 off，不允许 rm。
//   2. **清单里没有的 provider 一律不加载**：这是「卸装」的唯一含义 ——
//      不是删代码，而是这个进程不再挂它。
//   3. **写盘失败不吞**：装/卸是用户显式动作，落盘失败必须让他知道，
//      否则重启后插件又回来了。

const fs = require('fs')
const path = require('path')

const BUILTIN_PLUGINS = [
  { id: 'trae', path: 'plugins/trae', builtin: true },
  { id: 'qoder', path: 'plugins/qoder', builtin: true },
]

// 清单文件缺省内容：内置插件全部启用（新装用户与老用户升级后的行为一致）
function defaults() {
  return {
    plugins: BUILTIN_PLUGINS.map(item => ({
      id: item.id,
      spec: item.builtin ? `builtin:${item.id}` : item.path,
      builtin: item.builtin === true,
      enabled: true,
      // 从别的目录/包装进来的插件才有：绝对路径或 npm 包名
      source: item.path,
    })),
  }
}

function createPluginStore({ dataDir, logger = console }) {
  const file = path.join(dataDir, 'channels-plugins.json')

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed?.plugins)) return defaults()
      // 内置插件始终补齐：清单可能是老版本写的（那时只有 trae），
      // 少一家就少一张卡，而这不该靠用户重新装一次来修
      const plugins = parsed.plugins.filter(item => item && typeof item.id === 'string')
      const known = new Set(plugins.map(item => item.id))
      for (const builtin of BUILTIN_PLUGINS) {
        if (known.has(builtin.id)) continue
        plugins.push({
          id: builtin.id,
          spec: `builtin:${builtin.id}`,
          builtin: true,
          enabled: true,
          source: builtin.path,
        })
      }
      return { plugins }
    } catch {
      return defaults()
    }
  }

  function write(state) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, file)
  }

  // 解析一项的真实入口：内置项按代码目录推，外部项按 source 的绝对/相对路径推。
  // 找不到就返回 ''，调用方据此报「插件文件缺失」而不是抛一个 ENOENT 栈。
  function resolveEntry(item) {
    const base = item.builtin
      ? path.join(__dirname, item.source || `plugins/${item.id}`)
      : path.resolve(item.source || '')
    if (!base) return { dir: '', entry: '' }
    // 允许 source 指到目录或直接指到入口文件
    let entry = base
    try {
      if (fs.statSync(base).isDirectory()) entry = path.join(base, 'index.js')
    } catch {
      return { dir: base, entry: '' }
    }
    return { dir: base, entry: fs.existsSync(entry) ? entry : '' }
  }

  return {
    file,
    list: () => read().plugins,
    enabled: () => read().plugins.filter(item => item.enabled !== false),
    resolveEntry,
    get(id) {
      return read().plugins.find(item => item.id === id) || null
    },
    // 装一个：同 id 覆盖（这是「升级」的语义），保留原来的 enabled
    add({ id, source, builtin = false, name = '' }) {
      if (!id || !source) throw new Error('安装插件需要 id 与来源')
      const state = read()
      const index = state.plugins.findIndex(item => item.id === id)
      const next = {
        id,
        spec: builtin ? `builtin:${id}` : source,
        builtin,
        enabled: true,
        source,
        ...name ? { name } : {},
      }
      if (index === -1) state.plugins.push(next)
      else state.plugins[index] = { ...state.plugins[index], ...next, enabled: state.plugins[index].enabled !== false }
      write(state)
      logger.info?.(`[channels] 已安装插件 ${id}（${source}）`)
      return next
    },
    remove(id) {
      const state = read()
      const item = state.plugins.find(entry => entry.id === id)
      if (!item) return false
      // 内置插件只允许停用：删掉清单项与「用户想卸载」是两件事，
      // 而内置项的代码还在包里，删了记录只会让下次启动又补回来
      if (item.builtin) throw new Error(`内置插件 ${id} 不能删除，只能停用`)
      state.plugins = state.plugins.filter(entry => entry.id !== id)
      write(state)
      logger.info?.(`[channels] 已移除插件 ${id}`)
      return true
    },
    setEnabled(id, enabled) {
      const state = read()
      const item = state.plugins.find(entry => entry.id === id)
      if (!item) throw new Error(`没有这个插件：${id}`)
      item.enabled = enabled !== false
      write(state)
      return item
    },
  }
}

module.exports = { createPluginStore, BUILTIN_PLUGINS }
