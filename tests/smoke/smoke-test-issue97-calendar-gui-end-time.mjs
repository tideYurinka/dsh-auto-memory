/**
 * smoke-test-issue97-calendar-gui-end-time —— #97「GUI 录入结束时间并按区间呈现」行为验收。
 *
 * 判据（CR-10）：真执行 → 真渲染 → 真断言外部行为；负路径与三面同步一并覆盖。
 *
 * 覆盖四层：
 *   ① 客户端共享判据：结束时刻校验与「14:00 - 15:00」展示（与宿主 calendar-fields 同口径）。
 *   ② 变体与默认冻结皮肤两个 Iter5Calendar：表单有可选结束时间；提交载荷带 end；
 *      非法结束就地报错且不发请求；日视图按区间呈现、时刻任务仍是单钟点。
 *   ③ 宿主 HTTP /calendar 往返：GUI 载荷落盘为区间，GET（页面刷新重新取数）仍是区间；
 *      非法结束被宿主拒绝且文件零改动；单钟点旧行为不变。
 *   ④ 三面源码同步：classic（手写 CalendarTab）/ frozen（默认皮肤唯一真源）/ 变体，
 *      以及生成器 --check 绿（生成的浏览器包与源码逐字节一致）。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { calendarTimeWritePre } from '../../lib/calendar-fields.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let pass = 0, fail = 0
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok - ' + m) } else { fail++; console.error('  FAIL - ' + m + (extra === undefined ? '' : ' | ' + JSON.stringify(extra))) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, { got: a, want: b })
const cnt = (s, x) => s.split(x).length - 1

const source = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8').replace(/\r\n/g, '\n')
const views = readFileSync(path.join(ROOT, 'skins/iter5/views.js'), 'utf8').replace(/\r\n/g, '\n')
const frozen = readFileSync(path.join(ROOT, 'skins/legacy/iter5-325.js.frozen'), 'utf8').replace(/\r\n/g, '\n')

// ══════════════════════════════════════════════════════════════
// ①–② 用仓库既有的「假 React + VM」GUI 设施真渲染两个皮肤面：
//   变体 Iter5Calendar（skins/iter5/views.js）与默认冻结皮肤 Iter5Calendar
//   （skins/legacy/iter5-325.js.frozen 被生成器包进 IIFE 的唯一真源）。
// ══════════════════════════════════════════════════════════════
let states = [], effects = [], cursor = 0, exposed
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...props } }),
  useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
  useRef(initial) { const [ref] = React.useState(() => ({ current: initial })); return ref },
  useReducer(fn, initial) { const [state, set] = React.useState(initial); return [state, action => set(old => fn(old, action))] },
  useEffect(fn, deps) { const i = cursor++; const old = states[i]; if (!old || deps.some((d, n) => !Object.is(d, old[n]))) { states[i] = deps; effects.push(fn) } },
}
const localStorage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0 }
const document = { documentElement: { getAttribute: () => '', style: { setProperty() {} }, classList: { contains: () => false } }, querySelector: () => null, getElementById: () => null }
const window = { localStorage, addEventListener() {}, removeEventListener() {}, confirm() { return true }, __ModuleLoader__: { load(def) { exposed = def.factory(name => { if (name === 'react') return React; throw Error('Test module unavailable: ' + name) }) } } }
const context = vm.createContext({ window, document, localStorage, console: { log() {}, warn() {}, info() {}, error() {} }, navigator: { language: 'zh-CN' }, URL, URLSearchParams, requestAnimationFrame: fn => fn(), setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, fetch: () => { throw Error('Unexpected raw fetch') } })

// 冻结皮肤是默认面：把它的 Iter5Calendar 源码搬进同一工厂作用域，与变体面共用同一套
// 外层工具（shared drafts / L3 / calendarTimeLabelPre / Iter5Dialog 等），从而能真渲染它。
const frozenCalendarSrc = (() => {
  const from = frozen.indexOf('    function Iter5Calendar(props) {')
  const to = frozen.indexOf('    function Iter5Recall(props) {', from)
  assert.ok(from >= 0 && to > from, 'frozen source exposes Iter5Calendar')
  return frozen.slice(from, to).replace('function Iter5Calendar(', 'function Iter5CalendarFrozen(')
})()
vm.runInContext(source.replace('    return module.exports', frozenCalendarSrc + `    exports._i5test = { Iter5Calendar: Iter5Calendar, Iter5CalendarFrozen: Iter5CalendarFrozen, CalendarTab: CalendarTab, calendarEndIssuePre: calendarEndIssuePre, calendarTimeLabelPre: calendarTimeLabelPre, newCalendarDraft: newCalendarDraft, t: t,
      transport: function (get, post) { apiGet = get; apiPost = post }, identity: function (value) { iter5Identity = function () { return value } },
      session: function (value) { var parts = String(value).split('|'); var byId = {}; byId[parts[0]] = { cwd: parts[1] || '', retainedBy: { mainView: 1 } }; sessions = { list: { getSnapshot: function () { return { current: parts[0], ids: [parts[0]], byId: byId } } } } } }
    return module.exports`), context, { filename: path.join(ROOT, 'lib/client.js') })
const test = exposed._i5test

function nodes(tree, pred, out = []) { if (!tree || typeof tree !== 'object') return out; if (Array.isArray(tree)) tree.forEach(x => nodes(x, pred, out)); else { if (pred(tree)) out.push(tree); nodes(tree.props && tree.props.children, pred, out) } return out }
function renderCalendar(component, props) { cursor = 0; const tree = component(props || { nonce: 0 }); const pending = effects.slice(); effects.length = 0; pending.forEach(fn => fn()); return tree }
async function settleCalendar(component, props) { renderCalendar(component, props); for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); return renderCalendar(component, props) }
function fieldInput(tree, label) {
  const lab = nodes(tree, n => n.type === 'label' && n.props && n.props.className === 'i5-form-field' && JSON.stringify(n.props.children[0]) === JSON.stringify(label))[0]
  assert.ok(lab, 'form field exists: ' + label)
  return nodes(lab, n => n.type === 'input')[0]
}
function addButton(tree) { return nodes(tree, n => n.type === 'button' && JSON.stringify(n.props.children).includes('添加事项'))[0] }
function todayClient() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

console.log('[①] 客户端共享判据：结束时刻校验与展示')
{
  eq(test.calendarEndIssuePre('14:00', '15:00'), '', '① 合法区间不报错')
  eq(test.calendarEndIssuePre('14:00', ''), '', '① 结束留空 = 时刻任务，不报错')
  ok(/晚于开始/.test(test.calendarEndIssuePre('15:00', '14:00')), '① 结束早于开始 ⇒ 拒绝（' + test.calendarEndIssuePre('15:00', '14:00') + '）')
  ok(/晚于开始/.test(test.calendarEndIssuePre('14:00', '14:00')), '① 结束等于开始 ⇒ 拒绝')
  ok(/HH:MM/.test(test.calendarEndIssuePre('14:00', '25:00')), '① 结束越界 ⇒ 拒绝并指出格式')
  ok(/HH:MM/.test(test.calendarEndIssuePre('14:00', 'abc')), '① 结束格式坏 ⇒ 拒绝并指出格式')
  ok(/开始时刻/.test(test.calendarEndIssuePre('--:--', '15:00')), '① 无开始时刻却填结束 ⇒ 理由指向缺开始')
  ok(/开始时刻/.test(test.calendarEndIssuePre('', '15:00')), '① 空开始时刻却填结束 ⇒ 理由指向缺开始')
  eq(test.calendarTimeLabelPre('14:00-15:00'), '14:00 - 15:00', '① 区间展示为「起 - 止」')
  eq(test.calendarTimeLabelPre('15:00'), '15:00', '① 时刻任务仍是一个钟点')
  eq(test.calendarTimeLabelPre('--:--'), '--:--', '① 无时刻写法不被改写')
  eq(test.calendarTimeLabelPre(''), '', '① 空值原样返回')
  // 「校验与宿主一致」不靠注释：把 GUI 可达的输入矩阵同时喂给宿主写侧与客户端预检，逐例比对接受/拒绝。
  const parity = [['14:00', '15:00'], ['14:00', ''], ['--:--', ''], ['', ''], ['--:--', '15:00'], ['', '15:00'], ['14:00', '14:00'], ['14:00', '25:00'], ['14:00', 'abc'], ['15:00', '14:00'], ['14:00-15:00', '16:00']]
  for (const [s, e] of parity) {
    const host = calendarTimeWritePre(s, e)
    ok(Boolean(host.error) === Boolean(test.calendarEndIssuePre(s, e)), '① 与宿主同判据（接受/拒绝一致）：' + (s || '(空)') + ' / ' + (e || '(空)'))
  }
  eq(calendarTimeWritePre('14:00', '15:00').time, '14:00-15:00', '① 宿主把开始+结束落成区间（GUI 只做本地预检，落盘由宿主统一）')
}

console.log('[②] GUI 日历（变体 + 默认冻结皮肤）：表单可选结束时间、提交带 end、日视图按区间呈现')
async function runCalendarFace(component, face, identity) {
  states = []; effects = []; cursor = 0
  test.identity(identity); test.session(identity)
  const today = todayClient()
  const entries = [
    { id: 'a', date: today, time: '14:00-15:00', title: '练航拍', done: false, quadrant: '重要不紧急' },
    { id: 'b', date: today, time: '15:00', title: '交表', done: false, quadrant: '未分类' },
  ]
  const posts = []
  test.transport(async () => ({ entries }), async (url, body) => { posts.push({ url, body }); return { ok: true, result: '已加入日历' } })
  let tree = await settleCalendar(component)
  const meta = nodes(tree, n => n.props && n.props.className === 'i5-event-meta')
  eq(meta.length, 2, face + '：日视图列出当天两条日程')
  eq(meta.map(n => [].concat(n.props.children[0].props.children).join('')), ['14:00 - 15:00', '15:00'], face + '：时段写成 14:00 - 15:00，时刻任务仍是 15:00')

  addButton(tree).props.onClick()
  tree = await settleCalendar(component)
  ok(Boolean(fieldInput(tree, '结束时间（可选）')), face + '：添加表单出现可选结束时间字段')

  fieldInput(tree, '标题').props.onChange({ target: { value: '练航拍' } })
  fieldInput(tree, '日期').props.onChange({ target: { value: '2026-10-20' } })
  fieldInput(tree, '时间').props.onChange({ target: { value: '14:00' } })
  fieldInput(tree, '结束时间（可选）').props.onChange({ target: { value: '15:00' } })
  tree = await settleCalendar(component)
  nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await settleCalendar(component)
  eq(posts.length, 1, face + '：合法区间发一次请求')
  const { operationId, ...body } = posts[0].body
  eq(body, { date: '2026-10-20', time: '14:00', end: '15:00', quadrant: '重要不紧急', title: '练航拍', note: '' }, face + '：载荷把结束时刻作为独立字段提交（由宿主统一落盘为区间）')
  ok(typeof operationId === 'string' && operationId.length > 0, face + '：请求保留既有的幂等 operationId')
  eq(posts[0].url, '/api/dsh-auto-memory/calendar', face + '：提交发到宿主日历路由')

  addButton(tree).props.onClick()
  tree = await settleCalendar(component)
  fieldInput(tree, '标题').props.onChange({ target: { value: '倒挂' } })
  fieldInput(tree, '时间').props.onChange({ target: { value: '15:00' } })
  fieldInput(tree, '结束时间（可选）').props.onChange({ target: { value: '14:00' } })
  tree = await settleCalendar(component)
  nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  tree = await settleCalendar(component)
  eq(posts.length, 1, face + '：结束早于开始 ⇒ 不发请求')
  const errorBox = nodes(tree, n => n.props && typeof n.props.error === 'string')[0]
  ok(errorBox && /晚于开始/.test(errorBox.props.error), face + '：非法结束在表单里就地给出可读原因（' + (errorBox && errorBox.props.error) + '）')

  fieldInput(tree, '时间').props.onChange({ target: { value: '09:00' } })
  fieldInput(tree, '结束时间（可选）').props.onChange({ target: { value: '' } })
  tree = await settleCalendar(component)
  nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await settleCalendar(component)
  eq(posts.length, 2, face + '：清空结束时刻 ⇒ 按时刻任务提交')
  eq(posts[1].body.time, '09:00', face + '：时刻任务仍只提交开始钟点')
  eq(posts[1].body.end, '', face + '：时刻任务的 end 为空（宿主按旧写法落盘）')
}
await runCalendarFace(test.Iter5Calendar, '② 变体', 'sid-97v|ws-97v')
await runCalendarFace(test.Iter5CalendarFrozen, '② 默认冻结', 'sid-97f|ws-97f')

// 经典档（手写 CalendarTab）也真渲染：CR-10 不允许用「源码含某字符串」充当功能验收。
async function runClassicFace() {
  states = []; effects = []; cursor = 0
  test.identity('sid-97c|ws-97c'); test.session('sid-97c|ws-97c')
  const today = todayClient()
  const entries = [
    { id: 'a', date: today, time: '14:00-15:00', title: '练航拍', done: false, quadrant: '重要不紧急' },
    { id: 'b', date: today, time: '15:00', title: '交表', done: false, quadrant: '未分类' },
  ]
  const posts = []
  test.transport(async () => ({ entries }), async (url, body) => { posts.push({ url, body }); return { ok: true, result: '已加入日历' } })
  const render = () => { cursor = 0; const tree = test.CalendarTab(); const pending = effects.slice(); effects.length = 0; pending.forEach(fn => fn()); return tree }
  const settle = async () => { render(); for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); return render() }
  async function change(get, value) { const node = get(); node.props.onChange({ target: { value } }); tree = await settle() }
  const timeInputs = () => nodes(tree, n => n.type === 'input' && n.props.type === 'time')
  const saveButton = () => nodes(tree, n => n.type === 'button' && JSON.stringify(n.props.children).includes(test.t('save')))[0]
  let tree = await settle()
  const cell = nodes(tree, n => n.props && 'data-dam-calendar-day' in n.props && n.props.key === today)[0]
  ok(Boolean(cell), '② 经典档：今天有日程格')
  cell.props.onClick()
  tree = await settle()
  const slots = nodes(tree, n => n.props && 'data-dam-calendar-slot' in n.props)
  const slot14 = slots.find(n => JSON.stringify(n.props.children).includes('"14:00"'))
  const slot15 = slots.find(n => JSON.stringify(n.props.children).includes('"15:00"'))
  ok(slot14 && JSON.stringify(slot14).includes('14:00 - 15:00  练航拍'), '② 经典档：日视图时段按区间呈现')
  ok(slot15 && JSON.stringify(slot15).includes('15:00  交表'), '② 经典档：日视图时刻任务仍落在对应钟点')

  nodes(tree, n => n.type === 'button' && JSON.stringify(n.props.children).includes(test.t('addItem')))[0].props.onClick()
  tree = await settle()
  const labels = nodes(tree, n => n.type === 'label').map(n => [].concat(n.props.children).filter(c => typeof c === 'string').join(''))
  ok(labels.includes('开始时间') && labels.includes('结束时间（可选）'), '② 经典档：两个时间输入都有可见标签（新增字段三语文案不是仅 AT/悬停可见）')
  await change(() => nodes(tree, n => n.type === 'input' && n.props.placeholder === test.t('itemTitle'))[0], '练航拍')
  await change(() => timeInputs()[0], '14:00')
  await change(() => timeInputs()[1], '15:00')
  saveButton().props.onClick()
  await settle()
  eq(posts.length, 1, '② 经典档：合法区间发一次请求')
  const { operationId, ...body } = posts[0].body
  eq(body, { date: today, time: '14:00', end: '15:00', quadrant: '重要不紧急', title: '练航拍', note: '' }, '② 经典档：载荷把结束时刻作为独立字段提交')
  ok(typeof operationId === 'string' && operationId.length > 0, '② 经典档：请求保留既有的幂等 operationId')
  eq(posts[0].url, '/api/dsh-auto-memory/calendar', '② 经典档：提交发到宿主日历路由')

  nodes(tree, n => n.type === 'button' && JSON.stringify(n.props.children).includes(test.t('addItem')))[0].props.onClick()
  tree = await settle()
  await change(() => nodes(tree, n => n.type === 'input' && n.props.placeholder === test.t('itemTitle'))[0], '倒挂')
  await change(() => timeInputs()[0], '15:00')
  await change(() => timeInputs()[1], '14:00')
  saveButton().props.onClick()
  tree = await settle()
  eq(posts.length, 1, '② 经典档：结束早于开始 ⇒ 不发请求')
  const err = nodes(tree, n => n.props && 'data-dam-error' in n.props).map(n => n.props.children).join(' ')
  ok(/晚于开始/.test(err), '② 经典档：非法结束在表单里就地给出可读原因（' + err + '）')

  await change(() => timeInputs()[0], '09:00')
  await change(() => timeInputs()[1], '')
  saveButton().props.onClick()
  await settle()
  eq(posts.length, 2, '② 经典档：清空结束时刻 ⇒ 按时刻任务提交')
  eq(posts[1].body.time, '09:00', '② 经典档：时刻任务仍只提交开始钟点')
  eq(posts[1].body.end, '', '② 经典档：时刻任务的 end 为空')
}
await runClassicFace()

console.log('[③] 宿主 /calendar 往返：落盘为区间，刷新后仍是区间')
{
  const root = mkdtempSync(path.join(tmpdir(), 'dam-97-'))
  const saved = {}
  for (const k of ['HOME', 'USERPROFILE', 'DSH_HOME']) { saved[k] = process.env[k]; process.env[k] = root }
  try {
    const ws = path.join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    writeFileSync(path.join(root, 'dsh-auto-memory.json'), JSON.stringify({
      teamEnabled: false,
      globalBriefEnabled: false,
      externalSources: {},
      memoryRoot: path.join(root, 'memory'),
      userMemoryDir: path.join(root, 'user'),
    }), 'utf8')
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })

    const routes = []
    const { apply } = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href + '?v=' + Math.random())
    apply({
      get() { return undefined },
      on() { return () => {} },
      effect(fn) { try { if (typeof fn === 'function') fn() } catch (_) {} return () => {} },
      systemPrompt: { section() { return () => {} }, context() { return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register(route) { routes.push(route); return () => {} } },
    }, {})
    const route = routes.find((r) => r.path === '/api/dsh-auto-memory/calendar')
    ok(Boolean(route), '③ 宿主的日历路由已注册')
    const call = (method, body) => new Promise((resolve) => {
      let payload = null
      const res = { statusCode: 200, writeHead(code) { res.statusCode = code; return res }, setHeader() {}, end(s) { try { payload = JSON.parse(s) } catch (_) { payload = s }; resolve({ payload, status: res.statusCode }) } }
      const req = {
        method, url: route.path, headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
        [Symbol.asyncIterator]: async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
      }
      route.handler(req, res)
    })
    const calendarPath = path.join(root, 'user', 'CALENDAR.md')
    const readCalendar = () => (existsSync(calendarPath) ? readFileSync(calendarPath, 'utf8') : '')

    const added = await call('POST', { date: '2026-10-20', time: '14:00', end: '15:00', quadrant: '未分类', title: '练航拍' })
    ok(/已加入日历/.test(String(added.payload && added.payload.result)), '③ 面板载荷添加成功（' + String(added.payload && added.payload.result).slice(0, 60) + '）')
    ok(readCalendar().includes('- [ ] 14:00-15:00 | 未分类 | 练航拍'), '③ 落盘时间列就是区间 14:00-15:00')

    const reload = await call('GET')
    const reloaded = (reload.payload && reload.payload.entries || []).filter((e) => e.title === '练航拍')
    eq(reloaded.map((e) => e.time), ['14:00-15:00'], '③ 页面刷新重新 GET ⇒ 仍是区间（不是两个钟点或一小时）')
    const reloadAgain = await call('GET')
    eq((reloadAgain.payload.entries || []).filter((e) => e.title === '练航拍').map((e) => e.time), ['14:00-15:00'], '③ 再刷新一次仍是区间')

    const { MemoryEngine } = await import(pathToFileURL(path.join(ROOT, 'tests', 'lib', 'audit-engine.mjs')).href + '?v=' + Math.random())
    const disk = new MemoryEngine().parseCalendar(readCalendar())
    eq(disk.filter((e) => e.title === '练航拍').map((e) => e.time), ['14:00-15:00'], '③ 新宿主只读磁盘也能解析出同一个区间（跨重启不丢）')

    const beforeInvalid = readCalendar()
    const backwards = await call('POST', { date: '2026-10-21', time: '15:00', end: '14:00', title: '倒挂' })
    eq(backwards.status, 400, '③ 结束早于开始 ⇒ 宿主 400')
    ok(/晚于开始/.test(String(backwards.payload && backwards.payload.error)), '③ 宿主给出可读理由')
    const malformed = await call('POST', { date: '2026-10-21', time: '15:00', end: '25:00', title: '坏格式' })
    eq(malformed.status, 400, '③ 结束格式坏 ⇒ 宿主 400')
    eq(readCalendar(), beforeInvalid, '③ 被拒的写入一个字节都没落盘')

    const single = await call('POST', { date: '2026-10-21', time: '09:00', title: '交表' })
    ok(/已加入日历/.test(String(single.payload && single.payload.result)) && readCalendar().includes('- [ ] 09:00 | 未分类 | 交表'), '③ 不带结束时刻的旧写法逐字不变')
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('[④] 三面源码同步 + 三套语言 + 生成包校验')
{
  ok(cnt(views, '结束时间（可选）') >= 1, '④ 变体源有「结束时间（可选）」字段')
  ok(cnt(frozen, '结束时间（可选）') >= 1, '④ 冻结源（默认皮肤唯一真源）有「结束时间（可选）」字段')
  ok(cnt(source, '结束时间（可选）') >= 1, '④ 经典档手写区有「结束时间（可选）」字段')

  for (const [name, text] of [['变体', views], ['冻结', frozen]]) {
    ok(text.includes('calendarEndIssuePre('), '④ ' + name + ' 源使用共享结束时刻校验')
    ok(text.includes('calendarTimeLabelPre(') && text.includes("h('span',null,calendarTimeLabelPre(e.time)||'—')"), '④ ' + name + ' 日视图用共享展示函数按区间呈现')
    ok(text.includes('end: v.end') || text.includes('end:v.end'), '④ ' + name + ' 提交载荷带结束时刻')
  }
  ok(source.includes('end: draft.end'), '④ 经典档提交载荷带结束时刻')
  ok(source.includes("n.end = e.target.value"), '④ 经典档结束时间输入接草稿')
  ok(source.includes("L3('开始时间', 'Start time', '開始時刻')") && source.includes("L3('结束时间（可选）', 'End time (optional)', '終了時刻（任意）')"), '④ 经典档两个时间输入都有可见三语标签')
  const endField = "['end',L3('结束时间（可选）','End time (optional)','終了時刻（任意）'),'time']"
  ok(views.includes(endField) && frozen.includes(endField), '④ 变体/冻结表单字段表新增可选结束时间')
  ok(cnt(source, endField) >= 2, '④ 生成的浏览器包里两个皮肤面都带可选结束时间')
  ok(/function newCalendarDraft\(date,time\)\{var d=\{operationId:[^}]*end:''/.test(source), '④ 新草稿带空的 end（受控输入初值 + 脏检查基线）')
  ok(source.includes("['title','date','time','end','quadrant','location','reminder','note']"), '④ 脏检查把 end 计入（只改结束时刻也会提示未保存）')

  ok(views.includes('終了時刻（任意）') && frozen.includes('終了時刻（任意）') && source.includes('終了時刻（任意）'), '④ 结束时间字段补齐日文文案（三面）')
  ok(source.includes('終了時刻は開始時刻より後にしてください') && source.includes('End time must be later than the start time') && source.includes('结束时刻需要晚于开始时刻'), '④ 结束早于开始的校验补齐中/英/日三套文案')
  ok(source.includes('終了時刻は HH:MM で入力してください') && source.includes('終了時刻には開始時刻が必要です'), '④ 结束格式/缺开始的校验补齐日文文案')

  const check = execFileSync(process.execPath, [path.join(ROOT, 'tools/build-iter5-skin.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  ok(/SYNC-OK/.test(check), '④ 生成器 --check 绿：生成的浏览器包与 GUI 源码逐字节一致（' + check.trim().split('\n').slice(-1)[0] + '）')
  ok(cnt(source, 'calendarEndIssuePre(') >= 3, '④ 生成包里三面都接上共享校验（classic + frozen + 变体）')
  ok(cnt(source, 'calendarTimeLabelPre(') >= 4, '④ 生成包里日视图按区间呈现（classic 时间轴 + frozen + 变体）')
}

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail ? 1 : 0)
