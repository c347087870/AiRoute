// Qoder 渠道插件（国际版 + 国内版）
//
// 两家是同一个产品在两套站点上的账号体系（qoder.com / qoder.cn），协议同形，
// 差别全在 protocol.PRODUCTS 里 —— 所以一个插件带两个 provider，
// 而不是拆成两个包让宿主去猜它们的协议是不是同一份。
//
// 加密推理要的 qoder-auth-wasm.wasm 必须与本文件同目录：wasm.js 按
// __dirname 定位它（移动插件目录时两个文件要一起搬）。
//
// 本文件同样只做声明 + ABI 适配（见 trae/index.js 的说明）。

const PROVIDERS = {
  qoder: { name: 'Qoder' },
  qodercn: { name: 'Qoder (国内版)' },
}

// 渠道包时代的凭据键前缀（两家在同一个凭据文件里，前缀不同）
const LEGACY_PREFIXES = {
  qoder: 'QODER_ACCOUNT_',
  qodercn: 'QODERCN_ACCOUNT_',
}

module.exports = {
  id: 'qoder',
  name: 'Qoder',
  providers: PROVIDERS,
  // 每日领取走「活动平台」（campaigns → claim）：接口不存在时插件自己回落到旧签到，
  // 两者都没有才报「本区域未开放」。所以两家都该申报 —— 面板的「签到」按钮由它决定
  checkinProviders: ['qoder', 'qodercn'],
  create(ctx) {
    const { createQoder } = require('./provider')
    const qoder = createQoder({
      dataDir: ctx.dataDir,
      logger: ctx.logger,
      credentials: ctx.credentials,
      // 冷却/并发/选号参数（面板「渠道设置」内页可改）
      settings: ctx.settings,
      // 官网版本号同步（每天自动拉 qoder.com/changelog 的最新 IDE 版本）
      versions: ctx.versions,
    })

    return {
      providers: Object.keys(PROVIDERS),

      listAccounts: provider => qoder.listAccounts(provider),
      listModels: provider => qoder.listModels(provider),
      complete: (provider, request, onChunk, signal) =>
        qoder.complete({ provider, model: request.model, openAi: request.openAi }, onChunk, signal),

      updateAccount: (provider, uid, patch) => qoder.updateAccount(provider, uid, patch),
      removeAccount: (provider, uid) => qoder.removeAccount(provider, uid),
      refreshAccount: (provider, uid) => qoder.refreshAccount(provider, uid),
      startLogin: provider => qoder.startLogin(provider),
      pollLogin: (provider, state) => qoder.pollLogin(provider, state),
      checkin: (provider, uid) => qoder.checkin(provider, uid),
      balance: (provider, uid) => qoder.balance(provider, uid),
      refresh: () => qoder.refresh(),
      setEvents: handlers => qoder.setEvents(handlers),
      shutdown: () => qoder.shutdown(),

      importLegacy(only) {
        let imported = 0
        const all = ctx.credentials.readCredentials(ctx.dataDir)
        for (const [provider, prefix] of Object.entries(LEGACY_PREFIXES)) {
          if (only && only !== provider) continue
          for (const [key, raw] of Object.entries(all)) {
            if (!key.startsWith(prefix)) continue
            const credential = ctx.credentials.parseCredentialValue(raw)
            if (!credential || typeof credential !== 'object' || typeof credential.uid !== 'string' || !credential.uid) continue
            qoder.importLegacy(provider, { uid: credential.uid, credential, suffix: key.slice(prefix.length).toLowerCase() })
            imported++
          }
        }
        return imported
      },
    }
  },
}
