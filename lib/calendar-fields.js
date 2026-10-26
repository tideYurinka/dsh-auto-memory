export function calendarFieldEncodePre(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

export function calendarFieldDecodePre(value) {
  return String(value || '').replace(/\\([\\|])/g, '$1')
}

export function calendarQuadrantPre(value) {
  return value === '不重要紧急' ? '紧急不重要' : String(value || '未分类').trim()
}

/**
 * 日历时间列：`HH:MM`（时刻任务）、`HH:MM-HH:MM`（时段）、`--:--`（无时刻）。
 * 解析层只认这三种写法；宿主运行时与打包迁移共用这一条正则，避免两处漂移。
 */
export const CALENDAR_ENTRY_LINE_RE = /^- \[([ xX])\] (\d{1,2}:\d{2}(?:-[^|]*)?|--:--) \| ([^|]+?) \| (.+?)(?: \| (.*))?$/

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/

/** 把 `HH:MM` 换成当天第几分钟；越界或格式不对返回 null。 */
function clockMinutesPre(value) {
  const m = CLOCK_RE.exec(String(value == null ? '' : value).trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function rangeIssuePre(start, end) {
  if (clockMinutesPre(start) === null) return '开始时刻需要是 HH:MM，例如 14:00'
  if (clockMinutesPre(end) === null) return '结束时刻需要是 HH:MM，例如 15:00'
  if (clockMinutesPre(end) <= clockMinutesPre(start)) return '结束时刻需要晚于开始时刻（' + start + '-' + end + '）'
  return ''
}

/**
 * 读取时间列。结束时刻不合法（格式不对或不晚于开始）⇒ **该条退化为时刻任务**，
 * 只保留开始钟点；绝不因一行坏数据丢掉整条或影响同文件其他行。
 */
export function calendarTimeReadPre(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s || s === '--:--') return '--:--'
  const dash = s.indexOf('-')
  if (dash < 0) return s
  const start = s.slice(0, dash).trim()
  const end = s.slice(dash + 1).trim()
  return rangeIssuePre(start, end) ? start : start + '-' + end
}

/**
 * 写入时间列。与读取不同：非法结束时刻**拒绝**并给出可读理由，避免把坏区间落盘。
 * 返回 `{ time }` 或 `{ error }`。
 */
export function calendarTimeWritePre(start, end) {
  const s = String(start == null ? '' : start).trim()
  const e = String(end == null ? '' : end).trim()
  if (!s || s === '--:--') {
    if (e) return { error: '结束时刻需要开始时刻（--:-- 表示无时刻）' }
    return { time: '--:--' }
  }
  if (e) {
    if (s.includes('-')) return { error: '开始时刻只写一个钟点（HH:MM）；结束时刻请单独传 end' }
    const issue = rangeIssuePre(s, e)
    if (issue) return { error: issue }
    return { time: s + '-' + e }
  }
  if (!s.includes('-')) return { time: s }
  const dash = s.indexOf('-')
  const rangeStart = s.slice(0, dash).trim()
  const rangeEnd = s.slice(dash + 1).trim()
  const issue = rangeIssuePre(rangeStart, rangeEnd)
  if (issue) return { error: issue }
  return { time: rangeStart + '-' + rangeEnd }
}
