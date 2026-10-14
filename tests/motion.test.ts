import type { ClassicEventOf, ModelCompleteResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { contrast, mix } from '../hooks/color'
import { faultedModule, liveOf } from '../hooks/live'
import {
  FLOW,
  LIGHT,
  SPIN,
  arrival,
  clockOf,
  envelope,
  follow,
  frontAt,
  groove,
  halt,
  isMoving,
  pulseAt,
  runs,
  settle,
  shimmerCells,
  spinGlyph,
  streakAt,
  streakCells,
  ticking,
  travel,
} from '../hooks/motion'
import type { Cell as Square } from '../hooks/motion'
import { PING_AFTER_MS } from '../hooks/keepalive'
import { COLOR, ICON } from '../hooks/style'
import { cells } from '../hooks/text'
import { SESSION, drain, flat, spawnInput, stepInput, turnInput, world } from './world'

const NOW = 10 * 3_600_000

/** 帧时钟一拍 40ms：走过一格图标（144ms）要 4 拍 */
const TURN = 4 * FLOW.stepMs

// ---------------------------------------------------------------- 纯逻辑（Client 模块共用，motion.ts）

test('节奏：一圈 2880ms，光扫 2160ms、歇 720ms；◐◓◑◒ 144ms 一格，一圈正好 20 格；帧时钟 40ms 一拍', () => {
  expect(FLOW.cycleMs / SPIN.stepMs).toBe(20)
  expect(FLOW.stepMs).toBe(40)
  expect([0, 144, 288, 432, 576].map(spinGlyph)).toEqual(['◐', '◓', '◑', '◒', '◐'])
  expect(spinGlyph(143)).toBe('◐')
  expect(travel(0, 0)).toBe(0)
  expect(travel(1080, 0)).toBe(0.5)
  expect(travel(2160, 0)).toBe(null)
  expect(travel(FLOW.cycleMs + 540, 0)).toBe(0.25)
  // 每往下一行晚 10ms 出发：一道斜的波前
  expect(travel(1080, 10)).toBe((1080 - 100) / 2160)
})

test('波前：中间快、两头慢，从框外走到框外；反函数 arrival 找得到每一格', () => {
  const width = 51
  expect(frontAt(0, width)).toBe(-FLOW.pad)
  expect(frontAt(1, width)).toBe(width + FLOW.pad)
  // expect 没有 toBeCloseTo（AGENTS.md Pitfalls）
  expect(Math.abs(frontAt(0.5, width) - width / 2)).toBeLessThan(0.01)
  // 中间一段走得比开头一段多
  expect(frontAt(0.55, width) - frontAt(0.45, width)).toBeGreaterThan(frontAt(0.1, width) - frontAt(0, width))
  for (const x of [0, 10, 25, 50]) expect(Math.abs(frontAt(arrival(x, width), width) - x)).toBeLessThan(0.01)
})

test('流光：头先走、尾晚出发，走到中间最长、两头收短', () => {
  const width = 51
  const lengths = [0.15, 0.3, 0.5, 0.7, 0.85].map(u => {
    const { head, tail } = streakAt(u, width)
    expect(head).toBeGreaterThanOrEqual(tail)
    return head - tail
  })
  expect(Math.max(...lengths)).toBe(lengths[2])
  expect(lengths[2]).toBeGreaterThan(lengths[0] ?? 0)
  expect(lengths[2]).toBeGreaterThan(lengths[4] ?? 0)
})

test('出现、消失、落定：360ms 亮起，结束后 480ms 暗下去、720ms 落定，之后不再动', () => {
  expect(envelope(0, 0, null)).toBe(0)
  expect(envelope(FLOW.inMs, 0, null)).toBe(1)
  expect(envelope(5000, null, null)).toBe(1)
  expect(envelope(5000, 0, 5000)).toBe(1)
  expect(envelope(5000 + FLOW.outMs, 0, 5000)).toBe(0)
  expect(isMoving(5000 + FLOW.outMs - 1, 5000)).toBe(true)
  expect(isMoving(5000 + FLOW.outMs, 5000)).toBe(false)
  expect(settle(5000, null)).toBe(0)
  expect(settle(5000, 5000)).toBe(1)
  expect(settle(5000 + FLOW.settleMs / 2, 5000)).toBeGreaterThan(0)
  expect(settle(5000 + FLOW.settleMs, 5000)).toBe(0)
})

test('细槽：中间略亮、两端隐进面板底色，左右对称；不承载信息，比线暗', () => {
  const line = groove(51, COLOR.pane)
  expect(line).toHaveLength(51)
  expect(line.every(cell => cell.ch === '─')).toBe(true)
  const at = (x: number) => contrast(line[x]?.color ?? COLOR.pane, COLOR.pane)
  expect(at(25)).toBeGreaterThan(at(0))
  expect(at(0)).toBeLessThan(1.1)
  expect(at(10)).toBe(at(40))
  expect(at(25)).toBeLessThan(contrast(COLOR.line, COLOR.pane))
})

test('细槽上的流光：歇着时就是细槽；走着时头是粗线、亮，尾渐细渐暗，两端用半格收', () => {
  const base = groove(51, COLOR.pane)
  // 歇着
  expect(streakCells(base, 2400, 0, 1)).toEqual(base)
  // 还没亮起来
  expect(streakCells(base, 1080, 0, 0)).toEqual(base)
  const lit = streakCells(base, 1080, 0, 1)
  const glyphs = lit.map(cell => cell.ch).join('')
  expect(glyphs).toMatch(/━/)
  expect(glyphs).toMatch(/─━/)
  // 头最亮：粗线段的最后一格是 Claude 的微光色一带，比本色亮
  const heavy = lit.map((cell, x) => ({ ...cell, x })).filter(cell => cell.ch === '━' || cell.ch === '╸')
  const head = heavy[heavy.length - 1]
  expect(contrast(head?.color ?? COLOR.pane, COLOR.pane)).toBeGreaterThan(contrast(LIGHT.body, COLOR.pane))
  // 尾巴在头的左边：从左往右走
  const first = lit.findIndex((cell, x) => cell.color !== base[x]?.color)
  expect(first).toBeLessThan(head?.x ?? 0)
  // 一路上半格的字形都可能出现，但只出现在两端
  for (const [x, cell] of lit.entries()) {
    if (cell.ch === '╸') expect(lit[x + 1]?.ch, `${x}`).toBe(base[x + 1]?.ch)
  }
})

test('字上的微光：波前到了这个词，亮光用 1 秒滚过；之外是本色', () => {
  const word: Square[] = [...'Opus 5.5'].map(ch => ({ ch, color: LIGHT.body }))
  const width = 51
  const reach = arrival(4, width) * FLOW.sweepMs
  // 波前还没到
  expect(shimmerCells(word, reach - 100, 0, 1, LIGHT.core, 4, width)).toEqual(word)
  // 到了之后半秒：中间几个字亮了
  const mid = shimmerCells(word, reach + FLOW.shimmerMs / 2, 0, 1, LIGHT.core, 4, width)
  expect(mid.some(cell => cell.color !== LIGHT.body)).toBe(true)
  // 滚完了
  expect(shimmerCells(word, reach + FLOW.shimmerMs + 10, 0, 1, LIGHT.core, 4, width)).toEqual(word)
})

test('进行中图标随波前亮一下：到达后 480ms 里先亮后暗', () => {
  const width = 51
  const reach = arrival(2, width) * FLOW.sweepMs
  expect(pulseAt(reach - 50, 0, 2, width)).toBe(0)
  expect(pulseAt(reach + FLOW.pulseMs / 2, 0, 2, width)).toBeGreaterThan(0.9)
  expect(pulseAt(reach + FLOW.pulseMs + 1, 0, 2, width)).toBe(0)
})

test('颜色在 OKLab 里插值、取到 1/16 档；相邻同色的格子并成一段', () => {
  expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
  expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
  expect(mix('#000000', '#ffffff', 0.5)).toBe(mix('#000000', '#ffffff', 0.51))
  expect(runs([{ ch: 'a', color: '#111111' }, { ch: 'b', color: '#111111' }, { ch: 'c' }])).toEqual([{ ch: 'ab', color: '#111111' }, { ch: 'c' }])
})

test('相位按时钟算：钩子给了新的 now 就从它重新数、计时重起；动完 halt 停掉计时，不空转', () => {
  const timers: string[] = []
  const every = (ms: number) => {
    const id = `t${timers.length + 1}:${ms}`
    timers.push(id)
    return () => void timers.splice(timers.indexOf(id), 1, `${id} 停`)
  }
  const a = ticking(NOW)
  const b = ticking(NOW)
  follow(a, NOW, every, FLOW.stepMs, () => undefined)
  follow(b, NOW, every, FLOW.stepMs, () => undefined)
  expect(timers).toEqual(['t1:40', 't2:40'])
  a.ticks = 3
  b.ticks = 3
  expect(clockOf(a, FLOW.stepMs)).toBe(NOW + 3 * FLOW.stepMs)
  expect(spinGlyph(clockOf(a, FLOW.stepMs))).toBe(spinGlyph(clockOf(b, FLOW.stepMs)))
  // 同一个 now：不重数，也不重起计时
  follow(a, NOW, every, FLOW.stepMs, () => undefined)
  expect(a.ticks).toBe(3)
  expect(timers).toHaveLength(2)
  // 新的 now：从它重新数，旧的计时停掉、从这一刻重起
  follow(a, NOW + 5000, every, FLOW.stepMs, () => undefined)
  expect(clockOf(a, FLOW.stepMs)).toBe(NOW + 5000)
  expect(timers).toEqual(['t1:40 停', 't2:40', 't3:40'])
  // 动完了：停掉，同一个 now 不再重起
  halt(a)
  expect(timers).toEqual(['t1:40 停', 't2:40', 't3:40 停'])
  follow(a, NOW + 5000, every, FLOW.stepMs, () => undefined)
  expect(timers).toHaveLength(3)
})

test('有 Client、模块没出过错才用它；ui.fault 报的路径按文件名认', () => {
  const els = { Client: () => null }
  const all = { now: 5, epoch: 2, spinner: true, elapsed: true, rail: true, glow: true }
  expect(liveOf(els, 'terminal', 5, [], 2)).toEqual(all)
  expect(liveOf(els, 'desktop', 5, [], 2)).toEqual(all)
  expect(liveOf(els, 'terminal', 5, ['rail.tsx', 'glow.tsx'], 2)).toEqual({ ...all, rail: false, glow: false })
  expect(liveOf({}, 'terminal', 5, [])).toEqual({ now: 5, epoch: 0, spinner: false, elapsed: false, rail: false, glow: false })
  // VS Code 的 resolve 也给 Client，但它的元素表里没有，画出来是空的
  expect(liveOf(els, 'vscode', 5, [])).toEqual({ now: 5, epoch: 0, spinner: false, elapsed: false, rail: false, glow: false })
  expect(faultedModule('hooks/rail.tsx')).toBe('rail.tsx')
  expect(faultedModule('hooks\\glow.tsx')).toBe('glow.tsx')
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

/** 一行里各段字和它的颜色（Text 嵌套时沿用外层的颜色） */
function textsOf(node: unknown, inherited?: unknown): { text: string; color?: unknown }[] {
  if (node === null || typeof node !== 'object') return []
  const { type, props, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const color = type === 'Text' && props?.color !== undefined ? props.color : inherited
  const kids = children ?? (props?.children as unknown[] | undefined) ?? []
  const own = kids.filter((kid): kid is string => typeof kid === 'string').join('')
  const nested = kids.filter(kid => typeof kid !== 'string').flatMap(kid => textsOf(kid, color))
  return type === 'Text' && own !== '' ? [{ text: own, color }, ...nested] : nested
}

/** 回复中：第二轮的第一次请求已经开始、还没结束（这一刻是相位的零点） */
async function replying($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await clock.advance(1000)
  await drain($.turn.step(stepInput()))
}

test('框与框之间是一道细槽（不是空行、也不是线）；没有东西在发生时面板上一个 Client 都没有', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [50, 70, 90]) {
    const ui = await $.ui.mount(sized(columns))
    for (const id of ['usage', 'messages']) {
      const gap = await ui.find({ key: `gap:${id}` })
      expect(gap?.props, `${columns} 列 ${id}`).toMatchObject({ width: columns, height: 1 })
      expect(flat(gap)).toBe('─'.repeat(columns))
      // 两端隐进底色，中间略亮
      const colors = textsOf(gap).map(one => one.color)
      expect(colors[0]).toBe(COLOR.pane)
      expect(new Set(colors).size).toBeGreaterThan(2)
    }
    // 缓存框上面没有细槽
    expect(await ui.find({ key: 'gap:cache' })).toBeUndefined()
    expect(await ui.findAll({ type: 'Client' })).toEqual([])
    expect(flat(await ui.find({ key: 'identity:speed' }))).toBe(`${ICON.speed} —`)
    await ui.unmount()
  }
})

test('主会话回复中：细槽上走流光、模型名变成 Claude 橙并有微光滚过、速度行图标转动，几处同一个相位零点', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await replying($, clock)
  const since = NOW + 1000
  await clock.advance(300)
  const ui = await $.ui.mount(sized(70))
  // 细槽：rail.tsx，带回复开始的时刻
  const rail = await ui.find({ key: 'rail:usage' })
  expect(rail?.props).toMatchObject({ module: 'hooks/rail.tsx', width: 70, props: { now: since + 300, epoch: since, since, width: 70 } })
  expect((rail?.props.props as { until?: number }).until).toBeUndefined()
  // 细槽在面板第 5 行（缓存框 5 行之后），下一道在用量框之后：越往下出发越晚
  const rows = await Promise.all(['rail:usage', 'rail:messages'].map(async key => ((await ui.find({ key }))?.props.props as { row: number }).row))
  expect(rows[0]).toBe(5)
  expect(rows[1]).toBeGreaterThan(rows[0] ?? 0)
  // 走进第一趟的中段：粗线、亮的头
  await ui.advance(600)
  const drawn = await ui.drawn({ in: 'rail:usage' })
  expect(flat(drawn)).toMatch(/━/)
  expect(flat(drawn)).toHaveLength(70)

  // 模型名：glow.tsx，lit 是 Claude 橙，光是更亮的一档
  const model = await ui.find({ key: 'glow:model' })
  expect(model?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'shimmer', lit: LIGHT.body, shine: LIGHT.core, epoch: since, x: 4 } })
  expect(flat(await ui.drawn({ in: 'glow:model' }))).toBe('Opus 5.5')

  // 速度行：转动的 ◐，读数退到次要色
  const spin = await ui.find({ key: 'spin:speed' })
  expect(spin?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1, props: { epoch: since, x: 2, row: 48 - 1 } })
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(900))
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(900 + TURN))
  const numbers = textsOf(await ui.find({ key: 'identity:speed' })).filter(one => /\d|—/.test(one.text))
  expect(numbers.length).toBeGreaterThan(0)
  for (const one of numbers) expect(one.color, one.text).toBe(COLOR.secondary)
  await ui.unmount()
})

test('回复结束：流光暗下去，模型名落回正文色，新的读数和闪电图标从微光色落回原色；落定后一个 Client 都不剩', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await replying($, clock)
  await clock.advance(2000)
  await $.turn.complete(turnInput())
  const ended = NOW + 3000
  const ui = await $.ui.mount(sized(70))
  expect(await ui.find({ key: 'spin:speed' })).toBeUndefined()
  // 速度行整行交给 glow.tsx 落定：闪电和读数标了 lit
  const speed = await ui.find({ key: 'glow:speed' })
  expect(speed?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'flash', shine: LIGHT.shine, until: ended } })
  const lit = (speed?.props.props as { cells: Square[] }).cells
  expect(lit[0]).toMatchObject({ ch: ICON.speed, color: COLOR.icon, lit: true })
  expect(lit.filter(cell => cell.lit && /\d|—/.test(cell.ch)).length).toBeGreaterThan(0)
  expect(lit.filter(cell => cell.lit && cell.color !== undefined && cell.ch !== ICON.speed)).toEqual([])
  // 刚结束：读数是微光色
  const first = textsOf(await ui.drawn({ in: 'glow:speed' }))
  expect(first[0]).toMatchObject({ text: ICON.speed, color: LIGHT.shine })
  // 模型名、细槽还在落定、暗下去
  expect((await ui.find({ key: 'glow:model' }))?.props).toMatchObject({ props: { until: ended } })
  expect((await ui.find({ key: 'rail:usage' }))?.props).toMatchObject({ props: { until: ended } })
  // Client 自己走完落定：画回原色
  await ui.advance(FLOW.settleMs + 40)
  const settled = textsOf(await ui.drawn({ in: 'glow:speed' }))
  expect(settled[0]).toMatchObject({ text: ICON.speed, color: COLOR.icon })
  expect(textsOf(await ui.drawn({ in: 'glow:model' })).map(one => one.color)).toEqual([undefined])
  // 面板下一次重画：一个 Client 都不剩，读数正文色
  await clock.advance(1000)
  await ui.redraw()
  expect(await ui.findAll({ type: 'Client' })).toEqual([])
  const after = textsOf(await ui.find({ key: 'identity:speed' }))
  expect(after[0]).toMatchObject({ text: ICON.speed, color: COLOR.icon })
  for (const one of after.filter(item => /\d|—/.test(item.text))) expect(one.color, one.text).toBeUndefined()
  await ui.unmount()
})

test('子 agent 的回复不算主会话在回复', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput({ agentId: 'ag1' })))
  const ui = await $.ui.mount(sized(70))
  expect(await ui.find({ key: 'spin:speed' })).toBeUndefined()
  expect(await ui.find({ key: 'rail:usage' })).toBeUndefined()
  await ui.unmount()
})

test('子 agent 运行中：状态列的 ◐ 转动、任务上滚过微光、耗时每秒走；结束后固定', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await clock.advance(5000)
  const ui = await $.ui.mount(sized(70))
  // 压在 Button 的状态列（"1: " 之后）、任务一列和耗时一列（右对齐 6 格）上
  expect((await ui.find({ key: 'over:mark:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 3 })
  expect((await ui.find({ key: 'over:task:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 6 })
  expect((await ui.find({ key: 'over:time:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 70 - 4 - 6 })
  // 只有子 agent 在跑：相位的零点是它开始的时刻
  expect((await ui.find({ key: 'spin:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1, props: { epoch: NOW, x: 5 } })
  expect((await ui.find({ key: 'glow:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'shimmer', shine: LIGHT.shine, x: 8, since: NOW } })
  expect(flat(await ui.drawn({ in: 'glow:agent:ag1' }))).toBe('核对读数')
  expect((await ui.find({ key: 'clock:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/elapsed.tsx', width: 6 })

  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(5000))
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    5s')
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(5000 + TURN))
  await ui.advance(1000 - TURN)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    6s')
  await ui.advance(60_000)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe(' 1m06s')
  // Button 里照样有静止的 ◐ 和按面板重画时算的耗时，写法和列宽不变
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)

  await clock.advance(2000)
  await $.turn.complete(turnInput({ agentId: 'ag1' }))
  await ui.redraw()
  expect(await ui.find({ key: 'spin:agent:ag1' })).toBeUndefined()
  expect(await ui.find({ key: 'glow:agent:ag1' })).toBeUndefined()
  expect(await ui.find({ key: 'clock:agent:ag1' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^\u{F00C} +核对读数 +Sonnet +7s$/u)
  await ui.unmount()
})

test('缓存框保活：续期请求在路上时"进行中"上滚过微光、后面接转动的 ◐，请求结束就去掉', async ($, on) => {
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
  const glow = await ui.find({ key: 'glow:keepalive' })
  // 缓存框第三行，值从第 10 列起；续期开始的时刻是相位的零点
  expect(glow?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'shimmer', shine: LIGHT.shine, row: 3, x: 10, epoch: NOW + PING_AFTER_MS } })
  expect(flat(await ui.drawn({ in: 'glow:keepalive' }))).toBe('进行中')
  expect((await ui.find({ key: 'spin:keepalive' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', props: { row: 3, x: 17 } })
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(0))
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(TURN))

  release()
  await clock.settle()
  await ui.redraw()
  expect(await ui.find({ key: 'spin:keepalive' })).toBeUndefined()
  expect(await ui.find({ key: 'glow:keepalive' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'row:keepalive' }))).toBe('保活进行中')
  await ui.unmount()
})

// ---------------------------------------------------------------- 翻译框

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('翻译框正在翻译：上边框扫过亮光、"正在翻译"上滚过微光、◐ 原地转动，后面的字不动', async ($, on) => {
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
  // 上边框：rail.tsx 的 glint，带着整条线（标题加粗、不上色）和亮一档的线色
  const line = await ui.find({ key: 'line:translate' })
  expect(line?.props).toMatchObject({ module: 'hooks/rail.tsx', width: 120, props: { tint: '#bdbdbd', row: 0 } })
  const rule = (line?.props.props as { cells: Square[] }).cells
  expect(rule.map(cell => cell.ch).join('')).toMatch(/^── .* ─+$/)
  expect(cells(flat(await ui.drawn({ in: 'line:translate' })))).toBe(120)
  // 状态：◐ 和"正在翻译"都是 Client
  expect(flat(await ui.drawn({ in: 'glow:translate' }))).toBe(' 正在翻译')
  const spin = await ui.find({ key: 'spin:translate' })
  expect(spin?.props).toMatchObject({ module: 'hooks/spinner.tsx' })
  const props = spin?.props.props as { now: number; epoch: number }
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(props.now - props.epoch))
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(props.now - props.epoch + TURN))
  release()
  await ui.unmount()
})

// ---------------------------------------------------------------- 退路：没有 Client、Client 出错

async function stillPanel($: Engine, ui: Mounted<'terminal', 'Pane'> | Mounted<'vscode', 'Pane'>, columns: number) {
  // 一个 Client 都没有
  expect(await ui.findAll({ type: 'Client' })).toEqual([])
  // 框间是静止的细槽
  expect(flat(await ui.find({ key: 'gap:usage' }))).toBe('─'.repeat(columns))
  // 运行中的子 agent：Button 里静止的 ◐ 和按 now 算的耗时
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)
}

test('没有 Client 的界面：◐ 静止、耗时随面板重画更新；回复中模型名直接是 Claude 橙、速度行是静止的 ◐', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput()))
  await clock.advance(5000)
  const ui = await $.ui.mount(vscode(70))
  await stillPanel($, ui, 70)
  expect(flat(await ui.find({ key: 'identity:speed' }))).toMatch(/^◐/)
  expect(textsOf(await ui.find({ key: 'identity:model' })).find(one => one.text === 'Opus 5.5')?.color).toBe(LIGHT.body)
  await clock.advance(3000)
  await ui.redraw()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +8s$/)
  await ui.unmount()
})

// Client 出错的退路：plugin test 的 `$` 没有 ui.fault，造不出这个事件（AGENTS.md Pitfalls）；
// 出错的模块不再用、退回静止由上面的 liveOf 单测核对，接线在交互会话里验证

// ---------------------------------------------------------------- 框

test('四个彩框：标题识别色加粗；侧边是识别色调暗的一档；上边框从标题处的光渐暗到侧边。我的消息中性', async ($, on) => {
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
  const sections: [string, string, string, string][] = [
    ['cache', '缓存', COLOR.cache, COLOR.cacheLine],
    ['usage', '用量', COLOR.usage, COLOR.usageLine],
    ['agents', '子 agent', COLOR.agents, COLOR.agentsLine],
    ['denials', '自动模式拒绝', COLOR.denials, COLOR.denialsLine],
    ['messages', '我的消息', COLOR.messages, COLOR.messagesLine],
  ]
  const texts = await ui.findAll({ type: 'Text' })
  for (const [id, title, color, border] of sections) {
    expect((await ui.find({ key: `box:${id}` }))?.props.borderColor, id).toBe(border)
    // 上边框整行压在框的第一行上：两角是侧边的颜色，标题后面最亮，往右渐暗到侧边
    const edge = await ui.find({ key: `edge:section:${id}` })
    expect(edge?.props, id).toMatchObject({ position: 'absolute', top: 0, left: 0 })
    const line = textsOf(edge)
    expect(line.map(one => one.text).join(''), id).toMatch(/^╭─+╮$/)
    expect(line[0]?.color, id).toBe(border)
    expect(line[line.length - 1]?.color, id).toBe(border)
    const lit = line.slice(1, -1).map(one => contrast(String(one.color), COLOR.pane))
    expect(Math.max(...lit), id).toBeGreaterThan(contrast(border, COLOR.pane) + 1)
    if (id === 'messages') continue
    const head = texts.filter(one => (one.text ?? '').endsWith(title))
    expect(head.length, id).toBeGreaterThan(0)
    for (const one of head) expect(one.props, id).toMatchObject({ color, bold: true })
  }
  await ui.unmount()
})
