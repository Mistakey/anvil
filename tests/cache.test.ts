import { describe, expect, mock, test } from 'claude-code/testing'
import type { CacheView } from '../types'

import { formatDuration, formatTokens } from '../hooks/cache'
import { SESSION, drain, stepInput, turnInput, typed, usage, world } from './world'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const START = 10 * HOUR

// usage() 的默认读数：上下文输入侧 2 + 150000 + 500，输出 1000，Opus 5.5 的 1 小时写入价 $10/MTok
const CONTEXT = 150502
const REBUILD = CONTEXT + 1000

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

/** 金额比到百万分之一美元，避开浮点误差 */
const micro = (usd: number | null) => usd === null ? null : Math.round(usd * 1e6) / 1e6

const cacheOf = (state: Map<string, unknown>) => state.get('anvil.cache') as CacheView

describe('过期时刻', () => {
  test('= 最后一次主会话请求 + 1 小时；子 agent 的请求和轮次不改变它', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    expect(cacheOf(state).expiresAt).toBe(null)

    await drain($.turn.step(stepInput()))
    expect(cacheOf(state).expiresAt).toBe(START + HOUR)
    await clock.advance(20 * MIN)
    await drain($.turn.step(stepInput({ index: 1 })))
    await $.turn.complete(turnInput())
    expect(cacheOf(state).expiresAt).toBe(START + 20 * MIN + HOUR)

    await clock.advance(30 * MIN)
    await drain($.turn.step(stepInput({ agentId: 'worker' })))
    await $.turn.complete(turnInput({ agentId: 'worker', durationMs: 100 }))
    expect(cacheOf(state).expiresAt).toBe(START + 20 * MIN + HOUR)
  })

  test('一轮里没有记到请求时，以轮末为下限', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await clock.advance(5 * MIN)
    await $.turn.complete(turnInput({ durationMs: 1000 }))
    expect(cacheOf(state).expiresAt).toBe(START + 5 * MIN + HOUR)
  })

  test('恢复会话按 seconds_since_last_response 起步，没过期就照常', async ($, on) => {
    mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000, prompt_cache_likely_expired: false })
    expect(cacheOf(state).expiresAt).toBe(START + 30 * MIN)
    expect(cacheOf(state).context).toBe(200000)
    expect(cacheOf(state).rebuild.tokens).toBe(200000)
  })

  test('恢复会话时引擎判定很可能已过期：过期时刻最晚取现在', async ($, on) => {
    mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(cacheOf(state).expiresAt).toBe(START)

    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(cacheOf(state).expiresAt).toBe(START - HOUR)
  })

  test('压缩后到下一次响应前不判过期，/clear 后清零', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await $.turn.complete(turnInput())
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    expect(cacheOf(state)).toMatchObject({ compacted: true, context: 0 })

    await clock.advance(2 * HOUR)
    await drain($.turn.step(stepInput()))
    expect(cacheOf(state)).toMatchObject({ compacted: false, context: CONTEXT, expiresAt: START + 3 * HOUR })

    await $.turn.complete(turnInput({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150500 }) }))
    await $.classic.SessionStart({ source: 'clear' })
    expect(cacheOf(state)).toEqual({
      expiresAt: null,
      compacted: false,
      context: 0,
      rebuild: { tokens: 0, usd: 0 },
      hitRate: { last: null, session: null },
      coldWrites: { count: 0, usd: 0 },
    })
  })

  test('子 agent 的压缩和预先计算的压缩不算', async ($, on) => {
    mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: SUMMARY })
    await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
    expect(cacheOf(state)).toMatchObject({ compacted: false, context: CONTEXT })
  })
})

describe('重建量、命中率、冷写', () => {
  test('重建量 = 上下文输入侧 + 上一条回复的输出，金额按 1 小时写入价', async ($, on) => {
    mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    const { rebuild } = cacheOf(state)
    expect(rebuild.tokens).toBe(REBUILD)
    expect(micro(rebuild.usd)).toBe(micro(REBUILD * 10 / 1e6))
  })

  test('只取最后一次请求的读数，不取一轮的合计', async ($, on) => {
    mock.clock(on, { now: START })
    const reply = { usage: usage() }
    const { state } = world(on, { reply })
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    reply.usage = usage({ cache_read_input_tokens: 160000, output_tokens: 300 })
    await drain($.turn.step(stepInput({ index: 1 })))
    await $.turn.complete(turnInput({ usage: usage({ cache_read_input_tokens: 310000, output_tokens: 1300 }) }))
    expect(cacheOf(state).context).toBe(160502)
    expect(cacheOf(state).rebuild.tokens).toBe(160802)
  })

  test('引擎没有逐次读数时，上下文退到实时上下文', async ($, on) => {
    mock.clock(on, { now: START })
    const { state } = world(on, { live: { tokens: 90000 } })
    await $.session.start(SESSION)
    expect(cacheOf(state).context).toBe(90000)
    await $.turn.complete(turnInput())
    expect(cacheOf(state).context).toBe(90000)
  })

  test('命中率分上一条消息和本会话，只算主会话', async ($, on) => {
    mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(turnInput({ usage: usage({ input_tokens: 0, cache_read_input_tokens: 90000, cache_creation_input_tokens: 10000 }) }))
    expect(cacheOf(state).hitRate).toEqual({ last: 0.9, session: 0.9 })

    await $.turn.complete(turnInput({ usage: usage({ input_tokens: 0, cache_read_input_tokens: 50000, cache_creation_input_tokens: 50000 }) }))
    expect(cacheOf(state).hitRate).toEqual({ last: 0.5, session: 0.7 })

    await $.turn.complete(turnInput({ agentId: 'worker', usage: usage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100000 }) }))
    expect(cacheOf(state).hitRate).toEqual({ last: 0.5, session: 0.7 })
  })

  test('整段重建记一次冷写，金额按牌价；少量写入不记', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const { state } = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await $.turn.complete(turnInput())
    expect(cacheOf(state).coldWrites).toEqual({ count: 0, usd: 0 })

    await clock.advance(2 * HOUR)
    await drain($.turn.step(stepInput()))
    await $.turn.complete(turnInput({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(cacheOf(state).coldWrites.count).toBe(1)
    expect(micro(cacheOf(state).coldWrites.usd)).toBe(micro(1.5))

    await $.turn.complete(turnInput({ usage: usage({ cache_creation_input_tokens: 5000 }) }))
    await $.turn.complete(turnInput({ usage: usage({ model: 'claude-sonnet-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(cacheOf(state).coldWrites.count).toBe(2)
    expect(micro(cacheOf(state).coldWrites.usd)).toBe(micro(1.5 + 0.6))
  })

  test('格式：时长 47s / 2m41s / 1h10m，token 取 k', () => {
    expect(formatDuration(47 * SEC)).toBe('47s')
    expect(formatDuration(2 * MIN + 41 * SEC)).toBe('2m41s')
    expect(formatDuration(HOUR + 10 * MIN + 59 * SEC)).toBe('1h10m')
    expect(formatDuration(26 * HOUR + 5 * MIN)).toBe('26h05m')
    expect(formatTokens(151502)).toBe('152k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(formatTokens(800)).toBe('800')
  })
})

const DROP = 'anvil：缓存已过期 1h10m，发送这条消息要重建 152k tokens（约 $1.52）。消息已放回主输入框，再按 Enter 即发送；不需要这段上下文时，可用 /clear 开始新会话。'

describe('冷发送守卫', () => {
  test('过期且达到阈值时拦一次，原文放回主输入框，再提交就放行', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await $.turn.complete(turnInput())
    await clock.advance(2 * HOUR + 10 * MIN)

    const first = await $.prompt.submit(typed('继续上次的重构'))
    expect(first.drop).toBe(DROP)
    expect(w.entered).toEqual([])
    await clock.settle()
    expect(w.fills).toEqual(['继续上次的重构'])
    expect(w.box.text).toBe('继续上次的重构')

    const second = await $.prompt.submit(typed('继续上次的重构'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['继续上次的重构'])
  })

  test('引擎把原文留在主输入框时不再放回', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { box: { text: '继续' } })
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(typed('继续'))).drop).toMatch(/^anvil：缓存已过期 1h00m/)
    await clock.settle()
    expect(w.fills).toEqual([])
  })

  test('放行的那条发出后，下一段过期照常再拦', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(typed('a'))).drop).toBeDefined()
    expect((await $.prompt.submit(typed('a'))).drop).toBe(undefined)
    await drain($.turn.step(stepInput()))
    await $.turn.complete(turnInput())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(typed('b'))).drop).toBeDefined()
    expect(w.entered).toEqual(['a'])
  })

  test('恢复一个缓存很可能已过期的会话，第一条消息被拦', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', model: 'claude-opus-5-5', seconds_since_last_response: 3 * 3600, context_tokens: 152000, prompt_cache_likely_expired: true })
    const first = await $.prompt.submit(typed('hi'))
    expect(first.drop).toBe('anvil：缓存已过期 2h00m，发送这条消息要重建 152k tokens（约 $1.52）。消息已放回主输入框，再按 Enter 即发送；不需要这段上下文时，可用 /clear 开始新会话。')
    expect(w.entered).toEqual([])
  })

  test('斜杠命令、shell 命令、插件和其他来源的提交、未过期、低于阈值都不拦', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const reply = { usage: usage() }
    const w = world(on, { reply })
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await clock.advance(30 * MIN)
    await $.prompt.submit(typed('未过期'))

    await clock.advance(2 * HOUR)
    await $.prompt.submit(typed('  /compact'))
    await $.prompt.submit(typed('!git status'))
    await $.prompt.submit({ text: '插件发的', wait: false, origin: { kind: 'plugin', name: 'other' } })
    await $.prompt.submit({ text: '定时任务', wait: false, origin: { kind: 'scheduled-trigger' } })
    await $.prompt.submit({ text: '通知', wait: false, origin: { kind: 'task-notification' } })
    expect(w.entered).toEqual(['未过期', '  /compact', '!git status', '插件发的', '定时任务', '通知'])

    // 小上下文的会话
    reply.usage = usage({ cache_read_input_tokens: 40000 })
    await drain($.turn.step(stepInput()))
    await $.turn.complete(turnInput({ usage: reply.usage }))
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(typed('小的'))).drop).toBe(undefined)
  })

  test('压缩后、/clear 后不拦', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await clock.advance(2 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await $.prompt.submit(typed('压缩后'))

    await drain($.turn.step(stepInput()))
    await clock.advance(2 * HOUR)
    await $.classic.SessionStart({ source: 'clear' })
    await $.prompt.submit(typed('clear 后'))
    expect(w.entered).toEqual(['压缩后', 'clear 后'])
  })

  test('/config 关掉守卫时不拦', { options: { guard: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await clock.advance(2 * HOUR)
    await $.prompt.submit(typed('hi'))
    expect(w.entered).toEqual(['hi'])
  })

  test('/config 改的阈值传到守卫', { options: { threshold: 200000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(SESSION)
    await drain($.turn.step(stepInput()))
    await clock.advance(2 * HOUR)
    await $.prompt.submit(typed('hi'))
    expect(w.entered).toEqual(['hi'])
  })
})
