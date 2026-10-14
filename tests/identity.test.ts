import type { On, SessionAppendInput, TurnStepChunk, TurnStepInput, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { EMPTY_TALLY, addTally, averageFirstToken, engineDuration, engineTurnText, formatSeconds, requestSpeed, speedLine, tokensPerSecond, turnSuffix } from '../hooks/identity'
import { COLOR, ICON } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import type { Identity, SpeedTally } from '../types'
import { turnInput } from './world'

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 400, cache_read_input_tokens: 150000, cache_creation_input_tokens: 500, model: 'claude-opus-5-5', ...over,
})

/**
 * 一次请求的时间线：等 firstMs 来响应的第一块，再用 streamMs 流完，最后是带用量的 stop。
 * 真实请求的第一块是引擎的信封（engine 块），测试造不出 engine 块，拿思考不出正文时的空 thinking 块代替
 */
type Timing = { firstMs: number; streamMs: number; output: number }

// 插件之下的世界：请求按 timing 流出
function engine(on: On, timing: { current: Timing } = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }) {
  const clock = mock.clock(on, { now: 10 * 3_600_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const { firstMs, streamMs, output } = timing.current
    await clock.sleep(firstMs)
    const thinking: TurnStepChunk = { kind: 'thinking', index: 0, text: '' }
    yield thinking
    await clock.sleep(streamMs)
    const done = usage({ output_tokens: output })
    const stop: TurnStepChunk = { kind: 'stop', stopReason: 'end_turn', usage: done }
    yield stop
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: done }
  })
  return { clock }
}

type Engine = Parameters<TestBody>[0]

const SESSION = { cwd: 'C:\\w\\anvil', surface: null, isInteractive: true }

const pane = (bodyColumns: number) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
})

/** 画出来的一个元素里所有的字，按文档顺序 */
function flat(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flat).join('')
  if (node !== null && typeof node === 'object') {
    const { children, props } = node as { children?: unknown; props?: { children?: unknown } }
    return flat(children ?? props?.children ?? [])
  }
  return ''
}

const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')

const { speed: V } = ICON

// ---------------------------------------------------------------- 速度

const one = (output: number, generationMs: number, firstTokenMs: number, isLowerBound = false): SpeedTally => ({ requests: 1, output, generationMs, firstTokenMs, isLowerBound })

const IDENTITY: Identity = { speed: addTally(one(400, 8000, 2000), one(280, 2000, 1000)) }

test('一次请求：生成用时从首字算到结束；整段一起到（快过 1000 token/s）或只来了 stop 时退回整次用时，标作下限；算不出时为 null', () => {
  expect(requestSpeed(400, 0, 2000, 10000)).toEqual(one(400, 8000, 2000))
  // .51 探针：Opus 工具调用后的一次请求，信封在 1792ms 才到，99 token 在 50ms 里全到
  expect(requestSpeed(99, 0, 1792, 1842)).toEqual(one(99, 1842, 1792, true))
  expect(requestSpeed(400, 0, 5000, 5000)).toEqual(one(400, 5000, 5000, true))
  expect(requestSpeed(400, 0, null, 10000)).toEqual(one(400, 10000, 10000, true))
  expect(requestSpeed(400, 0, 2000, null)).toBe(null)
  expect(requestSpeed(400, 0, 0, 0)).toBe(null)
  expect(requestSpeed(0, 0, 0, 1000)).toBe(null)
})

test('合计：token/s 按 token 加权（总输出 ÷ 总生成用时），不是各次速度的平均；首字取平均；量得出的请求才算进 token/s，都是下限时才标作下限', () => {
  // 400 token / 8 秒（50/s）和 280 token / 2 秒（140/s）：680 ÷ 10 秒 = 68，不是 95
  expect(tokensPerSecond(IDENTITY.speed)).toBe(68)
  expect(averageFirstToken(IDENTITY.speed)).toBe(1500)
  expect(IDENTITY.speed.isLowerBound).toBe(false)
  // 一次整段一起到的请求：首字照算，token/s 不受它影响、不标下限；先来的是下限也一样
  const mixed = addTally(IDENTITY.speed, one(99, 1842, 1792, true))
  expect([tokensPerSecond(mixed), Math.round(averageFirstToken(mixed) ?? 0), mixed.isLowerBound]).toEqual([68, 1597, false])
  expect(addTally(addTally(EMPTY_TALLY, one(99, 1842, 1792, true)), one(400, 8000, 2000))).toEqual({ requests: 2, output: 400, generationMs: 8000, firstTokenMs: 3792, isLowerBound: false })
  // 都是下限：按下限合计
  expect(addTally(one(99, 1842, 1792, true), one(100, 1000, 900, true))).toEqual({ requests: 2, output: 199, generationMs: 2842, firstTokenMs: 2692, isLowerBound: true })
  expect(tokensPerSecond(EMPTY_TALLY)).toBe(null)
  expect(averageFirstToken(EMPTY_TALLY)).toBe(null)
})

test('身份栏写平均：平均 N token/s · 首字 N s（图标另画），数值不着色、token/s 右对齐到定宽；回复中数值次要色', () => {
  const line = speedLine(IDENTITY)
  expect(text(line)).toBe('平均   68 token/s · 首字 1.5s')
  for (const value of ['  68', '1.5s']) expect(line.find(segment => segment.text === value)?.color).toBeUndefined()
  // 主会话回复中：这一次还没算进平均，数值退到次要色，写法和位置不变
  const replying = speedLine(IDENTITY, true)
  expect(text(replying)).toBe(text(line))
  for (const value of ['  68', '1.5s']) expect(replying.find(segment => segment.text === value)?.color).toBe(COLOR.secondary)
  // 数字变长变短、标不标 ≥ 时，"首字"不挪位置
  const at = (identity: Identity) => text(speedLine(identity)).indexOf('首字')
  for (const speed of [one(312, 1000, 12_700), one(9, 1000, 95_400), one(99, 1842, 1792, true), one(999, 1000, 0, true)]) {
    expect(at({ ...IDENTITY, speed })).toBe(at(IDENTITY))
  }
})

test('身份栏：计入的请求都用了退路时数字前标 ≥，有量得出的就不标；还没有请求时写 —', () => {
  expect(text(speedLine({ ...IDENTITY, speed: one(99, 1842, 1792, true) }))).toBe('平均  ≥54 token/s · 首字 1.8s')
  expect(text(speedLine({ ...IDENTITY, speed: addTally(IDENTITY.speed, one(99, 1842, 1792, true)) }))).toBe('平均   68 token/s · 首字 1.6s')
  expect(text(speedLine({ ...IDENTITY, speed: EMPTY_TALLY }))).toBe('—')
})

test('原生收尾那行的时长写法：不到 1 分钟往下取整秒，往上 1m 4s、1h 2m 3s、1d 1h 1m', () => {
  expect([0, 4999, 59_999, 60_000, 64_000, 64_600, 3_723_000, 90_061_000].map(engineDuration)).toEqual(['0s', '4s', '59s', '1m 0s', '1m 4s', '1m 5s', '1h 2m 3s', '1d 1h 1m'])
})

test('每段末尾：原生那行画出的字和接在后面的读数；有子 agent 在跑时原生那行写成在等它', () => {
  const doneAt = new Date(2026, 9, 14, 15, 43, 20).getTime()
  const turn = { tally: IDENTITY.speed, firstTokenMs: 2000, doneAt, waitingAgents: 0 }
  expect(engineTurnText({ word: 'Baked', durationMs: 64_000 }, turn)).toBe('Baked for 1m 4s · done 15:43')
  expect(engineTurnText({ word: 'Baked', durationMs: 64_000 }, { ...turn, waitingAgents: 1 })).toBe('Waiting for 1 background agent to finish')
  expect(engineTurnText({ word: 'Baked', durationMs: 64_000 }, { ...turn, waitingAgents: 2 })).toBe('Waiting for 2 background agents to finish')
  // 首字取这一段第一次请求的，不是平均
  expect(turnSuffix(turn)).toBe(' · 68 token/s · 首字 2.0s')
  expect(turnSuffix({ ...turn, tally: one(99, 1842, 1792, true), firstTokenMs: 1792 })).toBe(' · ≥54 token/s · 首字 1.8s')
})

test('秒数：不到 60 秒一位小数，60 秒起按 1m35s', () => {
  expect([0, 1500, 12_740, 59_940, 60_000, 95_400, 3_725_000].map(formatSeconds)).toEqual(['0.0s', '1.5s', '12.7s', '59.9s', '1m00s', '1m35s', '1h02m'])
})

/** 身份栏那一行 */
async function speedRow($: Engine, columns = 70): Promise<string> {
  const ui = await $.ui.mount(pane(columns))
  const line = flat(await ui.find({ key: 'identity:speed' }))
  await ui.unmount()
  return line
}

type Clock = { advance: (ms: number) => Promise<void> }

/** 跑完一次请求，这一轮不结束：时钟走到它流完 */
async function request($: Engine, clock: Clock, input: TurnStepInput) {
  const stream = $.turn.step(input)
  const drained = (async () => {
    for await (const chunk of stream) void chunk
    return stream.result
  })()
  await clock.advance(60_000)
  return drained
}

/** 跑完一次请求：时钟走到它流完 */
async function step($: Engine, clock: Clock, input: TurnStepInput) {
  const result = await request($, clock, input)
  // 主会话的这一轮结束：回复中速度行的图标是转动的 ◐，结束后才是闪电图标；
  // 结束后 720ms 里读数在落定（交给 Client 画），走过这一段再读
  if (input.agentId === undefined) {
    await $.turn.complete(turnInput())
    await clock.advance(1000)
  }
  return result
}

test('身份栏是本会话主会话请求的平均；子 agent 的请求不计入', async ($, on) => {
  const timing = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }
  const { clock } = engine(on, timing)
  await $.session.start(SESSION)
  expect(await speedRow($)).toBe(`${V} —`)

  // 首字前等了 2 秒不算进速度：400 tokens ÷ 8 秒
  await step($, clock, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  expect(await speedRow($)).toBe(`${V} 平均   50 token/s · 首字 2.0s`)

  timing.current = { firstMs: 500, streamMs: 1000, output: 900 }
  await step($, clock, { turnId: 't2', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 3, agentId: 'ag1' })
  expect(await speedRow($)).toBe(`${V} 平均   50 token/s · 首字 2.0s`)

  // 平均按 token 加权：(400 + 360) ÷ (8 + 4) 秒 = 63，首字 (2 + 1.5) ÷ 2
  timing.current = { firstMs: 1500, streamMs: 4000, output: 360 }
  await step($, clock, { turnId: 't3', index: 0, model: 'claude-sonnet-5-5', effort: 'max', messageCount: 5 })
  expect(await speedRow($)).toBe(`${V} 平均   63 token/s · 首字 1.8s`)
})

test('整段一起到的请求：流速算不出，按整次用时算，平均前标 ≥', async ($, on) => {
  // 第一块在 1.8 秒才到、99 token 在 50ms 里全到：按 99 ÷ 1.85 秒
  const timing = { current: { firstMs: 1800, streamMs: 50, output: 99 } }
  const { clock } = engine(on, timing)
  await $.session.start(SESSION)
  await step($, clock, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  expect(await speedRow($)).toBe(`${V} 平均  ≥54 token/s · 首字 1.8s`)
})

/** 引擎把主会话一段回复的收尾那行记进对话 */
const turnDuration = (uuid: string, agentId?: string): SessionAppendInput =>
  ({
    message: { type: 'system', name: 'turn_duration', content: [] },
    door: 'notice',
    origin: { kind: 'engine' },
    uuid,
    ...(agentId ? { agentId } : {}),
  }) as unknown as SessionAppendInput

/** 原生收尾那行的替身：测试里引擎不画 TurnDuration */
function engineTurnRow(on: On) {
  on('ui.render', { component: 'TurnDuration' }, () => ({ type: 'Text', children: ['✻ Baked for 12s'] }) as never)
}

/** 画收尾那行（TurnDuration），读画出来的字 */
async function turnRow($: Engine, uuid: string): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'TurnDuration', requestId: uuid, props: { word: 'Baked', durationMs: 12_000 } })
  const shown = flat(await ui.drawn())
  await ui.unmount()
  return shown
}

/** 一段回复：几次请求，收尾那行记进对话，这一轮结束 */
async function turn($: Engine, clock: Clock, timing: { current: Timing }, turnId: string, uuid: string, requests: Timing[]) {
  for (const [index, timed] of requests.entries()) {
    timing.current = timed
    await request($, clock, { turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  }
  await $.session.append(turnDuration(uuid))
  await $.turn.complete(turnInput({ turnId }))
  await clock.advance(1000)
}

test('每段回复末尾接这一段的 token/s（这一段各次请求加权，工具执行的时间不算）和首字（这一段第一次请求的）', async ($, on) => {
  const timing = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }
  const { clock } = engine(on, timing)
  engineTurnRow(on)
  await $.session.start(SESSION)
  // 第一段两次请求，中间隔着工具执行：(400 + 280) ÷ (8 + 2) 秒 = 68；首字是第一次的 2 秒
  await turn($, clock, timing, 't1', 'u1', [{ firstMs: 2000, streamMs: 8000, output: 400 }, { firstMs: 1000, streamMs: 2000, output: 280 }])
  // 第二段一次请求，整段一起到
  await turn($, clock, timing, 't2', 'u2', [{ firstMs: 1800, streamMs: 50, output: 99 }])
  expect(await turnRow($, 'u1')).toContain(' · 68 token/s · 首字 2.0s')
  expect(await turnRow($, 'u2')).toContain(' · ≥54 token/s · 首字 1.8s')
  // 面板是三次请求的平均：token/s 只算量得出流速的两次，680 ÷ 10 秒 = 68，不标 ≥；首字 (2 + 1 + 1.8) ÷ 3
  expect(await speedRow($)).toBe(`${V} 平均   68 token/s · 首字 1.6s`)
  // 读数压在原生那行的最后一行上，从原生的字（图标占 2 格）之后起
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'TurnDuration', requestId: 'u1', props: { word: 'Baked', durationMs: 12_000 } })
  const overlay = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')
  // done 后面是收尾时刻 HH:MM
  expect(overlay?.props).toMatchObject({ bottom: 0, left: 2 + cells('Baked for 12s · done 00:00') })
  await ui.unmount()
  // 没有读数的收尾那行（恢复前的）照原样
  expect(await turnRow($, 'u0')).not.toContain('token/s')
})

test('换了对话（/clear）：平均从零算，之前的收尾行不再接读数', async ($, on) => {
  const timing = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }
  const { clock } = engine(on, timing)
  engineTurnRow(on)
  on('classic.SessionStart', () => ({}))
  await $.session.start(SESSION)
  await turn($, clock, timing, 't1', 'u1', [{ firstMs: 2000, streamMs: 8000, output: 400 }])
  await $.classic.SessionStart({ source: 'clear' })
  expect(await speedRow($)).toBe(`${V} —`)
  expect(await turnRow($, 'u1')).not.toContain('token/s')
  await turn($, clock, timing, 't2', 'u2', [{ firstMs: 1000, streamMs: 4000, output: 400 }])
  expect(await speedRow($)).toBe(`${V} 平均  100 token/s · 首字 1.0s`)
})

// ---------------------------------------------------------------- 排版

test('身份栏一行在面板最底（我的消息下面）；各种宽度下都不超出面板', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await step($, clock, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3 })
  for (const columns of [110, 70, 52, 40]) {
    const ui = await $.ui.mount(pane(columns))
    const row = await ui.find({ key: 'identity:speed' })
    // 左边空 2 格：图标和框里的名称列、序号从同一列起；右边空 1 格，和框的右边线对齐
    expect(row?.props).toMatchObject({ width: columns, paddingLeft: 2, paddingRight: 1 })
    const shown = flat(row)
    expect(cells(shown) <= columns - 3, `${columns} 列：${shown}`).toBe(true)
    const order = (await ui.findAll({ type: 'Box' })).map(one => one.key).filter(key => key?.startsWith('section:') || key?.startsWith('identity:'))
    expect(order.slice(-2)).toEqual(['section:messages', 'identity:speed'])
    // 目录、git、模型、effort 交还 statusline，面板不画
    expect(order).not.toContain('identity:git')
    expect(order).not.toContain('identity:model')
    await ui.unmount()
  }
})
