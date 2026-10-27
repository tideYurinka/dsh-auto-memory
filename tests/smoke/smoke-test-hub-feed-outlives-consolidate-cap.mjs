#!/usr/bin/env node
/**
 * smoke-test-hub-feed-outlives-consolidate-cap.mjs — 记忆中枢「好久没有启动」的回归。
 *
 * 缺陷形态（板端实测 2026-10-27）：
 *   consolidateTurn 把「记忆中枢取样（episodic.append → consolidate → crossFeed）」写在
 *   **LLM 沉淀预算的三道门之后**（config / 每日额度 / 冷却）。于是：
 *     - 每日 8 次额度一用满，之后每一轮都以 `consolidate skip: daily subagent cap=8` 返回；
 *     - 中枢取样是纯本地动作（不调模型、不花 token），却被同一把门挡住；
 *     - 实测板端 19:42 用完额度后 6 小时里中枢零新增，面板「记忆中枢」停在旧数据。
 *
 * 本套件锁的是**解耦**这件事本身：
 *   A 首轮（在额度内）：中枢拿到该轮 —— 夹具自检，确保断言不是永远绿。
 *   B 额度耗尽后（第二、三轮）：沉淀照旧被 skip，但中枢必须仍然拿到这两轮。
 *   C 反证：把中枢取样块移回门后（变异验证），B 段必须变红。
 *
 * 判据取的是 `/memory-hub` 路由的真实返回（与前端同一条读路径），不读内存私有字段。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ws = mkdtempSync(path.join(tmpdir(), 'dam-hubfeed-'))
const home = path.join(ws, '.dsh-home')
mkdirSync(home, { recursive: true })
writeFileSync(path.join(home, 'dsh-auto-memory.json'), JSON.stringify({
  memoryRoot: path.join(home, 'memory-root'),
  userMemoryDir: path.join(ws, '.user-root'),
  projectMemoryDir: '.project-memory',
  externalSources: {},
  // 额度 = 1：第一轮用完，后续轮次必然落进 `daily subagent cap=1` 的 skip 分支。
  autoConsolidateDailyMax: 1,
  autoConsolidateCooldownMinutes: 1,
  autoConsolidateMinChars: 80,
  episodicMinSegments: 1,
  memoryHubEnabled: true,
  subagentModel: 'probe-model-hub',
}), 'utf8')
process.env.DSH_HOME = home
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })

const subagents = {
  list() { return ['spawn'] },
  async start() {
    return { result: Promise.resolve({ output: [{ type: 'text', text: '[TOPIC] hub feed\n[LOG]\n- hub feed regression' }] }) }
  },
}
const routes = []
const eventHandlers = new Map()
const ctx = {
  get(service) { return service === 'subagents' ? subagents : undefined },
  on(name, handler) { eventHandlers.set(name, handler); return () => eventHandlers.delete(name) },
  effect(fn) { try { fn() } catch (e) {} ; return () => {} },
  systemPrompt: { section() { return () => {} }, context() { return () => {} } },
  tools: { register() { return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
}
const { apply } = await import('../../lib/index.js')
apply(ctx, {})

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }

const stopping = eventHandlers.get('agent/turn-stopping')
if (typeof stopping !== 'function') throw new Error('turn-stopping hook missing')

const hubRoute = routes.find((r) => String(r.path).endsWith('/memory-hub'))
if (!hubRoute) throw new Error('/memory-hub route missing（路由表变了？）')

/** 走真实路由读中枢概览（与面板同一条读路径）。 */
function readHub() {
  return new Promise((resolve, reject) => {
    const req = {
      url: '/api/dsh-auto-memory/memory-hub', method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:1' },
    }
    const res = {
      status: 0,
      writeHead(s) { this.status = s },
      end(body) { try { resolve(JSON.parse(String(body))) } catch (e) { reject(e) } },
    }
    try { Promise.resolve(hubRoute.handler(req, res)).catch(reject) } catch (e) { reject(e) }
  })
}

const waitUntil = async (predicate, { timeoutMs = 8000, stepMs = 20 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { if (await predicate()) return true } catch (e) {}
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

const makeAgent = (id, cwd) => ({
  id,
  ctx: { get: () => undefined },
  session: {
    id: id + '-session',
    header: { id: id + '-session', cwd },
    surface: { nodes: [0, 1] },
    events: [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第 ' + id + ' 轮的真人指令：把记忆中枢的喂数从沉淀额度里解耦出来，附带足够长的上下文说明，包含步骤、失败信号与验收标准，确保这一段文本不会被最短长度门槛丢掉' }] } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '第 ' + id + ' 轮的助手回复：已完成解耦，并记录了验收结果与后续注意事项，保证下一次会话可以直接复用这段结论而不必重新排查' }] } } },
    ],
  },
})

/** 中枢里出现过的 userText 片段（episodes + current 都算）。 */
const hubTexts = (hub) => {
  const out = []
  const push = (e) => {
    if (!e || typeof e !== 'object') return
    if (String(e.intent || '')) out.push(String(e.intent))
    for (const t of Array.isArray(e.userTexts) ? e.userTexts : []) out.push(String(t))
    for (const s of Array.isArray(e.segments) ? e.segments : []) out.push(String(s.userText || ''))
  }
  for (const e of (hub.episodic && Array.isArray(hub.episodic.recent)) ? hub.episodic.recent : []) push(e)
  push(hub.episodic && hub.episodic.current)
  return out.join('\n')
}

console.log('[A] 首轮：额度内的沉淀必须把该轮喂进中枢（夹具自检）')
await stopping({ agent: makeAgent('turn1', path.join(ws, 'w1')), turn: 1 })
ok(await waitUntil(async () => hubTexts(await readHub()).includes('第 turn1 轮')), 'A1 首轮出现在中枢里')

const hubAfter1 = await readHub()
const epSize1 = Number(hubAfter1 && hubAfter1.episodic && hubAfter1.episodic.size) || 0

console.log('[B] 额度耗尽后：中枢取样不得跟着沉淀一起停摆')
await stopping({ agent: makeAgent('turn2', path.join(ws, 'w1')), turn: 2 })
await stopping({ agent: makeAgent('turn3', path.join(ws, 'w1')), turn: 3 })
const turn3Seen = await waitUntil(async () => hubTexts(await readHub()).includes('第 turn3 轮'))
const hubAfter3 = await readHub()
ok(turn3Seen, '★B1 额度用满后的轮次仍然进入中枢（旧实现这里恒为 false）')
ok((Number(hubAfter3 && hubAfter3.episodic && hubAfter3.episodic.size) || 0) > epSize1, '★B2 中枢 episode 数在额度耗尽后继续增长')

console.log('[C] 反证：把取样块挪回额度门之后，B 段必须变红')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8')
  const observeIdx = src.indexOf('_hubObserveTurn(')
  const capIdx = src.indexOf("why('daily subagent cap='")
  ok(observeIdx >= 0 && capIdx >= 0, 'C0 源码里能找到取样调用与额度门（锚点存在）')
  ok(observeIdx < capIdx, '★C1 取样调用必须排在额度门**之前**（挪回去 = 中枢重新被饿死）')
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' pass=' + pass + ' fail=' + fail)
rmSync(ws, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
