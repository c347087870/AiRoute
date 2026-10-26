// Trae 渠道插件
//
// 插件包 = 一份清单 + 一个 create()。宿主（plugin-host.js）按清单里的
// `providers` 建索引，按 `create(ctx)` 拿后端。协议实现仍在 provider.js /
// protocol.js，本文件只做三件事：声明我是谁、把宿主 API 递进去、
// **把后端的方法表适配成插件的统一 ABI**。
//
// 为什么要这层适配：统一 ABI 是「所有方法第一个参数是 provider」
// （见 plugin-api.js），因为一个包可能带多个 provider。Trae 的后端只有一个
// provider，签名里本来就没有它 —— 在这层补/去掉，比去改一个能跑通的
// 协议实现安全得多。
//
// 为什么清单写在代码里而不是单独的 plugin.json：插件可以被 `plugin add`
// 从任意目录装进来，多一个 JSON 就多一种「清单与代码不同步」的状态；
// 这里 require 得到的就是真相。

const PROVIDERS = { trae: { name: 'Trae (字节)' } }
// 渠道包时代的凭据键前缀：同一个文件、同一套键，只补注册表条目
const LEGACY_PREFIX = 'TRAE_ACCOUNT_'

module.exports = {
  id: 'trae',
  name: 'Trae',
  providers: PROVIDERS,
  // 有签到端点（checkin_credits）才申报：面板据此画「领取积分」
  checkinProviders: ['trae'],
  create(ctx) {
    const { createTrae } = require('./provider')
    const Trae = createTrae({
      dataDir: ctx.dataDir,
      logger: ctx.logger,
      credentials: ctx.credentials,
      login: ctx.loginServer,
    })

    return {
      // 清单是插件自己的声明，以这里为准（后端只报自己要管的 provider）
      providers: Object.keys(PROVIDERS),

      listAccounts: () => Trae.listAccounts(),
      listModels: () => Trae.listModels(),
      complete: (provider, request, onChunk, signal) =>
        Trae.complete({ model: request.model, openAi: request.openAi }, onChunk, signal),

      updateAccount: (provider, uid, patch) => Trae.updateAccount(uid, patch),
      removeAccount: (provider, uid) => Trae.removeAccount(uid),
      refreshAccount: (provider, uid) => Trae.refreshAccount(uid),
      startLogin: () => Trae.startLogin(),
      checkin: (provider, uid) => Trae.checkin(uid),
      balance: (provider, uid) => Trae.balance(uid),
      refresh: () => Trae.refresh(),
      setEvents: handlers => Trae.setEvents(handlers),
      shutdown: () => Trae.shutdown(),

      // 认领渠道包时代留下的账号：凭据文件里已经在了，这里只按键前缀补注册表。
      // 放在插件里而不是宿主里 —— 「谁持有什么键」是插件自己的事实。
      importLegacy() {
        let imported = 0
        const all = ctx.credentials.readCredentials(ctx.dataDir)
        for (const [key, raw] of Object.entries(all)) {
          if (!key.startsWith(LEGACY_PREFIX)) continue
          const credential = ctx.credentials.parseCredentialValue(raw)
          // 没有 uid 的凭据无法建立账号（续期与补全都依赖它）
          if (!credential || typeof credential !== 'object' || typeof credential.uid !== 'string' || !credential.uid) continue
          // suffix 取自真实键名：账号 id 因此与渠道包时代完全一致
          Trae.importLegacy({ uid: credential.uid, credential, suffix: key.slice(LEGACY_PREFIX.length).toLowerCase() })
          imported++
        }
        return imported
      },
    }
  },
}
