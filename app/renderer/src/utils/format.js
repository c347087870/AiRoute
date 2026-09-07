// 数字加千位分隔符，空值或非数字统一显示 0
export function formatNumber(num) {
  if (num === null || num === undefined || num === '' || Number.isNaN(Number(num))) return '0'
  return Number(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 大数字紧凑显示，用于坐标轴与窄空间：12345 -> 12.3k
export function formatCompact(num) {
  const value = Number(num)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

// 时间戳格式化为 MM-DD HH:MM:SS
export function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 本地日期 YYYY-MM-DD，与服务端统计口径保持一致
export function toLocalDateKey(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
