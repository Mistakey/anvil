import type { ClassicEventOf, ModelCompleteResult, On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { faultedModule, liveOf } from '../hooks/live'
import { GLOW, GLOW_FADE, SPIN, SWEEP, clockOf, follow, glowStyle, runs, spinGlyph, sweep, ticking } from '../hooks/motion'
import type { Glow } from '../hooks/motion'
import { PING_AFTER_MS } from '../hooks/keepalive'
import { COLOR } from '../hooks/style'
import { SESSION, drain, flat, spawnInput, stepInput, turnInput, world } from './world'

const NOW = 10 * 3_600_000

// ---------------------------------------------------------------- 纯逻辑（Client 模块共用，motion.ts）

test('转动图标：◐◓◑◒ 轮流，约 120ms 一格；第 n 帧按时钟算', () => {
  expect(SPIN.stepMs).toBe(120)
  expect([0, 120, 240, 360, 480].map(spinGlyph)).toEqual(['◐', '◓', '◑', '◒', '◐'])
  expect(spinGlyph(119)).toBe('◐')
  for (const n of [5, 6, 7, 1001]) expect(spinGlyph(n * SPIN.stepMs + 60), `第 ${n} 帧`).toBe(SPIN.frames[n % 4])
})

test('扫光某一帧各格的颜色：约 6 格的亮光中间最亮、两端渐暗，Claude 橙；其余是暗线', () => {
  expect(GLOW).toBe('claude')
  expect(GLOW_FADE).toBe('#996b5f')
  // 第 8 拍：亮光的右端走到第 8 格，占第 3–8 格
  const cells = sweep(20, 8 * SWEEP.stepMs)
  expect(cells).toHaveLength(20)
  expect(cells.slice(0, 3)).toEqual(['rest', 'rest', 'rest'])
  expect(cells.slice(3, 9)).toEqual(['low', 'mid', 'peak', 'peak', 'mid', 'low'])
  expect(cells.slice(9).every(cell => cell === 'rest')).toBe(true)
  expect(cells.slice(2, 10).map(cell => glowStyle(cell, COLOR.faint))).toEqual([
    { color: COLOR.faint },
    { color: GLOW_FADE },
    { color: 'claude' },
    { color: 'claude', bold: true },
    { color: 'claude', bold: true },
    { color: 'claude' },
    { color: GLOW_FADE },
    { color: COLOR.faint },
  ])
})

test('扫光从左往右走，每拍一格；整段扫出右端后从左端重来，一圈是宽度加 6 拍', () => {
  const peak = (step: number) => sweep(20, step * SWEEP.stepMs).indexOf('peak')
  expect(peak(9) - peak(8)).toBe(1)
  // 从左端外面进来：第 0 拍只露出最右的一格
  expect(sweep(20, 0)).toEqual(['low', ...Array<Glow>(19).fill('rest')])
  // 第 25 拍整段已扫出右端，整条暗线；第 26 拍从左端重来
  expect(sweep(20, 25 * SWEEP.stepMs).every(cell => cell === 'rest')).toBe(true)
  expect(sweep(20, 26 * SWEEP.stepMs)).toEqual(sweep(20, 0))
  expect(sweep(20, (3 + 26) * SWEEP.stepMs)).toEqual(sweep(20, 3 * SWEEP.stepMs))
})

test('相位按时钟算：同一时刻几条线在同一位置；钩子给了新的 now 就从它重新数，帧时钟的计时也重新起', () => {
  const timers: string[] = []
  const every = (ms: number) => {
    const id = `t${timers.length + 1}:${ms}`
    timers.push(id)
    return () => void timers.splice(timers.indexOf(id), 1, `${id} 停`)
  }
  const a = ticking(NOW)
  const b = ticking(NOW)
  follow(a, NOW, every, SWEEP.stepMs, () => undefined)
  follow(b, NOW, every, SWEEP.stepMs, () => undefined)
  expect(timers).toEqual(['t1:110', 't2:110'])
  a.ticks = 3
  b.ticks = 3
  expect(clockOf(a, SWEEP.stepMs)).toBe(NOW + 3 * SWEEP.stepMs)
  expect(sweep(30, clockOf(a, SWEEP.stepMs))).toEqual(sweep(30, clockOf(b, SWEEP.stepMs)))
  // 同一个 now：不重数，也不重起计时
  follow(a, NOW, every, SWEEP.stepMs, () => undefined)
  expect(a.ticks).toBe(3)
  expect(timers).toHaveLength(2)
  // 新的 now：从它重新数，旧的计时停掉、从这一刻重起
  follow(a, NOW + 5000, every, SWEEP.stepMs, () => undefined)
  expect(clockOf(a, SWEEP.stepMs)).toBe(NOW + 5000)
  expect(timers).toEqual(['t1:110 停', 't2:110', 't3:110'])
})

test('连续同亮度的格子合成一段', () => {
  expect(runs(['rest', 'rest', 'low', 'mid', 'mid', 'rest'])).toEqual([
    { glow: 'rest', size: 2 },
    { glow: 'low', size: 1 },
    { glow: 'mid', size: 2 },
    { glow: 'rest', size: 1 },
  ])
})

test('有 Client、模块没出过错才用它；ui.fault 报的路径按文件名认', () => {
  const els = { Client: () => null }
  expect(liveOf(els, 'terminal', 5, [])).toEqual({ now: 5, rail: true, spinner: true, elapsed: true })
  expect(liveOf(els, 'desktop', 5, [])).toEqual({ now: 5, rail: true, spinner: true, elapsed: true })
  expect(liveOf(els, 'terminal', 5, ['rail.tsx'])).toEqual({ now: 5, rail: false, spinner: true, elapsed: true })
  expect(liveOf(els, 'terminal', 5, ['rail.tsx', 'spinner.tsx', 'elapsed.tsx'])).toEqual({ now: 5, rail: false, spinner: false, elapsed: false })
  expect(liveOf({}, 'terminal', 5, [])).toEqual({ now: 5, rail: false, spinner: false, elapsed: false })
  // VS Code 的 resolve 也给 Client，但它的元素表里没有，画出来是空的
  expect(liveOf(els, 'vscode', 5, [])).toEqual({ now: 5, rail: false, spinner: false, elapsed: false })
  expect(faultedModule('hooks/rail.tsx')).toBe('rail.tsx')
  expect(faultedModule('hooks\\elapsed.tsx')).toBe('elapsed.tsx')
  expect(faultedModule('./spinner.tsx')).toBe('spinner.tsx')
  expect(faultedModule('hooks/other.tsx')).toBe(null)
})

// ---------------------------------------------------------------- 面板里的动效

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, ...w }
}

const sized = (columns: number) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
})

/** VS Code 的元素表没有 Client */
const vscode = (columns: number) => ({ ...sized(columns), surface: 'vscode' as const })

type Cell = { color?: unknown; bold?: unknown; dimColor?: unknown }

/** Client 画出来的一行，逐格展开成颜色 */
function cellsOf(node: unknown): Cell[] {
  if (node === null || typeof node !== 'object') return []
  const { type, props, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  if (type === 'Text') {
    const style: Cell = {}
    if (props?.color !== undefined) style.color = props.color
    if (props?.bold) style.bold = props.bold
    if (props?.dimColor) style.dimColor = props.dimColor
    return [...flat(node)].map(() => style)
  }
  return (children ?? (props?.children as unknown[] | undefined) ?? []).flatMap(cellsOf)
}

const expected = (width: number, clock: number): Cell[] => sweep(width, clock).map(glow => glowStyle(glow, COLOR.faint))

async function railOf(ui: Mounted<'terminal', 'Pane'>, id: string): Promise<RenderElement> {
  return ui.drawn({ in: `rail:rule:${id}` })
}

test('分隔线和框同宽：暗色细线；主会话没在回复时静止，帧时钟走了也不动', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  for (const columns of [50, 70, 90]) {
    const ui = await $.ui.mount(sized(columns))
    for (const id of ['usage', 'agents', 'messages']) {
      expect((await ui.find({ key: `rule:${id}` }))?.props, `${columns} 列 ${id}`).toMatchObject({ width: columns, height: 1 })
      const client = await ui.find({ key: `rail:rule:${id}` })
      expect(client?.type).toBe('Client')
      expect(client?.props).toMatchObject({ module: 'hooks/rail.tsx', width: columns, height: 1, props: { active: false, width: columns } })
      const rail = await railOf(ui, id)
      expect(flat(rail)).toBe('─'.repeat(columns))
      expect(new Set(cellsOf(rail).map(cell => cell.color))).toEqual(new Set([COLOR.faint]))
    }
    // 缓存框上面、我的消息和身份栏之间不加线
    expect(await ui.find({ key: 'rule:cache' })).toBeUndefined()
    await ui.advance(10 * SWEEP.stepMs)
    expect(flat(await railOf(ui, 'usage'))).toBe('─'.repeat(columns))
    expect(cellsOf(await railOf(ui, 'usage')).every(cell => cell.color === COLOR.faint)).toBe(true)
    await ui.unmount()
  }
})

test('主会话正在回复时亮光从左往右扫，几条线同一时刻同一位置；回复结束停成静止暗线', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  // 这一轮的第一次请求已经开始、还没结束
  await drain($.turn.step(stepInput()))
  const ui = await $.ui.mount(sized(70))
  expect((await ui.find({ key: 'rail:rule:usage' }))?.props).toMatchObject({ props: { active: true, now: NOW } })
  const first = cellsOf(await railOf(ui, 'usage'))
  expect(first).toEqual(expected(70, NOW))
  for (const id of ['agents', 'messages']) expect(cellsOf(await railOf(ui, id)), id).toEqual(first)

  await ui.advance(SWEEP.stepMs)
  const second = cellsOf(await railOf(ui, 'usage'))
  expect(second).toEqual(expected(70, NOW + SWEEP.stepMs))
  expect(second).not.toEqual(first)
  for (const id of ['agents', 'messages']) expect(cellsOf(await railOf(ui, id)), id).toEqual(second)

  await $.turn.complete(turnInput())
  await ui.redraw()
  await ui.advance(SWEEP.stepMs)
  const rail = await railOf(ui, 'usage')
  expect(flat(rail)).toBe('─'.repeat(70))
  expect(cellsOf(rail).every(cell => cell.color === COLOR.faint)).toBe(true)
  await ui.unmount()
})

test('子 agent 的回复不算主会话在回复', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput({ agentId: 'ag1' })))
  const ui = await $.ui.mount(sized(70))
  expect((await ui.find({ key: 'rail:rule:usage' }))?.props).toMatchObject({ props: { active: false } })
  await ui.unmount()
})

test('子 agent 运行中：状态列的 ◐ 原地转动、耗时每秒走；结束后固定', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await clock.advance(5000)
  const ui = await $.ui.mount(sized(70))
  // 压在 Button 的状态列（"1: " 之后）和耗时一列（右对齐 6 格）上
  expect((await ui.find({ key: 'over:mark:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 3 })
  expect((await ui.find({ key: 'over:time:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 70 - 4 - 6 })
  expect((await ui.find({ key: 'spin:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1 })
  expect((await ui.find({ key: 'clock:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/elapsed.tsx', width: 6 })

  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(NOW + 5000))
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    5s')
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(NOW + 5000 + SPIN.stepMs))
  await ui.advance(1000 - SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    6s')
  await ui.advance(60_000)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe(' 1m06s')
  // Button 里照样有静止的 ◐ 和按面板重画时算的耗时，写法和列宽不变
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)

  await clock.advance(2000)
  await $.turn.complete(turnInput({ agentId: 'ag1' }))
  await ui.redraw()
  expect(await ui.find({ key: 'spin:agent:ag1' })).toBeUndefined()
  expect(await ui.find({ key: 'clock:agent:ag1' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^\u{F00C} +核对读数 +Sonnet +7s$/u)
  await ui.unmount()
})

test('缓存框保活：续期请求在路上时"进行中 ◐"，图标接在文字后面，请求结束就去掉', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  // 排在 world 的 fork 之前：这一次续期请求停在路上，放行后读到整段缓存
  on('model.fork', {}, async () => {
    await gate
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 40 } } }
  })
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await clock.advance(PING_AFTER_MS)

  const ui = await $.ui.mount(sized(70))
  const row = await ui.find({ key: 'row:keepalive' })
  // Client 没有子元素：flat 只拿到它前面空的那一格
  expect(flat(row)).toBe('保活进行中 ')
  expect((await ui.find({ key: 'spin:keepalive' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', props: { color: COLOR.ok } })
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(NOW + PING_AFTER_MS))
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(NOW + PING_AFTER_MS + SPIN.stepMs))

  release()
  await clock.settle()
  await ui.redraw()
  expect(await ui.find({ key: 'spin:keepalive' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'row:keepalive' }))).toBe('保活进行中')
  await ui.unmount()
})

// ---------------------------------------------------------------- 翻译框

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('翻译框正在翻译时 ◐ 原地转动，后面的字不动', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  on('model.complete', async () => {
    await gate
    const value: ModelCompleteResult = { isAnswered: true, text: 'Make it async.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    return { value }
  })
  const { clock } = engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const input = await ui.find({ type: 'Input' })
  await ui.input({ key: input?.key ?? '', text: '把函数改成异步的' })
  await clock.settle()
  await ui.redraw()
  const status = await ui.find({ key: 'status:translate' })
  expect(flat(status)).toBe(' 正在翻译')
  expect((await ui.find({ key: 'spin:translate' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', props: { color: COLOR.muted } })
  const now = (await ui.find({ key: 'spin:translate' }))?.props.props as { now: number }
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(now.now))
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(now.now + SPIN.stepMs))
  release()
  await ui.unmount()
})

// ---------------------------------------------------------------- 退路：没有 Client、Client 出错

async function stillPanel($: Engine, ui: Mounted<'terminal', 'Pane'> | Mounted<'vscode', 'Pane'>, columns: number) {
  // 一个 Client 都没有
  expect(await ui.findAll({ type: 'Client' })).toEqual([])
  // 分隔线是静止的暗线
  const line = await ui.find({ key: 'rule:usage' })
  expect(flat(line)).toBe('─'.repeat(columns))
  // 运行中的子 agent：Button 里静止的 ◐ 和按 now 算的耗时
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)
}

test('没有 Client 的界面：分隔线是静止暗线、◐ 静止、耗时随面板重画更新', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput()))
  await clock.advance(5000)
  const ui = await $.ui.mount(vscode(70))
  await stillPanel($, ui, 70)
  await clock.advance(3000)
  await ui.redraw()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +8s$/)
  await ui.unmount()
})

// Client 出错的退路：plugin test 的 `$` 没有 ui.fault，造不出这个事件（AGENTS.md Pitfalls）；
// 出错的模块不再用、退回静止由上面的 liveOf 单测核对，接线在交互会话里验证

// ---------------------------------------------------------------- 配色

test('缓存、用量、子 agent、拒绝四个框的边框用各自的标题色，标题加粗；我的消息边框 muted', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  const denied: ClassicEventOf['classic.PermissionDenied'] = {
    session_id: 's1',
    transcript_path: '/work/s1.jsonl',
    cwd: '/work',
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf dir' },
    tool_use_id: 'deny1',
    reason: 'classifier',
  }
  await $.classic.PermissionDenied(denied)
  const ui = await $.ui.mount(sized(70))
  const sections: [string, string, string][] = [
    ['cache', '缓存', COLOR.cache],
    ['usage', '用量', COLOR.usage],
    ['agents', '子 agent', COLOR.agents],
    ['denials', '自动模式拒绝', COLOR.denials],
  ]
  const texts = await ui.findAll({ type: 'Text' })
  for (const [id, title, color] of sections) {
    expect((await ui.find({ key: `box:${id}` }))?.props.borderColor, id).toBe(color)
    const head = texts.filter(one => (one.text ?? '').endsWith(title))
    expect(head.length, id).toBeGreaterThan(0)
    for (const one of head) expect(one.props, id).toMatchObject({ color, bold: true })
  }
  expect((await ui.find({ key: 'box:messages' }))?.props.borderColor).toBe(COLOR.muted)
  await ui.unmount()
})
