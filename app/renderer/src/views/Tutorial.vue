<template>
  <div class="tutorial">
    <div class="page-header">
      <h1 class="page-title">使用教程</h1>
    </div>

    <div class="tutorial-content">
      <!-- 一、接入指南 -->
      <section class="section">
        <h2>一、接入指南</h2>
        <p>AiRoute 是本地 LLM 调度网关，同时兼容 Anthropic 与 OpenAI 两种协议。Claude Code、任意 OpenAI 兼容客户端把地址指向下方 URL 即可接入，无需关心真实的上游 API 地址。</p>

        <h3>1. 接入地址</h3>
        <div class="info-row">
          <span class="info-label">本机</span>
          <span class="info-value">{{ localhostUrl }}</span>
        </div>
        <div class="info-row" v-for="ip in lanIPs" :key="ip">
          <span class="info-label">局域网</span>
          <span class="info-value">http://{{ ip }}:{{ serverPort }}</span>
        </div>
        <p class="note" v-if="!lanIPs.length">未检测到可用的局域网 IP：当前设备可能未连接网络，或所有网卡均为虚拟网卡。</p>
        <p class="note">「本机」地址仅本机程序可用；局域网内其他设备（另一台电脑 / 手机）请使用「局域网」地址，两者端口相同。首次从其他设备连接失败时，请检查 Windows 防火墙是否允许 AiRoute 通过（专用网络）。端口可在「设置」页面修改，点击「重启 Server」后生效，本页展示的是当前生效端口。</p>

        <h3>2. 完整路径（少数客户端需要）</h3>
        <div class="info-row">
          <span class="info-label">Anthropic</span>
          <span class="info-value">{{ localhostUrl }}/v1/messages</span>
        </div>
        <div class="info-row">
          <span class="info-label">OpenAI</span>
          <span class="info-value">{{ localhostUrl }}/v1/chat/completions</span>
        </div>
        <p>大多数客户端（如 Claude Code）只需填到端口，工具会自动拼接路径；以上两条仅给需要完整 URL 的客户端使用。局域网设备把 <code>localhost</code> 替换为上方「局域网」地址即可。</p>

        <h3>3. API Key</h3>
        <div class="info-row">
          <span class="info-label">Key</span>
          <span class="info-value">sk-airoute</span>
        </div>
        <p class="note">AiRoute 不校验 API Key，填任意非空字符串即可（推荐 <code>sk-airoute</code>）。</p>
      </section>

      <!-- 二、核心概念 -->
      <section class="section">
        <h2>二、核心概念</h2>

        <h3>Provider（模型来源）</h3>
        <p>Provider 是一条上游 AI 服务的完整配置：接口地址、API Key 与一组模型。AiRoute 支持两类来源：</p>
        <ul>
          <li><strong>通用 Provider</strong>：手动填写 Anthropic / OpenAI 接口地址，适用于任何兼容对应协议的服务</li>
          <li><strong>WorkBuddy 账号池</strong>：通过 OAuth 登录 WorkBuddy 账号后作为一类特殊 Provider 参与路由，账号自动轮转、冷却与故障转移</li>
        </ul>
        <p>一个 Provider 可配置多个模型，列表中的<strong>第一个模型是默认模型</strong>。Anthropic URL 与 OpenAI URL 至少填写一个，请求按客户端使用的协议直接走对应端点。</p>

        <h3>模型引用</h3>
        <p>切换与路由的最小单位是「模型」，引用格式为 <code>Provider名/模型ID</code>，例如 <code>my-provider/model-large</code>。侧边栏切换、路由规则目标、兜底模型全部使用该格式；只写 Provider 名（如 <code>my-provider</code>）时自动取其默认模型。</p>

        <h3>Auto 模式（智能路由）</h3>
        <p>激活模型设为 <code>Auto</code> 后，AiRoute 根据每次请求的内容自动挑选模型：内置 13 种检测条件（包含代码 / 包含 SQL / 中文任务 / 英语请求 / 知识问答 / 创意写作 / 数学计算 / 文本摘要 / 翻译任务 / 代码审查优化 / 编写测试 / 长上下文 / 默认）+ 自定义关键词匹配，命中即路由；都未命中时走「默认」规则，未配置时兜底到第一个可用 Provider。</p>
      </section>

      <!-- 三、功能详解 -->
      <section class="section">
        <h2>三、功能详解</h2>

        <h3>状态面板</h3>
        <ul>
          <li>顶部三张统计卡：当前模型、Router 状态（运行中 / 离线）、请求数（今日 / 近 35 天，含失败数）</li>
          <li>「Token 使用统计」：今日与本月用量（输入 / 缓存读 / 缓存写 / 输出 / 总计）及各模型用量表，右上角「刷新」手动更新</li>
          <li>「快速切换」：按 Provider 分组的模型芯片，点击立即切换；「智能路由」分组下为 Auto</li>
          <li>「最近请求」：最近 5 条请求的时间 / 模型 / 状态 / 耗时 / Token / Fallback，可刷新</li>
        </ul>

        <h3>模型切换</h3>
        <p>四种方式任选，四处状态实时同步，切换对所有已接入的客户端立即生效：</p>
        <ul>
          <li>左侧导航栏底部的「当前模型」下拉框</li>
          <li>状态面板「快速切换」区的模型芯片</li>
          <li>系统托盘图标右键菜单（按 Provider 分组的二级菜单）</li>
          <li>Provider 管理页每个模型芯片上的「切换」按钮</li>
        </ul>

        <h3>Provider 管理</h3>
        <ul>
          <li>右上角「+ 通用 Provider」手动添加；「+ 添加 WorkBuddy 账号池」通过 OAuth 添加账号池来源（已有 WorkBuddy 源时该按钮禁用）</li>
          <li>每个 Provider 显示为一行：显示名、ID、模型芯片（含上下文 / 输出上限）；行内按钮为「测试」（连通性，显示耗时与本次用量）、「编辑」、「设为当前」、「删除」</li>
          <li>新增 / 编辑弹窗字段：名称（ID）、显示名称、Anthropic URL、OpenAI URL、API Key（支持明文 / 密码切换与复制）</li>
          <li>「模型列表」可添加多个模型，逐项填写模型 ID、显示名称、最大上下文、最大输出与推理档位（默认 / low / high / max / xhigh / 自定义）</li>
          <li>删除 Provider 时，指向它的路由规则、兜底配置和当前模型引用会被一并清理（有二次确认）</li>
        </ul>

        <h3>路由规则</h3>
        <ul>
          <li><strong>兜底模型</strong>：主模型失败时自动切换到指定模型（可选「不启用兜底」），选择后点「保存」；兜底也失败则直接返回错误</li>
          <li><strong>智能路由规则</strong>：为 Auto 模式配置「条件 → 目标模型」列表，内置 13 种条件 + 默认；「+ 添加规则」新增，改完点「保存路由规则」</li>
          <li><strong>自定义匹配规则</strong>：当请求包含指定字符串时路由到目标模型，优先级最高；「+ 添加匹配规则」新增，改完点「保存匹配规则」</li>
        </ul>

        <h3>WorkBuddy 账号池（七个页签）</h3>
        <p>顶部统计栏展示账号总数 / 可用 / 冷却 / 禁用，右侧「刷新」。七个页签的功能如下：</p>
        <ul>
          <li><strong>账号池</strong>：「+ 添加账号」通过 OAuth 登录（打开授权链接或复制链接到浏览器完成，页面每 3 秒自动检测结果）；支持「选择模型」「全部签到」「刷新余额」；每行可单独签到、查余额、保活、看详情（冷却 / 熔断 / 在途 / 模型受限明细）、禁用恢复与移除</li>
          <li><strong>积分构成</strong>：按账号查看积分批次（剩余 / 已用 / 总额 / 到期时间 / 周期包）</li>
          <li><strong>模型和档位</strong>：「拉取上游模型」获取可用模型，勾选后「保存启用模型」；可查看每个模型的支持档位与默认档位</li>
          <li><strong>成长任务</strong>：接受任务、一键完成全部、全账号扫描未完成任务、入队执行与领奖</li>
          <li><strong>定时任务</strong>：签到 / 旅行 / 活跃 / 保活 / 夜猫子 / 成长任务 / 余额刷新逐项启用与时点配置，支持「立即执行」与「保存排程」</li>
          <li><strong>高级配置</strong>：提示词模式、指纹脱敏、设备令牌文件可编辑并保存；账号池参数（冷却、熔断、在途上限等）只读展示</li>
          <li><strong>运行日志</strong>：按频道（对话 / 任务 / 系统）与关键词过滤，支持 3 秒自动刷新</li>
        </ul>

        <h3>日志查看</h3>
        <ul>
          <li>筛选：模型、状态（成功 / 失败）、条数（最近 20–200 条），「重置」恢复默认</li>
          <li>操作：「清空」（二次确认）、「刷新」；页头显示日志目录占用体积与文件数，方便判断是否需要清理</li>
          <li>同一任务（一次输入及其后续工具调用）合并为一条记录，不再逐请求罗列</li>
          <li>表格记录任务的模型、账号、状态、耗时、TTFB、输入 / 输出 / 缓存读 / 缓存写 / 总计 Token、积分消耗（WorkBuddy 实测，其余显示 -）、tok/s、Fallback 与错误信息</li>
          <li>使用记录列显示输入文案前 30 字，悬停可看完整内容（超长输入最多保留 1000 字符；IDE 消息自动提取其中提问正文）</li>
        </ul>

        <h3>Token 统计</h3>
        <ul>
          <li>维度切换：今天（24 小时）/ 近三天 / 近七天 / 近半个月 / 近一个月</li>
          <li>汇总卡：总计 Token、输入（未命中缓存）、缓存读、缓存写</li>
          <li>使用趋势图（悬停查看各维度用量）与各模型使用量表（请求次数 / 总 Token / 缓存读 / 缓存写 / 占比）</li>
        </ul>
        <p class="note">缓存单独计数，不与输入重复；数据保留 35 天。</p>

        <h3>模型测分</h3>
        <ul>
          <li><strong>运行评测</strong>：勾选参与评测的模型（支持全选 / 清空）与题目（按分类），选择裁判模型与并发数，点「开始评测」，进度实时显示</li>
          <li><strong>评测结果</strong>：排行榜（总分 / 得分率 / 成功失败数 / 平均延迟 / Token）、分类维度对比、每题明细与裁判评语；历史记录可删除或清空</li>
          <li><strong>题库管理</strong>：新增 / 编辑 / 删除题目，导入 / 导出 JSON，一键恢复内置题库；评分方式支持精确匹配、关键词包含、正则匹配、JSON Schema 与 LLM 裁判</li>
        </ul>
        <p class="note">评测直连 Provider，不经过智能路由与兜底，确保测的是目标模型本身。</p>

        <h3>设置</h3>
        <ul>
          <li><strong>监听端口</strong>：修改后点「保存端口」，页面出现提示后点「重启 Server」生效（只重启监听，不退出客户端）</li>
          <li><strong>重启服务</strong>：「重启 Server」按钮按当前配置重新监听端口</li>
          <li><strong>开机自启</strong>：开启后系统启动时自动打开 AiRoute 桌面客户端</li>
        </ul>

        <h3>系统托盘</h3>
        <ul>
          <li>托盘图标右键菜单：顶部显示当前模型；每个 Provider 一个子菜单（模型单选切换）；独立项「Auto (智能路由)」、「打开面板」、「退出」</li>
          <li>双击托盘图标可显示主窗口</li>
        </ul>

      </section>

      <!-- 四、常见问题 -->
      <section class="section">
        <h2>四、常见问题</h2>

        <p><strong>Q：局域网内其他设备连不上？</strong><br>A：确认使用「局域网」地址且与主机处于同一网段；检查 Windows 防火墙是否放行 AiRoute；修改端口后需在「设置」页点「重启 Server」。</p>
        <p><strong>Q：API Key 需要填真实的吗？</strong><br>A：不需要。AiRoute 不校验 API Key，任意非空字符串即可，推荐 <code>sk-airoute</code>。</p>
        <p><strong>Q：Auto 模式下没有配置任何路由规则会怎样？</strong><br>A：会自动兜底第一个可用 Provider，不会报错；建议至少配置一条「默认」规则。</p>
        <p><strong>Q：修改端口后为什么没生效？</strong><br>A：保存端口后需要点击「重启 Server」，之后使用新端口接入，本页地址会同步更新。</p>
        <p><strong>Q：账号池提示「无可用账号」怎么办？</strong><br>A：到「账号池」页签检查账号是否处于冷却或禁用状态；冷却到期会自动恢复，被熔断的账号可在详情中「解冻」，也可添加新账号。</p>
        <p><strong>Q：日志和统计数据存在哪里？</strong><br>A：均存储在本机数据目录，日志按天分文件，Token 统计数据保留 35 天，均可通过界面查看与导出。</p>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getServerConfig } from '../api.js'

const serverPort = ref(3000) // 当前服务端口，从服务端配置读取，失败时保持默认 3000
const lanIPs = ref([]) // 本机局域网 IPv4 列表（服务端动态检测，物理网卡优先）

// 本机接入地址（localhost），随端口配置动态变化
const localhostUrl = computed(() => `http://localhost:${serverPort.value}`)

// 加载服务端配置（端口与局域网 IP 列表），失败时保持默认值
async function loadConfig() {
  try {
    const config = await getServerConfig()
    serverPort.value = config.port || 3000
    lanIPs.value = Array.isArray(config.localIPs) ? config.localIPs : []
  } catch {}
}

onMounted(loadConfig)
</script>

<style scoped>
.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}

.tutorial-content {
  max-width: 800px;
}

.section {
  margin-bottom: 32px;
}

.section h2 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
}

.section h3 {
  font-size: 15px;
  font-weight: 600;
  margin-top: 20px;
  margin-bottom: 8px;
  color: var(--text-1);
}

.section p {
  font-size: 14px;
  line-height: 1.7;
  color: #444444;
  margin-bottom: 8px;
}

.section ul, .section ol {
  font-size: 14px;
  line-height: 1.8;
  color: #444444;
  padding-left: 20px;
  margin-bottom: 8px;
}

.section li {
  margin-bottom: 2px;
}

.section table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-bottom: 8px;
}

.section table th,
.section table td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
}

.section table th {
  color: var(--text-3);
  font-weight: 500;
}

.section code {
  background: #F0F4F8;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  color: var(--primary);
}

.section pre {
  background: #F8F8F8;
  border: 1px solid var(--border-1);
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 8px;
  overflow-x: auto;
}

.section pre code {
  background: none;
  padding: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-1);
}

.section .note {
  background: #EEF6FF;
  border-left: 3px solid var(--primary);
  padding: 8px 12px;
  border-radius: 0 8px 8px 0;
  color: #444444;
  font-size: 13px;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  font-size: 14px;
}

.info-label {
  width: 80px;
  color: var(--text-3);
  flex-shrink: 0;
}

.info-value {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  color: var(--primary);
  font-weight: 500;
  font-size: 13px;
}
</style>
