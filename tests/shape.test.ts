import type { On, SessionAppendInput, TurnStepChunk } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { conform, conformState, listOf, maybe, recordOf } from '../hooks/shape'
import { EMPTY_TALLY } from '../hooks/speed'
import { flat, offline, spawnInput, turnInput, typed } from './world'

// 热重载不清 `$.state`（AGENTS.md Pitfalls）：上一次加载按旧形状写下的值、缺字段的值，读的时候合并到默认值上，钩子不抛错

// ---------------------------------------------------------------- 合并的规则

describe('合并到默认值上', () => {
  test('对象：缺的字段补默认，类型不对的换成默认，多出来的字段留着', () => {
    expect(conform({ a: 1, b: 'x', c: false }, { a: 2, b: 3, d: 'old' })).toEqual({ a: 2, b: 'x', c: false, d: 'old' })
    expect(conform({ a: 1, inner: { b: 0 } }, { a: 5 })).toEqual({ a: 5, inner: { b: 0 } })
    expect(conform({ a: 1 }, 'old')).toEqual({ a: 1 })
    expect(conform({ a: 1 }, [1])).toEqual({ a: 1 })
  })

  test('默认值是 null 的字段：什么都收，读不到时为 null', () => {
    expect(conform({ a: null }, { a: 'x' })).toEqual({ a: 'x' })
    expect(conform({ a: null }, {})).toEqual({ a: null })
  })

  test('maybe：null 或按里面的形状合并；不是对象就是 null', () => {
    const shape = { v: maybe({ x: 0, y: 0 }) }
    expect(conform(shape, { v: { x: 3 } })).toEqual({ v: { x: 3, y: 0 } })
    expect(conform(shape, { v: null })).toEqual({ v: null })
    expect(conform(shape, { v: 7 })).toEqual({ v: null })
    expect(conform(shape, {})).toEqual({ v: null })
  })

  test('listOf：不是数组就是空的；每项按形状合并，类型不对的项丢掉', () => {
    const shape = listOf({ id: '', n: 0 })
    expect(conform(shape, [{ id: 'a' }, 'junk', null, { id: 'b', n: 2 }])).toEqual([{ id: 'a', n: 0 }, { id: 'b', n: 2 }])
    expect(conform(shape, { id: 'a' })).toEqual([])
    expect(conform(listOf(''), ['a', 3, 'b'])).toEqual(['a', 'b'])
  })

  test('recordOf：每个值按形状合并，不是对象的值丢掉', () => {
    const shape = recordOf({ n: 0, m: 1 })
    expect(conform(shape, { a: { n: 2 }, b: 'junk' })).toEqual({ a: { n: 2, m: 1 } })
    expect(conform(shape, null)).toEqual({})
  })

  test('没有专门形状的 atom 按它的初始值合并', () => {
    expect(conformState('keepaliveOverride', null, true)).toBe(true)
    expect(conformState('cache', { expiresAt: null, context: 0 }, { context: 5 })).toEqual({ expiresAt: null, context: 5 })
  })

  test('目录与 git：旧形状缺的字段补上；git 不是对象就当不在 git 里', () => {
    expect(conformState('place', { dir: '', git: null }, { dir: 'anvil', git: { repo: 'anvil', branch: 'main' } })).toMatchObject({
      dir: 'anvil',
      git: { repo: 'anvil', branch: 'main', ahead: 0, lines: null, operation: null },
    })
    expect(conformState('place', { dir: '', git: null }, { git: 'x' })).toEqual({ dir: '', git: null })
  })

  test('每段的读数：缺的合计、收尾行缺字段都补上', () => {
    const read = conformState('turnSpeeds', { current: null, lines: {} }, { current: { turnId: 't1' }, lines: { u1: { firstTokenMs: 900 } } }) as {
      current: { tally: unknown }
      lines: Record<string, { tally: unknown; waitingAgents: number }>
    }
    expect(read.current.tally).toEqual(EMPTY_TALLY)
    expect(read.lines.u1).toEqual({ tally: EMPTY_TALLY, firstTokenMs: 900, doneAt: 0, waitingAgents: 0 })
  })
})

// ---------------------------------------------------------------- 插件里：读到旧形状，钩子照常

type Engine = Parameters<TestBody>[0]

const SESSION = { cwd: 'C:\\w\\anvil', surface: null, isInteractive: true }

/**
 * 插件之下的世界：每次请求等 2 秒来第一块、8 秒流完 400 token。
 * `rewrite` 里的键（`plugin.key`）插件每次写下都换成给的值：插件读到的一直是上一次加载留下的旧形状，直到测试清掉它
 */
function engine(on: On, rewrite: Map<string, unknown>) {
  const clock = mock.clock(on, { now: 10 * 3_600_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('classic.SessionStart', () => ({}))
  offline(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'ag1' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    await clock.sleep(2000)
    const thinking: TurnStepChunk = { kind: 'thinking', index: 0, text: '' }
    yield thinking
    await clock.sleep(8000)
    const usage = { input_tokens: 2, output_tokens: 400, cache_read_input_tokens: 150000, cache_creation_input_tokens: 500, model: 'claude-opus-5-5' }
    const stop: TurnStepChunk = { kind: 'stop', stopReason: 'end_turn', usage }
    yield stop
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('state.set', ($, e, next) => {
    const name = `${e.plugin}.${e.key}`
    return next(rewrite.has(name) ? { ...e, value: rewrite.get(name) as never } : e)
  })
  // 原生收尾那行的替身：测试里引擎不画 TurnDuration
  on('ui.render', { component: 'TurnDuration' }, () => ({ type: 'Text', children: ['✻ Baked for 12s'] }) as never)
  return clock
}

type Clock = { advance: (ms: number) => Promise<void> }

const turnDuration = (uuid: string): SessionAppendInput =>
  ({ message: { type: 'system', name: 'turn_duration', content: [] }, door: 'notice', origin: { kind: 'engine' }, uuid }) as unknown as SessionAppendInput

/** 一段回复：一次请求，收尾那行记进对话，这一轮结束 */
async function turn($: Engine, clock: Clock, turnId: string, uuid: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  const drained = (async () => {
    for await (const chunk of stream) void chunk
  })()
  await clock.advance(60_000)
  await drained
  await $.session.append(turnDuration(uuid))
  await $.turn.complete(turnInput({ turnId }))
  await clock.advance(1000)
}

async function turnRow($: Engine, uuid: string) {
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'TurnDuration', requestId: uuid, props: { word: 'Baked', durationMs: 12_000 } })
  const shown = flat(await ui.drawn())
  await ui.unmount()
  return shown
}

async function band($: Engine) {
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'AbovePrompt', props })
  const shown = flat(await ui.drawn())
  await ui.unmount()
  return shown
}

/** 各 atom 上一次加载可能留下的旧形状、缺字段的值 */
const STALE: Record<string, unknown> = {
  place: { dir: 'anvil', git: { repo: 'anvil', branch: 'main' } },
  turnSpeeds: { current: { turnId: 'old' }, lines: { u0: { firstTokenMs: 900 } } },
  usage: { context: { tokens: 1000 }, costUsd: 1 },
  cache: { expiresAt: 0 },
  keepalive: { stopped: { reason: '旧的' } },
  runningAgents: 'ag1',
}

for (const [key, stale] of Object.entries(STALE)) {
  test(`anvil.${key} 是旧形状：输入框上方那一行、收尾行照常画，换回新代码写下的值后读数正常`, async ($, on) => {
    const rewrite = new Map<string, unknown>([[`anvil.${key}`, stale]])
    const clock = engine(on, rewrite)
    await $.session.start(SESSION)
    await $.agent.spawn(spawnInput('查一下'))
    await $.prompt.submit(typed('你好'))
    await turn($, clock, 't1', 'u1')
    await turnRow($, 'u1')
    expect(await band($)).toContain('5h')

    // 之后的写入不再被换掉（像新代码第一次写下自己的形状）
    rewrite.clear()
    await turn($, clock, 't2', 'u2')
    expect(await turnRow($, 'u2')).toContain('token/s')
    expect(await band($)).toContain('7d')
  })
}
