/**
 * smoke-test-issue95-calendar-time-range —— #95「日历时间列支持时段」行为验收。
 *
 * 判据（CR-10）：真 import → 真构造 → 真调用 → 断言返回值与磁盘副作用；负路径一并覆盖。
 *
 * 覆盖四条路径（两处解析同口径是硬红线）：
 *   ① lib/index.js 的 parseCalendar / renderCalendar（宿主运行时解析与序列化）
 *   ② lib/index.js 的旧文件整篇重写（逐字节不变）
 *   ③ lib/migrate-pack.js 的 calendarMergePre（打包迁移的孪生解析 + 序列化）
 *   ④ calendar_add / calendar_list / calendar_done / calendar_remove（工具背后的写路径）
 *
 * 外部行为：
 *   - 时间列三种写法：`HH:MM`、`HH:MM-HH:MM`、`--:--`。
 *   - 旧日历逐字节不变（解析→整篇重写后写法不变）。
 *   - 非法结束时刻：读取退化为时刻任务；写入拒绝并给出可读理由。
 *   - calendar_add 带结束时刻写出区间；calendar_list 呈现区间；done/remove 按存下来的时间串定位。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m) } else { fail++; console.error('  FAIL - ' + m) } }
const eq = (a, b, m) => {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, m + (same ? '' : ' | got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)))
}

const { MemoryEngine, apply } = await import(pathToFileURL(path.join(ROOT, 'tests', 'lib', 'audit-engine.mjs')).href + '?v=' + Math.random())
const { calendarMergePre } = await import(pathToFileURL(path.join(ROOT, 'lib', 'migrate-pack.js')).href)

const engine = new MemoryEngine()

const LEGACY = [
  '# 日历与日程 (CALENDAR)', '',
  '> 由 dsh-auto-memory 维护;AI 可从对话中提取 deadline/约定写入,用户也可在 GUI 操作。', '',
  '## 2026-10-20',
  '- [ ] --:-- | 未分类 | 买牛奶',
  '- [ ] 09:00 | 重要紧急 | 交表',
  '- [x] 23:59 | 不重要不紧急 | 收尾',
  '',
].join('\n')

const MIXED = [
  '## 2026-10-20',
  '- [ ] 09:00 | 重要不紧急 | 交表',
  '- [ ] 14:00-15:00 | 重要不紧急 | 练航拍',
  '- [ ] --:-- | 未分类 | 买牛奶',
  '',
].join('\n')

const BROKEN = [
  '## 2026-10-20',
  '- [ ] 08:00-08:00 | 未分类 | 等长',
  '- [ ] 09:00-08:00 | 未分类 | 倒挂',
  '- [ ] 10:00-abc | 未分类 | 结束格式坏',
  '- [ ] 11:00-25:00 | 未分类 | 结束越界',
  '- [ ] 12:00- | 未分类 | 结束为空',
  '- [ ] 13:00-14:30 | 未分类 | 正常区间',
  '',
].join('\n')

// ══════════════════════════════════════════════════════════════
console.log('[①] 宿主解析：三种时间写法')
// ══════════════════════════════════════════════════════════════
{
  const rows = engine.parseCalendar(MIXED)
  eq(rows.map((r) => r.time), ['09:00', '14:00-15:00', '--:--'], '① 单钟点 / 区间 / 无时刻三种写法都解析为一条')
  eq(rows.map((r) => r.title), ['交表', '练航拍', '买牛奶'], '① 三种写法都不吞掉标题')
  eq(rows[1], { date: '2026-10-20', done: false, time: '14:00-15:00', quadrant: '重要不紧急', title: '练航拍', note: '' }, '① 区间条目字段与旧条目同形（time 是存下来的时间串）')
}
{
  const rows = engine.parseCalendar(BROKEN)
  eq(rows.map((r) => r.time), ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00-14:30'], '② 非法结束时刻逐条退化为时刻任务，正常区间不受影响')
  eq(rows.map((r) => r.title), ['等长', '倒挂', '结束格式坏', '结束越界', '结束为空', '正常区间'], '② 退化条目仍保留标题，不丢行')
}

// ══════════════════════════════════════════════════════════════
console.log('[②] 旧文件逐字节不变')
// ══════════════════════════════════════════════════════════════
{
  const rendered = engine.renderCalendar(engine.parseCalendar(LEGACY))
  eq(rendered, LEGACY, '② 旧日历（单钟点 + --:--）解析后整篇重写逐字节不变')
  eq(engine.parseCalendar(rendered).map((r) => r.time), ['--:--', '09:00', '23:59'], '② 二次解析时间写法仍是原样')
}

// ══════════════════════════════════════════════════════════════
console.log('[③] 打包迁移：孪生解析/序列化同口径')
// ══════════════════════════════════════════════════════════════
{
  const norm = (rows) => rows.slice().sort((a, b) => (a.date + a.time + a.title).localeCompare(b.date + b.time + b.title))
  const viaMigration = engine.parseCalendar(calendarMergePre(MIXED, '').text)
  eq(norm(viaMigration), norm(engine.calendarEntriesPre(MIXED)), '③ 迁移合并输出再经宿主解析 ⇒ 与直接解析逐字段相同（含区间；合并输出按时间排序）')
  const legacyMerged = calendarMergePre(LEGACY, '').text
  ok(legacyMerged.includes('- [ ] 09:00 | 重要紧急 | 交表'), '③ 迁移输出保留单钟点写法')
  ok(legacyMerged.includes('- [ ] --:-- | 未分类 | 买牛奶'), '③ 迁移输出保留 --:-- 写法')
  const brokenMerged = calendarMergePre(BROKEN, '').text
  ok(brokenMerged.includes('- [ ] 10:00 | 未分类 | 结束格式坏'), '③ 迁移侧同样把非法结束时刻退化为时刻任务')
  ok(brokenMerged.includes('- [ ] 13:00-14:30 | 未分类 | 正常区间'), '③ 迁移侧保留合法区间')
}

// ══════════════════════════════════════════════════════════════
console.log('[④] 工具接线：calendar_add / calendar_list / calendar_done / calendar_remove')
// ══════════════════════════════════════════════════════════════
{
  const root = fs.mkdtempSync(path.join(tmpdir(), 'dam-95-'))
  const saved = {}
  for (const k of ['HOME', 'USERPROFILE', 'DSH_HOME']) { saved[k] = process.env[k]; process.env[k] = root }
  try {
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(root, 'dsh-auto-memory.json'), JSON.stringify({
      teamEnabled: false,
      globalBriefEnabled: false,
      externalSources: {},
      memoryRoot: path.join(root, 'memory'),
      userMemoryDir: path.join(root, 'user'),
    }), 'utf8')
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })

    const tools = []
    apply({
      get() { return undefined },
      on() { return () => {} },
      effect(fn) { try { if (typeof fn === 'function') fn() } catch (_) {} return () => {} },
      systemPrompt: { section() { return () => {} }, context() { return () => {} } },
      tools: { register(t) { tools.push(t); return () => {} } },
      webServer: { register() { return () => {} } },
    }, {})
    const tool = (name) => tools.find((t) => t.name === name)
    const agent = { session: { id: 'session-95', header: { cwd: ws } } }
    const calendarPath = path.join(root, 'user', 'CALENDAR.md')
    const readCalendar = () => fs.readFileSync(calendarPath, 'utf8')

    ok(Boolean(tool('calendar_add').parameters.properties.end), '④ calendar_add 声明了可选结束时刻参数')

    const addRes = await tool('calendar_add').execute({ date: '2026-10-20', time: '14:00', end: '15:00', quadrant: '重要不紧急', title: '练航拍' }, { agent })
    ok(/已加入日历/.test(String(addRes)), '④ calendar_add 带结束时刻返回成功（' + String(addRes).slice(0, 40) + '）')
    ok(readCalendar().includes('- [ ] 14:00-15:00 | 重要不紧急 | 练航拍'), '④ 写盘时间列是 14:00-15:00')

    const listRes = await tool('calendar_list').execute({ date: '2026-10-20' }, { agent })
    ok(String(listRes).includes('2026-10-20 14:00-15:00 | 重要不紧急 | 练航拍'), '④ calendar_list 呈现区间（' + String(listRes).split('\n')[1] + '）')

    const doneRes = await tool('calendar_done').execute({ date: '2026-10-20', time: '14:00-15:00', title: '练航拍' }, { agent })
    ok(/已标记完成/.test(String(doneRes)), '④ calendar_done 按存下来的时间串定位区间行')
    ok(readCalendar().includes('- [x] 14:00-15:00 | 重要不紧急 | 练航拍'), '④ 完成位翻转且区间写法不变')

    const rangeRes = await tool('calendar_add').execute({ date: '2026-10-21', time: '09:00', end: '10:00', title: '时段' }, { agent })
    ok(/已加入日历/.test(String(rangeRes)) && readCalendar().includes('- [ ] 09:00-10:00 | 未分类 | 时段'), '④ time + end 写出的就是区间')

    const plainRes = await tool('calendar_add').execute({ date: '2026-10-21', time: '11:00', title: '单钟点' }, { agent })
    ok(/已加入日历/.test(String(plainRes)) && readCalendar().includes('- [ ] 11:00 | 未分类 | 单钟点'), '④ 不带结束时刻的旧写法逐字不变')

    const noTimeRes = await tool('calendar_add').execute({ date: '2026-10-21', time: '--:--', title: '无时刻' }, { agent })
    ok(/已加入日历/.test(String(noTimeRes)) && readCalendar().includes('- [ ] --:-- | 未分类 | 无时刻'), '④ 显式传 --:-- 仍按无时刻写入（既有写法不回归）')

    const beforeBad = readCalendar()
    const backwards = await tool('calendar_add').execute({ date: '2026-10-22', time: '16:00', end: '15:00', title: '倒挂' }, { agent })
    ok(/结束时刻/.test(String(backwards)) && /晚于开始时刻/.test(String(backwards)), '④ 结束早于开始 ⇒ 拒绝并给出可读理由（' + String(backwards) + '）')
    const malformed = await tool('calendar_add').execute({ date: '2026-10-22', time: '16:00', end: '25:00', title: '坏格式' }, { agent })
    ok(/结束时刻/.test(String(malformed)) && /HH:MM/.test(String(malformed)), '④ 结束格式不对 ⇒ 拒绝并给出可读理由（' + String(malformed) + '）')
    const equal = await tool('calendar_add').execute({ date: '2026-10-22', time: '16:00', end: '16:00', title: '等长' }, { agent })
    ok(/晚于开始时刻/.test(String(equal)), '④ 结束等于开始同样拒绝')
    const noStart = await tool('calendar_add').execute({ date: '2026-10-22', time: '--:--', end: '15:00', title: '无开始' }, { agent })
    ok(/结束时刻需要开始时刻/.test(String(noStart)), '④ --:-- 配结束时刻 ⇒ 拒绝理由指向缺开始时刻，而不是误报格式（' + String(noStart) + '）')
    const badRange = await tool('calendar_add').execute({ date: '2026-10-22', time: '16:00-15:00', title: '倒挂区间' }, { agent })
    ok(/晚于开始时刻/.test(String(badRange)), '④ time 直接写成倒挂区间同样拒绝')
    eq(readCalendar(), beforeBad, '④ 五次被拒的写入一个字节都没落盘')

    const removeRes = await tool('calendar_remove').execute({ date: '2026-10-20', time: '14:00-15:00', title: '练航拍' }, { agent })
    ok(/已删除/.test(String(removeRes)), '④ calendar_remove 按存下来的时间串删除区间行')
    ok(!readCalendar().includes('练航拍'), '④ 删除后该行确实不在盘上')
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail ? 1 : 0)
