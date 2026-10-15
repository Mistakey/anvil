import type { ModelForkResult, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { freshCache, view } from '../hooks/cache'
import type { Cache } from '../hooks/cache'
import { IDLE_LIMIT_MS, PING_AFTER_MS, keepaliveStatus, statuslineFile } from '../hooks/keepalive'
import type { LoopMemory } from '../hooks/keepalive'
import { COLOR } from '../hooks/style'
import type { CacheView, Settings, StatuslineFile } from '../types'
import { SESSION, SESSION_ID, WARM, anvil, drain, stepInput, turnInput, typed, usage, world } from './world'
import type { WorldOptions } from './world'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

// 本地时间 2026-10-13 20:00；缓存框的时刻按本地时区格式化
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const START = at(13, 20)

const cacheOf = (state: Map<string, unknown>) => state.get('anvil.cache') as CacheView

function engine(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: START })
  const w = world(on, options)
  return { clock, ...w }
}

/** 主会话一轮：一次请求加一轮结束 */
async function turn($: Engine, over = {}) {
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput(over))
}


/** `/anvil` 列表里保活的状态 */
async function keepaliveRow($: Engine) {
  const listed = (await $.command.run(anvil(''))).text ?? ''
  return { text: /\/anvil keepalive .*\(now: (.*)\)$/m.exec(listed)?.[1] ?? '' }
}

describe('自动开启', () => {
  test('上下文达到阈值：空闲 50 分钟发一次 fork，读数达标就顺延过期时刻，再过 50 分钟再发', async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM] })
    await $.session.start(SESSION)
    await turn($)
    expect(cacheOf(w.state).expiresAt).toBe(START + HOUR)

    await w.clock.advance(49 * MIN)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(1 * MIN)
    expect(w.forks).toEqual(['Reply with the single word: warm'])
    expect(cacheOf(w.state).expiresAt).toBe(START + 50 * MIN + HOUR)

    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)
    expect(cacheOf(w.state).expiresAt).toBe(START + 100 * MIN + HOUR)
  })

  test('低于阈值不开', async ($, on) => {
    const small = usage({ cache_read_input_tokens: 40000 })
    const w = engine(on, { forks: [WARM], reply: { usage: small } })
    await $.session.start(SESSION)
    await turn($, { usage: small })
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect(await keepaliveRow($)).toEqual({ text: 'not on (context below 50k)' })
  })

  test('/config 关掉自动开启后不开', { options: { autoKeepalive: false } }, async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect((await keepaliveRow($)).text).toBe('not on (auto-enable is off)')
  })

  test('/config 改的阈值传到保活', { options: { threshold: 200000 } }, async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect((await keepaliveRow($)).text).toBe('not on (context below 200k)')
  })

  test('新的一轮重新计时；子 agent 的轮次不动计时', async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(40 * MIN)
    await turn($)
    await w.clock.advance(40 * MIN)
    expect(w.forks).toHaveLength(0)
    await drain($.turn.step(stepInput({ agentId: 'worker' })))
    await $.turn.complete(turnInput({ agentId: 'worker' }))
    await w.clock.advance(10 * MIN)
    expect(w.forks).toHaveLength(1)
  })

  test('缓存已经过期（恢复会话）时不发，等下一次主会话请求之后再开始', async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 3 * 3600, context_tokens: 152000, prompt_cache_likely_expired: true })
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    await turn($)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(1)
  })

  test('压缩后到下一次响应前不发，/clear 后不发', async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)

    await turn($)
    await $.classic.SessionStart({ source: 'clear' })
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
  })
})

describe('/anvil keepalive', () => {
  test('默认开着的会话里切换一次就关掉，本会话不再发请求；再切换一次重新开启', async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(10 * MIN)

    const off = await $.command.run(anvil('keepalive'))
    expect(off.text).toBe('Cache keepalive off (this session)')
    expect(await keepaliveRow($)).toEqual({ text: 'off (this session)' })
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(0)
    // 关着的时候，新的一轮也不开
    await turn($)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(0)

    const back = await $.command.run(anvil(' keepalive '))
    expect(back.text).toBe('Cache keepalive on (this session)')
    expect(await keepaliveRow($)).toEqual({ text: 'on (this session)' })
    // 这段空闲已过 50 分钟、缓存还有效：马上补一次
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(await keepaliveRow($)).toEqual({ text: 'renewing (this session)' })
  })

  test('/config 关掉自动开启时，切换一次就在本会话开启，按时发 fork', { options: { autoKeepalive: false } }, async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM] })
    await $.session.start(SESSION)
    await turn($)
    expect((await keepaliveRow($)).text).toBe('not on (auto-enable is off)')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('Cache keepalive on (this session)')
    await w.clock.advance(49 * MIN)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(1 * MIN)
    expect(w.forks).toHaveLength(1)
    expect(cacheOf(w.state).expiresAt).toBe(START + 50 * MIN + HOUR)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)

    expect((await $.command.run(anvil('keepalive'))).text).toBe('Cache keepalive off (this session)')
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(2)
  })

  test('上下文低于阈值时也能手动开启', async ($, on) => {
    const small = usage({ cache_read_input_tokens: 40000 })
    const w = engine(on, { forks: [WARM], reply: { usage: small } })
    await $.session.start(SESSION)
    await turn($, { usage: small })
    expect((await keepaliveRow($)).text).toBe('not on (context below 50k)')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('Cache keepalive on (this session)')
    expect(await keepaliveRow($)).toEqual({ text: 'on (this session)' })
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(1)
  })

  test('保活已停下时，切换一次就在本会话重新开始，而不是关掉；再切换一次才关掉', async ($, on) => {
    const w = engine(on, { forks: [{ read: 0, write: 150000 }, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(50 * MIN)
    expect((await keepaliveRow($)).text).toBe('stopped (cache had expired by renewal)')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('Cache keepalive on (this session)')
    expect(await keepaliveRow($)).toEqual({ text: 'on (this session)' })
    // 缓存还有效、已过发请求的时刻：马上补一次
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(2)
    expect((await keepaliveRow($)).text).toBe('renewing (this session)')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('Cache keepalive off (this session)')
  })

  test('本会话的开关只记在 $.state 里：新会话（引擎重置 $.state）回到默认', async ($, on) => {
    const w = engine(on)
    await $.session.start(SESSION)
    expect(w.state.get('anvil.keepaliveOverride')).toBe(undefined)
    await $.command.run(anvil('keepalive'))
    expect(w.state.get('anvil.keepaliveOverride')).toBe(true)
    await $.command.run(anvil('keepalive'))
    expect(w.state.get('anvil.keepaliveOverride')).toBe(false)
  })

  test('/anvil 列出 keepalive 子命令和现在的保活状态；旧写法 off|on 按未知子命令处理', async ($, on) => {
    engine(on)
    await $.session.start(SESSION)
    await turn($)
    const list = (await $.command.run(anvil(''))).text ?? ''
    expect(list).toMatch(/^ {2}\/anvil keepalive +Turn prompt-cache keepalive on or off \(now: on\)$/m)
    expect((await $.command.run(anvil('keepalive off'))).text).toStartWith('Unknown subcommand: keepalive off')
    expect((await $.command.run(anvil('keepalive on'))).text).toStartWith('Unknown subcommand: keepalive on')
  })
})

describe('停下', () => {
  test('一段空闲续满 12 小时停下，原因为灰；之后不再发', async ($, on) => {
    const w = engine(on, { forks: Array.from({ length: 20 }, () => WARM) })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(IDLE_LIMIT_MS - 1 * SEC)
    // 50 分钟一次，12 小时内 14 次（最后一次在 11h40m）
    expect(w.forks).toHaveLength(Math.floor(IDLE_LIMIT_MS / PING_AFTER_MS))
    expect((await keepaliveRow($)).text).toBe('renewing')

    await w.clock.advance(1 * SEC)
    expect(await keepaliveRow($)).toEqual({ text: 'stopped (idle for over 12 hours)' })
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(14)
  })

  test('续满 12 小时停下后手动重新开启：照常续期，新的 12 小时从开启时算起', async ($, on) => {
    const w = engine(on, { forks: Array.from({ length: 40 }, () => WARM) })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(IDLE_LIMIT_MS)
    expect((await keepaliveRow($)).text).toBe('stopped (idle for over 12 hours)')
    // 最后一次续期在 11h40m，缓存到 12h40m 过期；过期前 10 分钟敲一次
    await w.clock.advance(10 * MIN)
    expect((await $.command.run(anvil('keepalive'))).text).toBe('Cache keepalive on (this session)')
    expect(await keepaliveRow($)).toEqual({ text: 'renewing (this session)' })

    // 上一次续期之后 50 分钟（12h30m）照常发、续期
    await w.clock.advance(20 * MIN)
    expect(w.forks).toHaveLength(15)
    expect(cacheOf(w.state).expiresAt).toBe(START + 12 * HOUR + 30 * MIN + HOUR)

    // 新的上限在开启后 12 小时（24h10m）：之前每 50 分钟一次，最后一次在 23h20m
    await w.clock.advance(IDLE_LIMIT_MS - 20 * MIN - 1 * SEC)
    expect(w.forks).toHaveLength(28)
    expect((await keepaliveRow($)).text).toBe('renewing (this session)')
    await w.clock.advance(1 * SEC)
    expect(await keepaliveRow($)).toEqual({ text: 'stopped (idle for over 12 hours)' })
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(28)
  })

  for (const [name, answer] of [
    ['没读到主会话缓存', { read: 0, write: 150000 }],
    ['写入过多', { read: 75000, write: 70000 }],
    ['什么都没读', { read: 0, write: 0 }],
  ] as const) {
    test(`读数不达标（${name}）停下，原因为红`, async ($, on) => {
      const w = engine(on, { forks: [answer, WARM] })
      await $.session.start(SESSION)
      await turn($)
      await w.clock.advance(50 * MIN)
      expect(w.forks).toHaveLength(1)
      expect(cacheOf(w.state).expiresAt).toBe(START + HOUR)
      expect(await keepaliveRow($)).toEqual({ text: 'stopped (cache had expired by renewal)' })
      await w.clock.advance(3 * HOUR)
      expect(w.forks).toHaveLength(1)
    })
  }

  for (const [answer, reason] of [
    [{ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }, 'renewal failed: HTTP 429'],
    [{ isAnswered: false, reason: 'empty-reply', usage: usage() }, 'renewal got no reply'],
    [{ isAnswered: false, reason: 'aborted', usage: usage() }, 'renewal was aborted'],
    [{ isAnswered: false, reason: 'nothing-to-fork' }, 'no conversation to renew yet'],
  ] satisfies [ModelForkResult, string][]) {
    test(`请求出错停下，原因为红：${reason}`, async ($, on) => {
      const w = engine(on, { forks: [answer, WARM] })
      await $.session.start(SESSION)
      await turn($)
      await w.clock.advance(50 * MIN)
      expect(await keepaliveRow($)).toEqual({ text: `stopped (${reason})` })
      await w.clock.advance(3 * HOUR)
      expect(w.forks).toHaveLength(1)
    })
  }

  test('fork 抛错也算出错停下', async ($, on) => {
    // 测试的 fork 钩子抛错时，引擎跳过它、向插件报"没有实现"：只能核对原因的前缀
    const w = engine(on, { forks: [{ throw: 'socket hang up' }, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(50 * MIN)
    const row = await keepaliveRow($)
    expect(row.text).toStartWith('stopped (renewal failed: ')
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(1)
  })

  test('停下只结束这一段空闲：下一次主会话请求之后重新开始', async ($, on) => {
    const w = engine(on, { forks: [{ read: 0, write: 150000 }, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(50 * MIN)
    expect((await keepaliveRow($)).text).toBe('stopped (cache had expired by renewal)')

    await w.clock.advance(1 * HOUR)
    await drain($.turn.step(stepInput()))
    expect((await keepaliveRow($)).text).toBe('on')
    await $.turn.complete(turnInput())
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)
    expect((await keepaliveRow($)).text).toBe('renewing')
  })
})

describe('恢复会话', () => {
  for (const source of ['resume', 'fork'] as const) {
    test(`会话内 ${source} 到别的会话：不沿用上一个会话的停下和本会话计数，按新会话起步`, async ($, on) => {
      const w = engine(on, { forks: [{ read: 0, write: 150000 }, WARM] })
      await $.session.start(SESSION)
      await turn($)
      await turn($, { usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150500 }) })
      await w.clock.advance(50 * MIN)
      expect((await keepaliveRow($)).text).toBe('stopped (cache had expired by renewal)')
      expect(cacheOf(w.state).coldWrites.count).toBe(1)

      // 会话 B：10 分钟前还有响应，缓存没过期
      await $.classic.SessionStart({ source, seconds_since_last_response: 600, context_tokens: 200000, prompt_cache_likely_expired: false })
      expect(await keepaliveRow($)).toEqual({ text: 'on' })
      const b = cacheOf(w.state)
      expect(b.hitRate).toEqual({ last: null, session: null })
      expect(b.coldWrites).toEqual({ count: 0, usd: 0 })
      // 计价用的模型（Opus 5.5，1 小时写入 $10/MTok）保留
      expect(b.rebuild).toEqual({ tokens: 200000, usd: 2 })

      // B 的最后一次响应之后满 50 分钟发 fork
      await w.clock.advance(40 * MIN - 2 * SEC)
      expect(w.forks).toHaveLength(1)
      await w.clock.advance(2 * SEC)
      expect(w.forks).toHaveLength(2)
      expect((await keepaliveRow($)).text).toBe('renewing')
    })
  }
})

describe('退出再恢复：读回状态文件里的过期时刻（引擎的恢复字段不知道续期）', () => {
  const ME = { USERPROFILE: 'C:/Users/me' }
  const PATH = `C:/Users/me/.claude/anvil/sessions/${SESSION_ID}.json`

  test('退出前续过期：恢复时照文件里的过期时刻，不按引擎判的过期', async ($, on) => {
    const w = engine(on, { forks: [WARM], env: ME })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(1)
    const renewed = START + 50 * MIN + HOUR
    expect(JSON.parse(w.written.get(PATH) ?? 'null')).toMatchObject({ expiresAt: renewed })
    // 退出 20 分钟后恢复：离最后一次回复 70 分钟，引擎判定很可能已过期
    await w.clock.advance(20 * MIN)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 70 * 60, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(cacheOf(w.state).expiresAt).toBe(renewed)
  })

  test('新进程开局先把文件写掉：恢复时用开局前读到的那份', async ($, on) => {
    const w = engine(on, { env: ME })
    w.written.set(PATH, JSON.stringify({ renews: true, error: null, expiresAt: START + 30 * MIN, at: START - 30 * MIN }))
    await $.session.start(SESSION)
    expect(JSON.parse(w.written.get(PATH) ?? 'null')).toMatchObject({ expiresAt: null })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(cacheOf(w.state).expiresAt).toBe(START + 30 * MIN)
  })

  test('引擎判定已过期而离最后一次回复不到 1 小时（TTL 更短）：不照文件', async ($, on) => {
    const w = engine(on, { env: ME })
    w.written.set(PATH, JSON.stringify({ renews: true, error: null, expiresAt: START + 50 * MIN, at: START - 10 * MIN }))
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(cacheOf(w.state).expiresAt).toBe(START)
  })
})

describe('热重载', () => {
  // 热重载：模块内存（缓存状态、保活循环）是新的，`$.clock.after` 的定时器被引擎撤掉，`$.state` 还在。
  // 先让插件按冷启动加载一次、把它写下的读数换成"上一次加载留下的"（rewrite），再收一次 session.start
  /** 上一次加载留下的缓存状态：30 分钟前主会话发过一次请求，之后空闲 */
  const cacheMemory = (over: Partial<Cache> = {}): Cache => ({
    ...freshCache(),
    lastRequestAt: START - 30 * MIN,
    expiresAt: START + 30 * MIN,
    context: 150502,
    output: 1000,
    model: 'claude-opus-5-5',
    last: { read: 150000, input: 150502 },
    session: { read: 300000, input: 301004 },
    coldWrites: [{ at: START - 2 * HOUR, tokens: 150500, usd: 1.505 }],
    ...over,
  })
  const loopMemory = (over: Partial<LoopMemory> = {}): LoopMemory => ({ renewals: 0, stopped: null, restartedAt: 0, ...over })
  const previous = (cache: unknown, loop: unknown, more: Record<string, unknown> = {}) =>
    ({ 'anvil.cacheMemory': cache, 'anvil.keepaliveMemory': loop, ...more })

  async function reload($: Engine, w: { rewrite: Map<string, unknown> }) {
    w.rewrite.clear()
    await $.session.start(SESSION)
  }

  test('有过请求 → 热重载 → 空闲：照原来的过期时刻定时、续期，读数和重载前一样', async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM], rewrite: previous(cacheMemory(), loopMemory()) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(cacheOf(w.state)).toEqual(view(cacheMemory()))
    expect(await keepaliveRow($)).toEqual({ text: 'on' })

    // 上一次请求之后满 50 分钟（START + 20 分钟）发 fork，以这次请求顺延过期时刻
    await w.clock.advance(20 * MIN - 2 * SEC)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(2 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(cacheOf(w.state).expiresAt).toBe(START + 20 * MIN + HOUR)
    expect((await keepaliveRow($)).text).toBe('renewing')
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)
  })

  test('这段空闲里续期过：重载后仍是进行中，12 小时上限照最后一次主会话请求算', async ($, on) => {
    // 11h30m 前发过请求，续期过 13 次，最后一次在 40 分钟前
    const cache = cacheMemory({ lastRequestAt: START - IDLE_LIMIT_MS + 30 * MIN, expiresAt: START + 20 * MIN })
    const w = engine(on, { forks: Array.from({ length: 5 }, () => WARM), rewrite: previous(cache, loopMemory({ renewals: 13 })) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(await keepaliveRow($)).toEqual({ text: 'renewing' })

    await w.clock.advance(10 * MIN)
    expect(w.forks).toHaveLength(1)
    await w.clock.advance(20 * MIN)
    expect(await keepaliveRow($)).toEqual({ text: 'stopped (idle for over 12 hours)' })
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(1)
  })

  test('重载时保活已停下：保持停下和原因，不发；下一次主会话请求之后照常', async ($, on) => {
    const stopped = { kind: 'reading', reason: 'cache had expired by renewal' } as const
    const w = engine(on, { forks: [WARM], rewrite: previous(cacheMemory(), loopMemory({ stopped })) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(await keepaliveRow($)).toEqual({ text: 'stopped (cache had expired by renewal)' })
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(0)

    await turn($)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(1)
  })

  test('缓存在重载前已过期：不发，守卫照常拦', async ($, on) => {
    const cache = cacheMemory({ lastRequestAt: START - 2 * HOUR, expiresAt: START - HOUR })
    const w = engine(on, { forks: [WARM], rewrite: previous(cache, loopMemory()) })
    await $.session.start(SESSION)
    await reload($, w)
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect((await $.prompt.submit(typed('继续'))).drop ?? '').toStartWith('anvil: the cache expired')
  })

  test('重载前续期请求还在路上：那次请求随旧模块丢了，重载后补发一次', async ($, on) => {
    // 50 分钟前的请求，续期请求发出后重载
    const cache = cacheMemory({ lastRequestAt: START - 50 * MIN, expiresAt: START + 10 * MIN })
    const w = engine(on, { forks: [WARM], rewrite: previous(cache, loopMemory()) })
    await $.session.start(SESSION)
    // 一轮让插件写下读数（被换成上一次加载留下的），这一轮自己的读数也被换掉
    await turn($)
    await reload($, w)
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(cacheOf(w.state).expiresAt).toBe(START + 1 * SEC + HOUR)
  })

  test('$.state 里存的是别的形状：按冷启动，如实记作还没有请求', async ($, on) => {
    const w = engine(on, { forks: [WARM], live: { tokens: 150000 }, rewrite: previous({ replying: true }, []) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(cacheOf(w.state)).toMatchObject({ expiresAt: null, context: 150000, hitRate: { last: null, session: null } })
    expect((await keepaliveRow($)).text).toBe('on')
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
  })

  test('$.state 里没有（新会话）：按冷启动', async ($, on) => {
    const w = engine(on, { forks: [WARM], live: { tokens: 150000 } })
    await $.session.start(SESSION)
    expect(cacheOf(w.state)).toMatchObject({ expiresAt: null, context: 150000 })
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
  })

  test('本会话手动关掉的，重载后仍关着', async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await $.command.run(anvil('keepalive'))
    await reload($, w)
    expect((await keepaliveRow($)).text).toBe('off (this session)')
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
  })

  test('模块内存和 $.state 一致时再收到 session.start：读数不变，定时器不重复', async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(30 * MIN)
    const before = cacheOf(w.state)
    expect((w.state.get('anvil.cacheMemory') as Cache).lastRequestAt).toBe(START)

    await reload($, w)
    expect(cacheOf(w.state)).toEqual(before)
    await w.clock.advance(20 * MIN)
    expect(w.forks).toHaveLength(1)
    await w.clock.advance(49 * MIN)
    expect(w.forks).toHaveLength(1)
    await w.clock.advance(1 * MIN)
    expect(w.forks).toHaveLength(2)
  })
})

// ---------------------------------------------------------------- 保活状态与写给 statusline 的文件

const SETTINGS: Settings = { threshold: 50000, autoKeepalive: true, guard: true, band: ['dir', 'git', '5h', '7d', 'cost'] }

describe('保活状态', () => {
  test('保活状态：自动开启的五种，加上本会话手动开、手动关', () => {
    const idle = { stopped: null, renewing: false, inFlight: false }
    const base = { settings: SETTINGS, override: null, context: 151000, loop: idle }
    expect(keepaliveStatus(base)).toEqual({ text: 'on' })
    expect(keepaliveStatus({ ...base, loop: { stopped: null, renewing: true, inFlight: false } })).toEqual({ text: 'renewing' })
    expect(keepaliveStatus({ ...base, override: false })).toEqual({ text: 'off (this session)', color: COLOR.secondary })
    expect(keepaliveStatus({ ...base, context: 32000 })).toEqual({ text: 'not on (context below 50k)', color: COLOR.secondary })
    expect(keepaliveStatus({ ...base, settings: { ...SETTINGS, autoKeepalive: false } })).toEqual({
      text: 'not on (auto-enable is off)',
      color: COLOR.secondary,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'limit', reason: 'idle for over 12 hours' }, renewing: true, inFlight: false } })).toEqual({
      text: 'stopped (idle for over 12 hours)',
      color: COLOR.secondary,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'reading', reason: 'cache had expired by renewal' }, renewing: false, inFlight: false } })).toEqual({
      text: 'stopped (cache had expired by renewal)',
      color: COLOR.danger,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'error', reason: 'renewal was aborted' }, renewing: false, inFlight: false } }).color).toBe(COLOR.danger)

    // 本会话手动开：不看自动开启和阈值；手动关：不看停下
    const manual = { ...base, override: true, context: 0, settings: { ...SETTINGS, autoKeepalive: false } }
    expect(keepaliveStatus(manual)).toEqual({ text: 'on (this session)' })
    expect(keepaliveStatus({ ...manual, loop: { stopped: null, renewing: true, inFlight: false } })).toEqual({ text: 'renewing (this session)' })
    expect(keepaliveStatus({ ...manual, loop: { stopped: { kind: 'limit', reason: 'idle for over 12 hours' }, renewing: true, inFlight: false } }).text).toBe(
      'stopped (idle for over 12 hours)',
    )
    expect(keepaliveStatus({ ...base, override: false, loop: { stopped: { kind: 'error', reason: 'renewal was aborted' }, renewing: false, inFlight: false } }).text).toBe(
      'off (this session)',
    )
  })

  test('写给 statusline：开着、没停下就会续；读数不达标、请求出错写原因，空闲到上限不算出错', () => {
    const idle = { stopped: null, renewing: false, inFlight: false }
    const base = { settings: SETTINGS, override: null, context: 151000, loop: idle }
    expect(statuslineFile(base, null, 7)).toEqual({ renews: true, error: null, expiresAt: null, at: 7 })
    expect(statuslineFile({ ...base, context: 1000 }, null, 7)).toEqual({ renews: false, error: null, expiresAt: null, at: 7 })
    expect(statuslineFile({ ...base, override: true, context: 1000 }, null, 7).renews).toBe(true)
    expect(statuslineFile({ ...base, override: false }, null, 7).renews).toBe(false)
    expect(statuslineFile({ ...base, loop: { ...idle, stopped: { kind: 'limit', reason: 'idle for over 12 hours' } } }, null, 7)).toEqual({ renews: false, error: null, expiresAt: null, at: 7 })
    expect(statuslineFile({ ...base, loop: { ...idle, stopped: { kind: 'error', reason: 'renewal was aborted' } } }, null, 7)).toEqual({ renews: false, error: 'renewal was aborted', expiresAt: null, at: 7 })
  })

  test('状态文件写在 ~/.claude/anvil/sessions/<session_id>.json，按引擎的会话 id；变了才写', async ($, on) => {
    const w = engine(on, { forks: [{ read: 0, write: 150000 }], env: { USERPROFILE: 'C:/Users/me' } })
    const path = `C:/Users/me/.claude/anvil/sessions/${SESSION_ID}.json`
    const file = () => JSON.parse(w.written.get(path) ?? 'null') as StatuslineFile | null
    await $.session.start(SESSION)
    // 开局上下文低于阈值：不会续
    expect(file()).toMatchObject({ renews: false, error: null })
    await turn($)
    expect(file()).toMatchObject({ renews: true, error: null })
    const settled = w.writes.length
    await turn($)
    expect(w.writes.length).toBe(settled)
    // 续期读数不达标：停下，写原因
    await w.clock.advance(50 * MIN)
    expect(file()).toMatchObject({ renews: false, error: 'cache had expired by renewal' })
    // 本会话手动关掉
    await turn($)
    await $.command.run(anvil('keepalive'))
    expect(file()).toMatchObject({ renews: false, error: null })
  })

  test('设了 CLAUDE_CONFIG_DIR 时写在它下面', async ($, on) => {
    const w = engine(on, { env: { CLAUDE_CONFIG_DIR: 'D:/cc', USERPROFILE: 'C:/Users/me' } })
    await $.session.start(SESSION)
    expect([...w.written.keys()]).toEqual([`D:/cc/anvil/sessions/${SESSION_ID}.json`])
  })
})
