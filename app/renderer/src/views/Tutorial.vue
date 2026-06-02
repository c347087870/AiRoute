<template>
  <div class="tutorial">
    <div class="page-header">
      <h1 class="page-title">使用教程</h1>
    </div>

    <div class="tutorial-content">
      <section class="section">
        <h2>一、接入地址</h2>
        <p>AiRoute 同时兼容 Anthropic 和 OpenAI 两种协议，使用对应协议的客户端工具时填入下方地址即可。</p>

        <h3>URL（只需填这个）</h3>
        <div class="info-row">
          <span class="info-label">URL</span>
          <span class="info-value">http://localhost:3000</span>
        </div>
        <p class="note">大多数客户端（如 Claude Code）只需填 URL，工具会自动拼接路径。端口 <code>3000</code> 是 AiRoute 默认端口，如修改过请在「设置」页面查看实际地址。</p>

        <h3>完整地址（需要填完整路径时使用）</h3>
        <div class="info-row">
          <span class="info-label">Anthropic</span>
          <span class="info-value">http://localhost:3000/v1/messages</span>
        </div>
        <div class="info-row">
          <span class="info-label">OpenAI</span>
          <span class="info-value">http://localhost:3000/v1/chat/completions</span>
        </div>

        <h3>API Key</h3>
        <div class="info-row">
          <span class="info-label">Key</span>
          <span class="info-value">sk-airoute</span>
        </div>
        <p class="note">AiRoute 不校验 API Key，填任意非空字符串即可。</p>
      </section>

      <section class="section">
        <h2>二、功能概览</h2>

        <h3>Provider 管理</h3>
        <p>在「Provider 管理」页面可以添加、编辑、删除 AI 模型配置。点击「+ 新增 Provider」填写接口地址、模型 ID 和 API Key 即可添加。每张卡片支持「测试」验证连通性、「设为当前」切换使用、「编辑」修改配置。</p>

        <h3>模型切换</h3>
        <p>三种方式：左侧导航栏底部下拉框、状态面板快速切换按钮、系统托盘右键菜单。切换为 <code>Auto</code> 启用智能路由，系统根据消息内容自动选择最合适的模型。</p>

        <h3>兜底模型</h3>
        <p>当前模型超时或报错时，自动切换到「路由规则」中配置的兜底模型。如果兜底模型也失败则直接返回错误。</p>

        <h3>日志查看</h3>
        <p>「日志查看」记录每次请求的模型、状态码、耗时和 fallback 信息，方便排查问题。</p>

        <h3>智能路由规则</h3>
        <p>在「路由规则」页面自定义 <code>Auto</code> 模式的路由行为。按消息内容（代码/语言/自定义关键词）匹配不同模型，或配置默认兜底规则。</p>
      </section>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: #1A1A1A;
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
  border-bottom: 1px solid #F0F0F0;
  color: #1A1A1A;
}

.section h3 {
  font-size: 15px;
  font-weight: 600;
  margin-top: 20px;
  margin-bottom: 8px;
  color: #1A1A1A;
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
  border-bottom: 1px solid #F0F0F0;
  color: #1A1A1A;
}

.section table th {
  color: #999999;
  font-weight: 500;
}

.section code {
  background: #F0F4F8;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  color: #0082FC;
}

.section pre {
  background: #F8F8F8;
  border: 1px solid #EEEEEE;
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
  color: #1A1A1A;
}

.section .note {
  background: #EEF6FF;
  border-left: 3px solid #0082FC;
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
  color: #999999;
  flex-shrink: 0;
}

.info-value {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  color: #0082FC;
  font-weight: 500;
  font-size: 13px;
}
</style>
