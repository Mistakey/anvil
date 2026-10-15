import type { On, SessionAppendInput, TurnStepChunk, TurnStepInput, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { EMPTY_TALLY, addTally, engineDuration, engineTurnText, formatSeconds, requestSpeed, tokensPerSecond, turnSuffix } from '../hooks/speed'
import { cells } from '../hooks/text'
import type { SpeedTally } from '../types'
import { flat, offline, spawnInput, turnInput } from './world'

// 每段回复末尾的速度和首字（本会话的平均已去掉，用户 2026-10-14 定）

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
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'ag1' }))
  offline(on)
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

// ---------------------------------------------------------------- 速度

const one = (output: number, generationMs: number, firstTokenMs: number, isLowerBound = false): SpeedTally => ({ requests: 1, output, generationMs, firstTokenMs, isLowerBound })

const TWO = addTally(one(400, 8000, 2000), one(280, 2000, 1000))

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

test('合计：token/s 按 token 加权（总输出 ÷ 总生成用时），不是各次速度的平均；首字相加；量得出的请求才算进 token/s，都是下限时才标作下限', () => {
  // 400 token / 8 秒（50/s）和 280 token / 2 秒（140/s）：680 ÷ 10 秒 = 68，不是 95
  expect(tokensPerSecond(TWO)).toBe(68)
  expect([TWO.requests, TWO.firstTokenMs, TWO.isLowerBound]).toEqual([2, 3000, false])
  // 一次整段一起到的请求：token/s 不受它影响、不标下限；先来的是下限也一样
  const mixed = addTally(TWO, one(99, 1842, 1792, true))
  expect([tokensPerSecond(mixed), mixed.isLowerBound]).toEqual([68, false])
  expect(addTally(addTally(EMPTY_TALLY, one(99, 1842, 1792, true)), one(400, 8000, 2000))).toEqual({ requests: 2, output: 400, generationMs: 8000, firstTokenMs: 3792, isLowerBound: false })
  // 都是下限：按下限合计
  expect(addTally(one(99, 1842, 1792, true), one(100, 1000, 900, true))).toEqual({ requests: 2, output: 199, generationMs: 2842, firstTokenMs: 2692, isLowerBound: true })
  expect(tokensPerSecond(EMPTY_TALLY)).toBe(null)
})

test('原生收尾那行的时长写法：不到 1 分钟往下取整秒，往上 1m 4s、1h 2m 3s、1d 1h 1m', () => {
  expect([0, 4999, 59_999, 60_000, 64_000, 64_600, 3_723_000, 90_061_000].map(engineDuration)).toEqual(['0s', '4s', '59s', '1m 0s', '1m 4s', '1m 5s', '1h 2m 3s', '1d 1h 1m'])
})

test('每段末尾：原生那行画出的字和接在后面的读数；有子 agent 在跑时原生那行写成在等它', () => {
  const doneAt = new Date(2026, 9, 14, 15, 43, 20).getTime()
  const turn = { tally: TWO, firstTokenMs: 2000, doneAt, waitingAgents: 0 }
  expect(engineTurnText({ word: 'Baked', durationMs: 64_000 }, turn)).toBe('Baked for 1m 4s · done 15:43')
  expect(engineTurnText({ word: 'Baked', durationMs: 64_000 }, { ...turn, waitingAgents: 1 })).toBe('Waiting for 1 background agent to finish')
  expect(engineTurnText({ word: 'Baked', durationMs: 64_000 }, { ...turn, waitingAgents: 2 })).toBe('Waiting for 2 background agents to finish')
  // 首字取这一段第一次请求的，不是平均
  expect(turnSuffix(turn)).toBe(' · 68 token/s · TTFT 2.0s')
  expect(turnSuffix({ ...turn, tally: one(99, 1842, 1792, true), firstTokenMs: 1792 })).toBe(' · ≥54 token/s · TTFT 1.8s')
})

test('秒数：不到 60 秒一位小数，60 秒起按 1m35s', () => {
  expect([0, 1500, 12_740, 59_940, 60_000, 95_400, 3_725_000].map(formatSeconds)).toEqual(['0.0s', '1.5s', '12.7s', '59.9s', '1m00s', '1m35s', '1h02m'])
})

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
  expect(await turnRow($, 'u1')).toContain(' · 68 token/s · TTFT 2.0s')
  expect(await turnRow($, 'u2')).toContain(' · ≥54 token/s · TTFT 1.8s')
  // 读数压在原生那行的最后一行上，从原生的字（图标占 2 格）之后起
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'TurnDuration', requestId: 'u1', props: { word: 'Baked', durationMs: 12_000 } })
  const overlay = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')
  // done 后面是收尾时刻 HH:MM
  expect(overlay?.props).toMatchObject({ bottom: 0, left: 2 + cells('Baked for 12s · done 00:00') })
  await ui.unmount()
  // 没有读数的收尾那行（恢复前的）照原样
  expect(await turnRow($, 'u0')).not.toContain('token/s')
})

test('换了对话（/clear）：之前的收尾行不再接读数，之后的照常', async ($, on) => {
  const timing = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }
  const { clock } = engine(on, timing)
  engineTurnRow(on)
  on('classic.SessionStart', () => ({}))
  await $.session.start(SESSION)
  await turn($, clock, timing, 't1', 'u1', [{ firstMs: 2000, streamMs: 8000, output: 400 }])
  await $.classic.SessionStart({ source: 'clear' })
  expect(await turnRow($, 'u1')).not.toContain('token/s')
  await turn($, clock, timing, 't2', 'u2', [{ firstMs: 1000, streamMs: 4000, output: 400 }])
  expect(await turnRow($, 'u2')).toContain(' · 100 token/s · TTFT 1.0s')
})

test('收尾时还有子 agent 在跑：原生那行写成在等它，读数接在那句后面；子 agent 结束后照常', async ($, on) => {
  const timing = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }
  const { clock } = engine(on, timing)
  engineTurnRow(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('查一下'))
  await turn($, clock, timing, 't1', 'u1', [{ firstMs: 2000, streamMs: 8000, output: 400 }])
  const left = async (uuid: string) => {
    const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'TurnDuration', requestId: uuid, props: { word: 'Baked', durationMs: 12_000 } })
    const overlay = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')
    await ui.unmount()
    return overlay?.props.left
  }
  expect(await left('u1')).toBe(2 + cells('Waiting for 1 background agent to finish'))
  await $.turn.complete(turnInput({ agentId: 'ag1' }))
  await turn($, clock, timing, 't2', 'u2', [{ firstMs: 2000, streamMs: 8000, output: 400 }])
  expect(await left('u2')).toBe(2 + cells('Baked for 12s · done 00:00'))
})
