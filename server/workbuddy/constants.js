// WorkBuddy（腾讯 CodeBuddy）上游协议常量
// 全部取值来自参考项目 Go 源码的逐行翻译，勿凭经验增删

// ===== 域名 =====
const CHAT_BASE_CN = 'https://copilot.tencent.com' // CN 聊天域
const BILLING_BASE_CN = 'https://www.codebuddy.cn' // CN 计费域
const WEB_BASE_CN = 'https://www.workbuddy.cn' // CN 官网域

// ===== 出站 Origin / Referer =====
const ORIGIN_REFERER_CN = 'https://www.codebuddy.cn' // 出站 Origin/Referer 基础域

// ===== 版本号（可被配置覆盖）=====
const DEFAULT_CLIENT_VERSION = '5.5.4' // UA 的 WorkBuddy/<ver> 与 X-IDE-Version
const DEFAULT_CLI_VERSION = '2.137.1' // UA 的 CLI/<ver> 段
const DESKTOP_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1' // 桌面端事件链 UA
const CODEBUDDY_IDE_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0' // /v3/config 探测 UA
const CODEBUDDY_CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2' // OAuth 设备授权流程 UA

// ===== 路径 =====
const CHAT_COMPLETIONS_PATH = '/v2/chat/completions' // 聊天唯一出站路径
const TOKEN_REFRESH_PATH = '/v2/plugin/auth/token/refresh' // access token 刷新
const REPORT_PATH = '/v2/report' // 活跃上报 / 桌面端事件上报
const MODELS_ENTERPRISE_PATH = '/console/enterprises/personal/models' // 企业模型目录（探路首选）
const V3_CONFIG_PATH = '/v3/config' // 官方 IDE 配置目录（模型 + 促销）
const DASHBOARD_MODELS_PATH = '/v2/dashboard/models' // 模型探测路径（探测路之二）

// 计费域路径
const BILLING_METER_PATH_V2 = '/v2/billing/meter/get-user-resource'
const DAILY_CHECKIN_PATH_V2 = '/v2/billing/meter/daily-checkin'

// growth 域路径（挂 chatBase，无 /v2 前缀）
const BUDDY_STATUS_PATH = '/activity/growth/buddy/travel/status'
const BUDDY_DEPART_PATH = '/activity/growth/buddy/travel/depart'
const BUDDY_CLAIM_PATH = '/activity/growth/buddy/travel/claim'
const BUDDY_INFO_PATH = '/activity/growth/buddy/info'
const BUDDY_FIRST_PATH = '/activity/growth/buddy/first'
const BUDDY_AGREEMENT_PATH = '/activity/growth/buddy/agreement'
const GROWTH_STREAK_PATH = '/activity/growth/streak'
const GROWTH_REDEEM_PATH = '/activity/growth/redeem'
const LOTTERY_SUMMARY_PATH = '/activity/growth/lottery/summary'
const LOTTERY_DRAW_PATH = '/activity/growth/lottery/draw'
const GROWTH_TASKS_PATH = '/v2/activity/growth/tasks'
const GROWTH_TASKS_ACCEPT_PATH = '/v2/activity/growth/tasks/accept'
const GROWTH_TASKS_CLAIM_PATH = '/v2/activity/growth/tasks/reward/claim'
const APPEARANCE_SET_PATH = '/v2/user-asset/appearance/set'

// OAuth 路径（挂 chatBase）
const OAUTH_STATE_PATH = '/v2/plugin/auth/state' // 取授权 URL
const OAUTH_TOKEN_PATH = '/v2/plugin/auth/token' // 轮询取 token
const OAUTH_ACCOUNT_PATH = '/v2/plugin/login/account' // 取账号信息

// ===== 超时（毫秒）=====
const TIMEOUT_DEFAULTS = {
  timeoutMs: 120000, // 短 RPC 总时长上限
  headerTimeoutMs: 60000, // 聊天首字节前上限
  idleTimeoutMs: 300000, // 聊天流中空闲上限
  refreshTimeoutMs: 30000 // token 刷新 I/O 上限
}

// ===== 冷却与池参数默认值 =====
const POOL_DEFAULTS = {
  softRateMs: 600000, // 软冷却基数 600s
  softRateMaxMs: 7200000, // 软冷却指数退避封顶 2h
  notFoundCooldownMs: 60000, // 404 固定短冷却 60s
  breakerThreshold: 3, // 连续失败触发熔断阈值
  breakerCooldownMs: 1800000, // 熔断基础退避 30m
  breakerCooldownMaxMs: 21600000, // 熔断退避封顶 6h
  degradeThreshold: 5, // 连败降权阈值
  degradeCooldownMs: 600000, // 连败降权时长 10m
  degradeCooldownMaxMs: 7200000, // 连败降权封顶 2h
  maxInFlight: 3, // 单账号最大在途请求数（0=不限）
  minPickGapMs: 100, // 防惊群：同账号最短重选间隔
  idleWeightPerHour: 0.5, // 闲置补偿：每小时未使用权重增量
  idleWeightMax: 5.0, // 闲置补偿权重封顶
  expiringSoonMs: 168 * 3600000, // 快过期路由窗口 168h
  sessionStickyTtlMs: 1800000, // 会话绑定 TTL 30m
  sessionStickyGcMs: 300000, // 会话绑定 GC 周期 5m
  costExploreMs: 30 * 60 * 1000 // 成本探索间隔 30 分钟（0=关停）
}

// ===== 定时任务默认排程（本地时区整点）=====
const SCHEDULE_DEFAULTS = {
  checkinHours: [9, 21], // 签到 + 余额查询
  travelHours: [9, 21], // 猫猫旅行
  activityHours: [10], // 活跃上报
  keepaliveHours: [22], // token 保活
  blackcatHours: [23], // 夜猫子补足
  growthHours: [1], // 成长任务队列（Sequential 族每日零点解锁一环，01:00 扫描+执行）
  checkinEnabled: true,
  travelEnabled: true,
  activityEnabled: true,
  keepaliveEnabled: true,
  blackcatEnabled: true,
  growthEnabled: true,
  balanceRefreshMinutes: 5 // 余额后台刷新周期（分钟）
}

// ===== 会话失效阈值 =====
const SESSION_DEAD_THRESHOLD = 3 // 12153 连续 N 次才永久禁用
const MAX_ROTATE = 3 // 单请求最多换号次数

// ===== 轮转退避（参照 server/backoff.go）=====
const ROTATE_BACKOFF = {
  baseMs: 500, // 轮转退避基数（首次换号前等待）
  capMs: 8000, // 退避封顶 8s
  jitterFraction: 0.25 // ±25% 均匀抖动（打散同相位重试）
}

// ===== 连接层参数（参照 upstream/transport.go）=====
const TRANSPORT_DEFAULTS = {
  keepAliveMsecs: 15000, // TCP keepalive 探测周期 15s
  maxSockets: 64, // 单主机最大并发连接
  maxFreeSockets: 20 // 空闲连接池保留数
}

// ===== 设备令牌文件（参照 upstream/device_token.go）=====
const DEVICE_TOKEN_FILE = {
  cacheTtlMs: 5 * 60 * 1000, // 文件读取缓存 5 分钟
  maxLen: 1024 // 超过 1KB 视为异常，忽略不注入
}

// ===== WAF IP 级 fail-fast（参照 server/wafip.go）=====
const WAF_IP = {
  windowMs: 60 * 1000, // 判定滑动窗 + 激活时长 60s
  threshold: 2 // 窗内不同账号命中 WAF 403 达阈值即判 IP 级拦截
}

// ===== 派发地点 =====
const TRAVEL_LOCATION_ID = 4 // 古镇客栈（4 个地点收益/时长相同，无最优解）

// ===== 模型目录兜底链（catalog.js / modelsdev.js）=====
const MODELS_DEV_URL = 'https://models.dev/api.json' // models.dev 聚合目录端点（兜底第 4 级）
const MODEL_CATALOG_FILE = 'model.json' // 模型能力缓存文件名（置于数据目录，读失败静默降级）

// ===== 用量 / 积分消耗统计（usage.js）=====
const USAGE_HOURLY_KEEP_HOURS = 90 * 24 // 小时桶保留上限（90 天），超出折叠为日桶且永久保留
const USAGE_MAX_BUCKETS = 400000 // 桶数硬上限，超出时优先折叠最旧小时桶
const USAGE_FLUSH_MS = 30 * 1000 // 防抖自动落盘间隔 30s
const USAGE_HOURS_DEFAULT = 72 // 用量窗口默认 72 小时
const USAGE_HOURS_MAX = 1440 // 用量窗口上限 1440 小时（60 天）；0 表示全部历史

module.exports = {
  CHAT_BASE_CN,
  BILLING_BASE_CN,
  WEB_BASE_CN,
  ORIGIN_REFERER_CN,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_CLI_VERSION,
  DESKTOP_UA,
  CODEBUDDY_IDE_UA,
  CODEBUDDY_CLI_UA,
  CHAT_COMPLETIONS_PATH,
  TOKEN_REFRESH_PATH,
  REPORT_PATH,
  MODELS_ENTERPRISE_PATH,
  V3_CONFIG_PATH,
  DASHBOARD_MODELS_PATH,
  BILLING_METER_PATH_V2,
  DAILY_CHECKIN_PATH_V2,
  BUDDY_STATUS_PATH,
  BUDDY_DEPART_PATH,
  BUDDY_CLAIM_PATH,
  BUDDY_INFO_PATH,
  BUDDY_FIRST_PATH,
  BUDDY_AGREEMENT_PATH,
  GROWTH_STREAK_PATH,
  GROWTH_REDEEM_PATH,
  LOTTERY_SUMMARY_PATH,
  LOTTERY_DRAW_PATH,
  GROWTH_TASKS_PATH,
  GROWTH_TASKS_ACCEPT_PATH,
  GROWTH_TASKS_CLAIM_PATH,
  APPEARANCE_SET_PATH,
  OAUTH_STATE_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_ACCOUNT_PATH,
  TIMEOUT_DEFAULTS,
  POOL_DEFAULTS,
  SCHEDULE_DEFAULTS,
  SESSION_DEAD_THRESHOLD,
  MAX_ROTATE,
  TRAVEL_LOCATION_ID,
  ROTATE_BACKOFF,
  TRANSPORT_DEFAULTS,
  DEVICE_TOKEN_FILE,
  WAF_IP,
  MODELS_DEV_URL,
  MODEL_CATALOG_FILE,
  USAGE_HOURLY_KEEP_HOURS,
  USAGE_MAX_BUCKETS,
  USAGE_FLUSH_MS,
  USAGE_HOURS_DEFAULT,
  USAGE_HOURS_MAX
}