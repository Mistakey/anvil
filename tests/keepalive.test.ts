import type { ModelForkResult, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cacheRows, formatExpired, hitColor } from '../hooks/cachebox'
import { freshCache, view } from '../hooks/cache'
import type { Cache } from '../hooks/cache'
import { IDLE_LIMIT_MS, PING_AFTER_MS, keepaliveStatus } from '../hooks/keepalive'
import type { LoopMemory } from '../hooks/keepalive'
import { COLOR, GRID, ICON, valueWidth } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import { EMPTY_USAGE, usageRows } from '../hooks/usage'
import type { GridRow } from '../hooks/usage'
import type { CacheView, Settings } from '../types'
import { SESSION, WARM, anvil, drain, stepInput, turnInput, typed, usage, world } from './world'
import type { WorldOptions } from './world'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

// 本地时间 2026-10-13 20:00；缓存框的时刻按本地时区格式化
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const START = at(13, 20)

const cacheOf = (state: Map<string, unknown>) => state.get('anvil.cache') as CacheView

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

function engine(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: START })
  const w = world(on, options)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, ...w }
}

/** 主会话一轮：一次请求加一轮结束 */
async function turn($: Engine, over = {}) {
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput(over))
}


/** 字恰好是 text 的最里层 Text 的颜色（外层的 Text 只是把几段包起来） */
async function colorOf(ui: Mounted<'terminal', 'Pane'>, text: string) {
  const found = (await ui.findAll({ type: 'Text' })).filter(one => one.text === text)
  return found.at(-1)?.props.color
}

/** 缓存框里保活那一行的字和颜色 */
async function keepaliveRow($: Engine) {
  const ui = await $.ui.mount(pane(70))
  const row = await ui.find({ key: 'row:keepalive' })
  const text = flat(row).replace(/^保活/, '')
  const color = await colorOf(ui, text)
  await ui.unmount()
  return { text, color }
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
    expect(await keepaliveRow($)).toEqual({ text: '未启用（低于 50k）', color: COLOR.secondary })
  })

  test('/config 关掉自动开启后不开', { options: { autoKeepalive: false } }, async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect((await keepaliveRow($)).text).toBe('未启用（自动开启已关闭）')
  })

  test('/config 改的阈值传到保活', { options: { threshold: 200000 } }, async ($, on) => {
    const w = engine(on, { forks: [WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(0)
    expect((await keepaliveRow($)).text).toBe('未启用（低于 200k）')
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
    expect(off.text).toBe('缓存保活已关闭（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '已关闭（本会话）', color: COLOR.secondary })
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(0)
    // 关着的时候，新的一轮也不开
    await turn($)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(0)

    const back = await $.command.run(anvil(' keepalive '))
    expect(back.text).toBe('缓存保活已开启（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '已启用（本会话）' })
    // 这段空闲已过 50 分钟、缓存还有效：马上补一次
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(await keepaliveRow($)).toEqual({ text: '进行中（本会话）' })
  })

  test('/config 关掉自动开启时，切换一次就在本会话开启，按时发 fork', { options: { autoKeepalive: false } }, async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM] })
    await $.session.start(SESSION)
    await turn($)
    expect((await keepaliveRow($)).text).toBe('未启用（自动开启已关闭）')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已开启（本会话）')
    await w.clock.advance(49 * MIN)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(1 * MIN)
    expect(w.forks).toHaveLength(1)
    expect(cacheOf(w.state).expiresAt).toBe(START + 50 * MIN + HOUR)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)

    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已关闭（本会话）')
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toHaveLength(2)
  })

  test('上下文低于阈值时也能手动开启', async ($, on) => {
    const small = usage({ cache_read_input_tokens: 40000 })
    const w = engine(on, { forks: [WARM], reply: { usage: small } })
    await $.session.start(SESSION)
    await turn($, { usage: small })
    expect((await keepaliveRow($)).text).toBe('未启用（低于 50k）')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已开启（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '已启用（本会话）' })
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(1)
  })

  test('保活已停下时，切换一次就在本会话重新开始，而不是关掉；再切换一次才关掉', async ($, on) => {
    const w = engine(on, { forks: [{ read: 0, write: 150000 }, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(50 * MIN)
    expect((await keepaliveRow($)).text).toBe('已停止（续期时缓存已过期）')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已开启（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '已启用（本会话）' })
    // 缓存还有效、已过发请求的时刻：马上补一次
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(2)
    expect((await keepaliveRow($)).text).toBe('进行中（本会话）')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已关闭（本会话）')
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
    expect(list).toMatch(/^ {2}\/anvil keepalive +开启或关闭缓存保活（现在：已启用）$/m)
    expect((await $.command.run(anvil('keepalive off'))).text).toStartWith('没有子命令 keepalive off。')
    expect((await $.command.run(anvil('keepalive on'))).text).toStartWith('没有子命令 keepalive on。')
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
    expect((await keepaliveRow($)).text).toBe('进行中')

    await w.clock.advance(1 * SEC)
    expect(await keepaliveRow($)).toEqual({ text: '已停止（空闲超过 12 小时）', color: COLOR.secondary })
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(14)
  })

  test('续满 12 小时停下后手动重新开启：照常续期，新的 12 小时从开启时算起', async ($, on) => {
    const w = engine(on, { forks: Array.from({ length: 40 }, () => WARM) })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(IDLE_LIMIT_MS)
    expect((await keepaliveRow($)).text).toBe('已停止（空闲超过 12 小时）')
    // 最后一次续期在 11h40m，缓存到 12h40m 过期；过期前 10 分钟敲一次
    await w.clock.advance(10 * MIN)
    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已开启（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '进行中（本会话）' })

    // 上一次续期之后 50 分钟（12h30m）照常发、续期
    await w.clock.advance(20 * MIN)
    expect(w.forks).toHaveLength(15)
    expect(cacheOf(w.state).expiresAt).toBe(START + 12 * HOUR + 30 * MIN + HOUR)

    // 新的上限在开启后 12 小时（24h10m）：之前每 50 分钟一次，最后一次在 23h20m
    await w.clock.advance(IDLE_LIMIT_MS - 20 * MIN - 1 * SEC)
    expect(w.forks).toHaveLength(28)
    expect((await keepaliveRow($)).text).toBe('进行中（本会话）')
    await w.clock.advance(1 * SEC)
    expect(await keepaliveRow($)).toEqual({ text: '已停止（空闲超过 12 小时）', color: COLOR.secondary })
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
      expect(await keepaliveRow($)).toEqual({ text: '已停止（续期时缓存已过期）', color: COLOR.danger })
      await w.clock.advance(3 * HOUR)
      expect(w.forks).toHaveLength(1)
    })
  }

  for (const [answer, reason] of [
    [{ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }, '续期请求出错：HTTP 429'],
    [{ isAnswered: false, reason: 'empty-reply', usage: usage() }, '续期请求没有回复'],
    [{ isAnswered: false, reason: 'aborted', usage: usage() }, '续期请求被中断'],
    [{ isAnswered: false, reason: 'nothing-to-fork' }, '还没有可续期的对话'],
  ] satisfies [ModelForkResult, string][]) {
    test(`请求出错停下，原因为红：${reason}`, async ($, on) => {
      const w = engine(on, { forks: [answer, WARM] })
      await $.session.start(SESSION)
      await turn($)
      await w.clock.advance(50 * MIN)
      expect(await keepaliveRow($)).toEqual({ text: `已停止（${reason}）`, color: COLOR.danger })
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
    expect(row.text).toStartWith('已停止（续期请求出错：')
    expect(row.color).toBe(COLOR.danger)
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(1)
  })

  test('停下只结束这一段空闲：下一次主会话请求之后重新开始', async ($, on) => {
    const w = engine(on, { forks: [{ read: 0, write: 150000 }, WARM] })
    await $.session.start(SESSION)
    await turn($)
    await w.clock.advance(50 * MIN)
    expect((await keepaliveRow($)).text).toBe('已停止（续期时缓存已过期）')

    await w.clock.advance(1 * HOUR)
    await drain($.turn.step(stepInput()))
    expect((await keepaliveRow($)).text).toBe('已启用')
    await $.turn.complete(turnInput())
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)
    expect((await keepaliveRow($)).text).toBe('进行中')
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
      expect((await keepaliveRow($)).text).toBe('已停止（续期时缓存已过期）')
      expect(cacheOf(w.state).coldWrites.count).toBe(1)

      // 会话 B：10 分钟前还有响应，缓存没过期
      await $.classic.SessionStart({ source, seconds_since_last_response: 600, context_tokens: 200000, prompt_cache_likely_expired: false })
      expect(await keepaliveRow($)).toEqual({ text: '已启用' })
      const b = cacheOf(w.state)
      expect(b.hitRate).toEqual({ last: null, session: null })
      expect(b.coldWrites).toEqual({ count: 0, usd: 0 })
      // 计价用的模型（Opus 5.5，1 小时写入 $10/MTok）保留
      expect(b.rebuild).toEqual({ tokens: 200000, usd: 2 })

      const ui = await $.ui.mount(pane(70))
      expect(flat(await ui.find({ key: 'row:cache' }))).toBe(`${ICON.cache}—`)
      await ui.unmount()

      // B 的最后一次响应之后满 50 分钟发 fork
      await w.clock.advance(40 * MIN - 2 * SEC)
      expect(w.forks).toHaveLength(1)
      await w.clock.advance(2 * SEC)
      expect(w.forks).toHaveLength(2)
      expect((await keepaliveRow($)).text).toBe('进行中')
    })
  }
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

  test('有过请求 → 热重载 → 空闲：照原来的过期时刻定时、续期，缓存框和重载前一样', async ($, on) => {
    const w = engine(on, { forks: [WARM, WARM], rewrite: previous(cacheMemory(), loopMemory()) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(cacheOf(w.state)).toEqual(view(cacheMemory()))
    expect(await keepaliveRow($)).toEqual({ text: '已启用' })

    // 上一次请求之后满 50 分钟（START + 20 分钟）发 fork，以这次请求顺延过期时刻
    await w.clock.advance(20 * MIN - 2 * SEC)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(2 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(cacheOf(w.state).expiresAt).toBe(START + 20 * MIN + HOUR)
    expect((await keepaliveRow($)).text).toBe('进行中')
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(2)
  })

  test('这段空闲里续期过：重载后仍是进行中，12 小时上限照最后一次主会话请求算', async ($, on) => {
    // 11h30m 前发过请求，续期过 13 次，最后一次在 40 分钟前
    const cache = cacheMemory({ lastRequestAt: START - IDLE_LIMIT_MS + 30 * MIN, expiresAt: START + 20 * MIN })
    const w = engine(on, { forks: Array.from({ length: 5 }, () => WARM), rewrite: previous(cache, loopMemory({ renewals: 13 })) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(await keepaliveRow($)).toEqual({ text: '进行中' })

    await w.clock.advance(10 * MIN)
    expect(w.forks).toHaveLength(1)
    await w.clock.advance(20 * MIN)
    expect(await keepaliveRow($)).toEqual({ text: '已停止（空闲超过 12 小时）', color: COLOR.secondary })
    await w.clock.advance(3 * HOUR)
    expect(w.forks).toHaveLength(1)
  })

  test('重载时保活已停下：保持停下和原因，不发；下一次主会话请求之后照常', async ($, on) => {
    const stopped = { kind: 'reading', reason: '续期时缓存已过期' } as const
    const w = engine(on, { forks: [WARM], rewrite: previous(cacheMemory(), loopMemory({ stopped })) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(await keepaliveRow($)).toEqual({ text: '已停止（续期时缓存已过期）', color: COLOR.danger })
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
    expect((await $.prompt.submit(typed('继续'))).drop ?? '').toStartWith('anvil：缓存已过期')
  })

  test('重载前续期请求还在路上：那次请求随旧模块丢了，保活的动效收起，重载后补发一次', async ($, on) => {
    // 50 分钟前的请求，续期请求发出 5 秒后重载
    const cache = cacheMemory({ lastRequestAt: START - 50 * MIN, expiresAt: START + 10 * MIN })
    const keep = { since: START - 5 * SEC, until: null }
    const w = engine(on, { forks: [WARM], rewrite: previous(cache, loopMemory(), { 'anvil.activity': { reply: null, keep, translate: null } }) })
    await $.session.start(SESSION)
    // 一轮让插件写下 activity（被换成续期还在路上），这一轮自己的读数也被换掉
    await turn($)
    await reload($, w)
    const activity = w.state.get('anvil.activity') as { keep: unknown }
    expect(activity.keep).toEqual({ since: START - 5 * SEC, until: START })
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(cacheOf(w.state).expiresAt).toBe(START + 1 * SEC + HOUR)
  })

  test('$.state 里存的是别的形状：按冷启动，缓存框如实显示还没有请求', async ($, on) => {
    const w = engine(on, { forks: [WARM], live: { tokens: 150000 }, rewrite: previous({ replying: true }, []) })
    await $.session.start(SESSION)
    await reload($, w)
    expect(cacheOf(w.state)).toMatchObject({ expiresAt: null, context: 150000, hitRate: { last: null, session: null } })
    expect((await keepaliveRow($)).text).toBe('已启用')
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
    expect((await keepaliveRow($)).text).toBe('已关闭（本会话）')
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

// ---------------------------------------------------------------- 缓存框

const SETTINGS: Settings = { showPanel: true, showTranslate: true, threshold: 50000, autoKeepalive: true, guard: true, translateBackend: 'haiku', translateApiUrl: '', translateApiModel: '' }
const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')
/** 一行的值（不折行时就是整个值） */
const lineOf = (row: GridRow | undefined) => text(row?.lines[0] ?? [])
const ENABLED: Segment = { text: '已启用' }

/** 一份缓存框读数：上下文 152k，本会话命中率 94%，21:40 过期 */
function sample(over: Partial<CacheView> = {}): CacheView {
  return {
    ...view(freshCache()),
    expiresAt: at(13, 21, 40),
    context: 151000,
    rebuild: { tokens: 152000, usd: 1.52 },
    hitRate: { last: 0.99, session: 0.94 },
    coldWrites: { count: 1, usd: 1.55 },
    ...over,
  }
}

describe('缓存框', () => {
  /** 某一行的值 */
  const valueOf = (rows: GridRow[], key: string) => lineOf(rows.find(row => row.key === key))

  test('三行：缓存图标 | 本会话命中率；● | 过期状态；保活。名称一列和用量框同宽', () => {
    const rows = cacheRows(sample(), ENABLED, at(13, 20), 66)
    expect(rows.map(row => row.key)).toEqual(['cache', 'state', 'keepalive'])
    expect(rows.map(row => text(row.label))).toEqual([ICON.cache, '●', '保活'])
    expect(valueOf(rows, 'cache')).toBe('94%')
    expect(rows.every(row => row.labelWidth === GRID.label)).toBe(true)
  })

  test('有效：● 有效绿，"过期"次要色、时刻正文色（好状态只给符号和状态词上色）；不是当天的写 HH:MM MM-DD', () => {
    const [, state] = cacheRows(sample(), ENABLED, at(13, 20), 66)
    expect(state?.label).toEqual([{ text: '●', color: COLOR.ok }])
    expect(lineOf(state)).toBe('有效 · 过期 21:40')
    expect(state?.lines[0]).toEqual([{ text: '有效', color: COLOR.ok }, { text: ' · ', color: COLOR.icon }, { text: '过期 ', color: COLOR.secondary }, { text: '21:40' }])
    expect(valueOf(cacheRows(sample({ expiresAt: at(14, 0, 30) }), ENABLED, at(13, 23), 66), 'state')).toBe('有效 · 过期 00:30 10-14')
  })

  test('已过期：● 红，值"已过期 N 分钟"红，1 小时起写 N 小时 M 分钟', () => {
    const expired = (now: number) => cacheRows(sample(), ENABLED, now, 66)[1]
    expect(lineOf(expired(at(13, 21, 40)))).toBe('已过期 0 分钟')
    expect(lineOf(expired(at(13, 22, 32)))).toBe('已过期 52 分钟')
    expect(lineOf(expired(at(13, 22, 50)))).toBe('已过期 1 小时 10 分钟')
    expect(lineOf(expired(at(14, 6, 52)))).toBe('已过期 9 小时 12 分钟')
    expect(expired(at(13, 22, 50))?.label).toEqual([{ text: '●', color: COLOR.danger }])
    expect(expired(at(13, 22, 50))?.lines[0]?.every(one => one.color === COLOR.danger)).toBe(true)
    expect([59, 60, 61, 552].map(minutes => formatExpired(minutes * MIN + 30 * SEC))).toEqual(['59 分钟', '1 小时 0 分钟', '1 小时 1 分钟', '9 小时 12 分钟'])
  })

  test('还没有请求、刚压缩完：命中率写 —，● 那一行照画，"● —"（● 图标色、— 次要色），框始终三行', () => {
    for (const rows of [cacheRows(view(freshCache()), ENABLED, at(13, 20), 66), cacheRows(sample({ compacted: true }), ENABLED, at(13, 22, 50), 66)]) {
      expect(rows.map(row => row.key)).toEqual(['cache', 'state', 'keepalive'])
      const state = rows[1]
      expect(state?.label).toEqual([{ text: '●', color: COLOR.icon }])
      expect(state?.lines[0]).toEqual([{ text: '—', color: COLOR.secondary }])
    }
    expect(valueOf(cacheRows(view(freshCache()), ENABLED, at(13, 20), 66), 'cache')).toBe('—')
  })

  test('命中率：低于 80% 变黄、低于 50% 变红，图标是图标色；不写"命中率"和上一条', () => {
    expect([1, 0.8, 0.79, 0.5, 0.49, 0].map(hitColor)).toEqual([undefined, undefined, COLOR.warn, COLOR.warn, COLOR.danger, COLOR.danger])
    const [hit] = cacheRows(sample({ hitRate: { last: 0.31, session: 0.72 } }), ENABLED, at(13, 20), 66)
    expect(hit?.label).toEqual([{ text: ICON.cache, color: COLOR.icon }])
    expect(hit?.lines[0]).toEqual([{ text: '72%', color: COLOR.warn }])
    const all = cacheRows(sample(), ENABLED, at(13, 23), 66).flatMap(row => [text(row.label), ...row.lines.map(text)]).join('\n')
    for (const word of ['命中率', '上一条', '重建', '≈', 'tokens']) expect(all).not.toContain(word)
  })

  test('缓存框和用量框的值从同一列起', () => {
    for (const inner of [46, 47, 66]) {
      const cache = cacheRows(sample(), ENABLED, at(13, 20), inner)
      const usage = usageRows(EMPTY_USAGE, at(13, 20), inner)
      expect(new Set([...cache, ...usage].map(row => row.labelWidth))).toEqual(new Set([GRID.label]))
    }
  })

  test('窄到放不下时各行整块折到下一行，长的保活状态逐行折下去，都不出现 …', () => {
    const stopped: Segment = { text: '已停止（续期请求出错：connect ECONNREFUSED 127.0.0.1:443）', color: COLOR.danger }
    for (const columns of [40, 46, 50, 51, 52, 60, 70, 90]) {
      const inner = columns - 4
      for (const now of [at(13, 20), at(14, 6, 52)]) {
        const rows = cacheRows(sample({ hitRate: { last: 1, session: 1 } }), stopped, now, inner)
        const lines = rows.flatMap(row => row.lines.map(text))
        expect(lines.join(' / '), `${columns} 列`).not.toContain('…')
        for (const line of lines) expect(cells(line) <= valueWidth(inner), `${columns} 列：${line}`).toBe(true)
        expect(lines.join('').replace(/ /g, ''), `${columns} 列`).toContain(stopped.text.replace(/ /g, ''))
        const keepalive = rows.find(row => row.key === 'keepalive')
        for (const line of keepalive?.lines ?? []) expect(line[0]?.color).toBe(COLOR.danger)
      }
    }
  })

  test('保活状态：自动开启的五种，加上本会话手动开、手动关', () => {
    const idle = { stopped: null, renewing: false, inFlight: false }
    const base = { settings: SETTINGS, override: null, context: 151000, loop: idle }
    expect(keepaliveStatus(base)).toEqual({ text: '已启用' })
    expect(keepaliveStatus({ ...base, loop: { stopped: null, renewing: true, inFlight: false } })).toEqual({ text: '进行中' })
    expect(keepaliveStatus({ ...base, override: false })).toEqual({ text: '已关闭（本会话）', color: COLOR.secondary })
    expect(keepaliveStatus({ ...base, context: 32000 })).toEqual({ text: '未启用（低于 50k）', color: COLOR.secondary })
    expect(keepaliveStatus({ ...base, settings: { ...SETTINGS, autoKeepalive: false } })).toEqual({
      text: '未启用（自动开启已关闭）',
      color: COLOR.secondary,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'limit', reason: '空闲超过 12 小时' }, renewing: true, inFlight: false } })).toEqual({
      text: '已停止（空闲超过 12 小时）',
      color: COLOR.secondary,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'reading', reason: '续期时缓存已过期' }, renewing: false, inFlight: false } })).toEqual({
      text: '已停止（续期时缓存已过期）',
      color: COLOR.danger,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'error', reason: '续期请求被中断' }, renewing: false, inFlight: false } }).color).toBe(COLOR.danger)

    // 本会话手动开：不看自动开启和阈值；手动关：不看停下
    const manual = { ...base, override: true, context: 0, settings: { ...SETTINGS, autoKeepalive: false } }
    expect(keepaliveStatus(manual)).toEqual({ text: '已启用（本会话）' })
    expect(keepaliveStatus({ ...manual, loop: { stopped: null, renewing: true, inFlight: false } })).toEqual({ text: '进行中（本会话）' })
    expect(keepaliveStatus({ ...manual, loop: { stopped: { kind: 'limit', reason: '空闲超过 12 小时' }, renewing: true, inFlight: false } }).text).toBe(
      '已停止（空闲超过 12 小时）',
    )
    expect(keepaliveStatus({ ...base, override: false, loop: { stopped: { kind: 'error', reason: '续期请求被中断' }, renewing: false, inFlight: false } }).text).toBe(
      '已关闭（本会话）',
    )
  })

  test('终端上画出缓存框：三行，上边框右侧不放状态，和用量框的值同一列起，各种宽度下不超宽', async ($, on) => {
    const w = engine(on, { forks: [] })
    await $.session.start(SESSION)
    await turn($)
    for (const columns of [70, 110, 51, 40]) {
      const ui = await $.ui.mount(pane(columns))
      expect(await ui.find({ key: 'status:section:cache' })).toBeUndefined()
      const box = await ui.find({ key: 'box:cache' })
      const keys = (box?.children ?? []).map(one => (one as { props?: { key?: string } }).props?.key)
      expect(keys, `${columns} 列`).toEqual(['row:cache', 'row:state', 'row:keepalive'])
      for (const key of ['cache', 'state', 'keepalive', 'five_hour']) {
        const row = await ui.find({ key: `row:${key}` })
        expect(row?.props.width).toBe(columns - 4)
        expect((row?.children[0] as { props?: { width?: number } } | undefined)?.props?.width).toBe(GRID.label)
      }
      expect(flat(await ui.find({ key: 'row:cache' }))).toBe(`${ICON.cache}100%`)
      expect(flat(await ui.find({ key: 'row:state' }))).toBe('●有效 · 过期 21:00')
      expect(await colorOf(ui, '有效')).toBe(COLOR.ok)
      expect(await colorOf(ui, '过期 ')).toBe(COLOR.secondary)
      expect(await colorOf(ui, '21:00')).toBeUndefined()
      expect(await colorOf(ui, '●')).toBe(COLOR.ok)
      await ui.unmount()
    }

    // 过期后（保活在 50 分钟那次停下了）：写已过期时长，红
    await w.clock.advance(2 * HOUR + 10 * MIN)
    const ui = await $.ui.mount(pane(70))
    expect(flat(await ui.find({ key: 'row:state' }))).toBe('●已过期 1 小时 10 分钟')
    expect(await colorOf(ui, '已过期 1 小时 10 分钟')).toBe(COLOR.danger)
    expect(await colorOf(ui, '●')).toBe(COLOR.danger)
    await ui.unmount()
  })
})
