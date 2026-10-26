<template>
  <div class="tutorial">
    <!-- 打赏区域：位于页面开头，居中展示二维码与说明文字 -->
    <div class="donate">
      <img class="donate-img" :src="donateImg" alt="微信打赏二维码" />
      <p class="donate-text">如果 AiRoute 帮到了你，欢迎扫码打赏支持作者</p>
    </div>

    <!-- 一键接入：收款码下方，最常用的动作 -->
    <div class="quick-start">
      <div class="quick-start-text">
        <h2>大模型一键接入</h2>
        <p>点按钮复制接入提示词，粘贴给 Claude Code、Codex、Cursor 等任意 AI，它会自己找配置、写入并做连通性自检。提示词里的地址取自本页，端口变了会跟着变；客户端在另一台设备时，按提示词里的说明把 <code>localhost</code> 换成本页的局域网地址。</p>
      </div>
      <AppButton variant="primary" class="copy-prompt-btn" @click="copySetupPrompt">
        {{ copyState === 'ok' ? '已复制，去粘贴给 AI' : copyState === 'fail' ? '复制失败，请检查剪贴板权限' : '复制一键接入提示词' }}
      </AppButton>
    </div>

    <div class="tutorial-content">
      <!-- 一、接入指南 -->
      <section class="section">
        <h2>一、接入指南</h2>
        <p>AiRoute 是本地 LLM 网关，同时兼容 Anthropic 与 OpenAI（含 Responses）协议。把客户端地址指向下面 URL 即可，无需填写真实上游地址。</p>

        <h3>1. 地址与 Key</h3>
        <div class="info-row">
          <span class="info-label">本机</span>
          <span class="info-value">{{ localhostUrl }}</span>
        </div>
        <div class="info-row" v-for="ip in lanIPs" :key="ip">
          <span class="info-label">局域网</span>
          <span class="info-value">http://{{ ip }}:{{ serverPort }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">API Key</span>
          <span class="info-value">sk-airoute</span>
        </div>
        <p class="note" v-if="!lanIPs.length">未检测到可用局域网 IP：设备可能未联网，或网卡均为虚拟网卡。</p>
        <p class="note">API Key 不校验，任意非空字符串均可。多数客户端（如 Claude Code）地址填到端口即可，工具会自己拼路径；需要完整 URL 时用 <code>/v1/messages</code>（Anthropic）、<code>/v1/chat/completions</code> 或 <code>/v1/responses</code>（OpenAI）。其他设备请用「局域网」地址。端口在「设置」里改，点「重启 Server」生效。</p>

        <h3>2. 策略 pseudo 模型</h3>
        <p>模型名填 <code>auto-fast</code>（延迟优先）、<code>auto-cheap</code>（成本优先）、<code>auto</code>（两者加权）或 <code>auto-least-conn</code>（并发优先，挑此刻在途最少的），该请求就按策略自动挑模型，不必改 AiRoute 的激活模型。一次请求最多顺序试 4 个模型，全部失败后走兜底模型；没有历史数据时退化为配置顺序。并发优先那一档不看历史日志，改用实时在途数——同时跑多个任务时前几档会把请求一起压给同一个「历史最快」的模型，这一档会摊开。</p>
      </section>

      <!-- 二、核心概念 -->
      <section class="section">
        <h2>二、核心概念</h2>
        <p><strong>Provider</strong>：一条上游配置（地址 + Key + 一组模型）。支持手动添加的通用 Provider（Anthropic / OpenAI 地址至少填一个），以及 OAuth 登录的 WorkBuddy 账号池（自动轮转、冷却、故障转移）。列表第一个模型是默认模型。</p>
        <p><strong>模型引用</strong>：统一写成 <code>Provider名/模型ID</code>，只写 Provider 名则取其默认模型。切换、路由目标、兜底模型都用这个格式。</p>
        <p><strong>Auto 模式</strong>：激活模型设为 Auto 后，按请求内容匹配内置 13 种条件（代码 / SQL / 中文任务 / 翻译 / 数学 / 长上下文等）与自定义关键词，命中即路由，未命中走「默认」规则。</p>
      </section>

      <!-- 三、功能详解 -->
      <section class="section">
        <h2>三、功能详解</h2>

        <h3>状态面板</h3>
        <p>顶部四档时间维度：当日 / 本月 / 近三月 / 本年，切档后请求数、失败数与用量概览一起换口径（近三月是本月 + 往前两个自然月）。Router 状态卡常驻；用量概览给 Token 总计与输入 / 命中缓存 / 输出、缓存命中率，各模型明细与趋势图在「用量统计」页；下方是最近 5 条请求（含耗时、Token）。</p>

        <h3>模型切换</h3>
        <p>四处任选，状态实时同步、对所有客户端立即生效：侧边栏底部下拉框、状态面板模型芯片、托盘右键菜单、Provider 页模型芯片上的「切换」。</p>

        <h3>Provider 管理</h3>
        <p>右上角添加通用 Provider 或 WorkBuddy 账号池（国内版 / 国际版各一个）。每行显示模型芯片与「测试 / 编辑 / 设为当前 / 删除」；模型可逐个填写 ID、上下文、输出上限与推理档位。删除 Provider 时，指向它的路由、兜底与当前模型引用会一并清理。</p>

        <h3>路由规则</h3>
        <p>兜底模型（主模型失败后切换）、Auto 的「条件 → 目标模型」规则、自定义关键词匹配（优先级最高）；改完记得点保存。</p>

        <h3>WorkBuddy 账号池</h3>
        <div class="tutorial-callout">
          <strong>国内版</strong>走 <code>copilot.tencent.com</code>，有签到 / 成长任务 / 积分体系；<strong>国际版</strong>走 <code>www.workbuddy.ai</code>，无成长体系，但对话、余额、保活正常。两地区模型清单与 Provider 互不混用。
        </div>
        <p>八个页签：账号池（OAuth 添加、签到、余额、保活、禁用恢复）、积分构成、用量（账号 / 模型维度、多时间窗口）、模型和档位（按区域拉取与保存）、成长任务、定时任务（签到 / 保活 / 余额刷新等排程）、高级配置（提示词模式、改写档位、指纹脱敏）、运行日志（按频道与关键词过滤）。</p>

        <h3>日志、统计与测分</h3>
        <p><strong>日志</strong>：按模型 / 状态 / 条数筛选，一次任务合并为一条，含 Token、积分、TTFB、tok/s、Fallback 与错误信息，页尾有积分变动历史。</p>
        <p><strong>Token 统计</strong>：今天 / 三天 / 七天 / 半月 / 一月，含趋势图与模型明细，缓存单独计数，数据保留 35 天。</p>
        <p><strong>模型测分</strong>：选模型与题目、定裁判模型与并发即可评测；结果含排行榜、分类对比、逐题评语；题库支持导入导出与多种评分方式。评测直连 Provider，不走路由与兜底。</p>

        <h3>设置与托盘</h3>
        <p>设置页可改监听端口（保存后点「重启 Server」）、开机自启，查看版本、内存与日志占用（可清空）。托盘右键菜单可直接切模型（按 Provider 分组）、进入 Auto、打开面板或退出，双击图标显示主窗口。</p>
      </section>

      <!-- 四、常见问题 -->
      <section class="section">
        <h2>四、常见问题</h2>
        <p><strong>Q：其他设备连不上？</strong><br>A：用「局域网」地址且与主机同网段；检查防火墙是否放行；改端口后需点「重启 Server」。</p>
        <p><strong>Q：API Key 要填真实的吗？</strong><br>A：不用，任意非空字符串即可，推荐 <code>sk-airoute</code>。</p>
        <p><strong>Q：Auto 没配规则会怎样？</strong><br>A：自动兜底第一个可用 Provider，不会报错。</p>
        <p><strong>Q：账号池提示「无可用账号」？</strong><br>A：到「账号池」页签看是否冷却或禁用；冷却到期自动恢复，也可添加新账号。</p>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getServerConfig } from '../api.js'
import donateImg from '../assets/donate.jpg' // 打赏二维码图片，构建时由 Vite 处理为相对路径
import AppButton from '../components/AppButton.vue'

const serverPort = ref(3000) // 当前服务端口，从服务端配置读取，失败时保持默认 3000
const lanIPs = ref([]) // 本机局域网 IPv4 列表（服务端动态检测，物理网卡优先）

// 本机接入地址（localhost），随端口配置动态变化
const localhostUrl = computed(() => `http://localhost:${serverPort.value}`)

// 「让 AI 自己接入」的提示词。三个理由让它拼成字符串而不是写死在模板里：
// 1. 端口可改，写死就会让用户复制到一个已经不存在的地址；
// 2. 提示词要能被一键复制（用户不必自己在长篇文字里挑出哪段是要复制的）；
// 3. 它是给**别的 AI**看的，格式（分段、命令、预期输出）比排版更重要。
const setupPrompt = computed(() => `把「你自己」接入本机的 AiRoute 网关。它兼容 Anthropic 与 OpenAI 协议，
负责真实上游账号、模型切换与失败兜底，你不需要知道任何上游地址或 Key。

【网关信息】
- 地址：${localhostUrl.value}
- Anthropic：base URL 只写到端口，不要拼 /v1 或 /v1/messages
- OpenAI 兼容：base URL 用 ${localhostUrl.value}/v1（/v1/chat/completions、/v1/responses、/v1/models）
- API Key：sk-airoute（不做鉴权，任意非空字符串均可）
- 模型名随便填：AiRoute 只用自己当前的激活模型，看可用 id 请请求 /v1/models

【请按顺序做】
1. 先确认你属于哪个客户端、读哪份配置：Claude Code 读 ~/.claude/settings.json 的 env；
   其他工具是 base_url + api_key；纯 GUI 客户端（如 Cursor）只给用户操作说明，不要改内部数据库。
2. 写入配置，只动接入相关键，改前备份为 .bak：
   - Claude Code：ANTHROPIC_AUTH_TOKEN=sk-airoute、ANTHROPIC_BASE_URL=${localhostUrl.value}
   - 其它：base_url=${localhostUrl.value}/v1、api_key=sk-airoute
3. 自检并把摘要给我：
   curl -s ${localhostUrl.value}/v1/models -H 'authorization: Bearer sk-airoute'
   curl -s -X POST ${localhostUrl.value}/v1/chat/completions -H 'content-type: application/json' -d '{"model":"placeholder","messages":[{"role":"user","content":"ping"}],"max_tokens":8}'
   预期：第一条 data 非空；第二条返回 choices，且 model 是 AiRoute 的激活模型（不是你传的 placeholder，正常）。
4. 汇报：改了哪个文件、自检结果、我还需要手动做什么。

【约束】
- 不要给地址加 /v1 或 /v1/messages（OpenAI 兼容 base_url 的 /v1 除外），重复拼路径会 404。
- 不要改 http/https 与端口。连不上就停下来告诉我，先确认 AiRoute 正在运行，不要改配置绕过。
- 不要把地址或 Key 写进会提交到版本库的文件。
- 客户端在另一台机器时，把上面所有 localhost 换成本机局域网 IP。`)

const copyState = ref('') // '' | 'ok' | 'fail'
let copyTimer = 0

async function copySetupPrompt() {
  try {
    await navigator.clipboard.writeText(setupPrompt.value)
    copyState.value = 'ok'
  } catch {
    // 剪贴板被拒（窗口无焦点等）：提示词本身就在 pre 里可见可选中，退化成手抄
    copyState.value = 'fail'
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copyState.value = ''
  }, 2500)
}

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


/* 一键接入：收款码下方的操作单元，左侧说明、右侧按钮，窄窗口自动换行 */
.quick-start {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 28px;
  padding: 16px 20px;
  border: 1px solid var(--primary);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.quick-start-text {
  flex: 1;
  min-width: 0;
}

.quick-start h2 {
  margin-bottom: 6px;
  font-size: var(--fs-section);
  font-weight: 600;
  color: var(--text-1);
}

.quick-start p {
  font-size: var(--fs-small);
  line-height: 1.7;
  color: var(--text-2);
}

.quick-start code {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--tint-neutral);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}

.copy-prompt-btn {
  flex-shrink: 0;
  padding: 10px 22px;
}

@media (max-width: 720px) {
  .quick-start {
    flex-direction: column;
    align-items: stretch;
  }
}

/* 打赏区域：页面开头居中展示二维码与说明文字 */
.donate {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 32px;
}

.donate-img {
  width: 180px;
  border-radius: var(--radius-md);
}

.donate-text {
  margin-top: 8px;
  font-size: var(--fs-small);
  color: var(--text-3);
}

.tutorial-content {
  max-width: 800px;
}

/* 区域差异提示块（国内版 / 国际版） */
.tutorial-callout {
  margin: 10px 0 14px;
  padding: 10px 14px;
  border-left: 3px solid var(--primary);
  border-radius: var(--radius-xs);
  background: var(--primary-bg);
  font-size: var(--fs-small);
  line-height: 1.75;
  color: var(--text-2);
}

.tutorial-callout code {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--tint-neutral);
  font-size: var(--fs-xs);
}


.section h2 {
  font-size: var(--fs-lg);
  font-weight: 600;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
}

.section h3 {
  font-size: var(--fs-section);
  font-weight: 600;
  margin-top: 20px;
  margin-bottom: 8px;
  color: var(--text-1);
}

.section p {
  font-size: var(--fs-base);
  line-height: 1.7;
  color: var(--text-body);
  margin-bottom: 8px;
}

.section code {
  background: var(--bg-code);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  color: var(--primary);
}

.section .note {
  background: var(--bg-note);
  border-left: 3px solid var(--primary);
  padding: 8px 12px;
  border-radius: 0 8px 8px 0;
  color: var(--text-body);
  font-size: var(--fs-small);
}

.info-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  font-size: var(--fs-base);
}

.info-label {
  width: 80px;
  color: var(--text-3);
  flex-shrink: 0;
}

.info-value {
  font-family: var(--font-mono);
  color: var(--primary);
  font-weight: 500;
  font-size: var(--fs-small);
}
</style>
