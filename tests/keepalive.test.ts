import type { ModelForkResult, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cacheRows, cacheStatus, hitColor } from '../hooks/cachebox'
import { freshCache, view } from '../hooks/cache'
import { IDLE_LIMIT_MS, PING_AFTER_MS, keepaliveStatus } from '../hooks/keepalive'
import { COLOR, GRID, valueWidth } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import type { GridRow } from '../hooks/usage'
import type { CacheView, Settings } from '../types'
import { SESSION, WARM, anvil, drain, stepInput, turnInput, usage, world } from './world'
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
    expect(await keepaliveRow($)).toEqual({ text: '未启用（上下文低于 50k）', color: COLOR.muted })
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
    expect((await keepaliveRow($)).text).toBe('未启用（上下文低于 200k）')
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
    expect(await keepaliveRow($)).toEqual({ text: '已关闭（本会话）', color: COLOR.muted })
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(0)
    // 关着的时候，新的一轮也不开
    await turn($)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toHaveLength(0)

    const back = await $.command.run(anvil(' keepalive '))
    expect(back.text).toBe('缓存保活已开启（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '已启用（本会话）', color: COLOR.ok })
    // 这段空闲已过 50 分钟、缓存还有效：马上补一次
    await w.clock.advance(1 * SEC)
    expect(w.forks).toHaveLength(1)
    expect(await keepaliveRow($)).toEqual({ text: '进行中（本会话）', color: COLOR.ok })
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
    expect((await keepaliveRow($)).text).toBe('未启用（上下文低于 50k）')

    expect((await $.command.run(anvil('keepalive'))).text).toBe('缓存保活已开启（本会话）')
    expect(await keepaliveRow($)).toEqual({ text: '已启用（本会话）', color: COLOR.ok })
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
    expect(await keepaliveRow($)).toEqual({ text: '已启用（本会话）', color: COLOR.ok })
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
    expect(await keepaliveRow($)).toEqual({ text: '已停止（空闲超过 12 小时）', color: COLOR.muted })
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
    expect(await keepaliveRow($)).toEqual({ text: '进行中（本会话）', color: COLOR.ok })

    // 上一次续期之后 50 分钟（12h30m）照常发、续期
    await w.clock.advance(20 * MIN)
    expect(w.forks).toHaveLength(15)
    expect(cacheOf(w.state).expiresAt).toBe(START + 12 * HOUR + 30 * MIN + HOUR)

    // 新的上限在开启后 12 小时（24h10m）：之前每 50 分钟一次，最后一次在 23h20m
    await w.clock.advance(IDLE_LIMIT_MS - 20 * MIN - 1 * SEC)
    expect(w.forks).toHaveLength(28)
    expect((await keepaliveRow($)).text).toBe('进行中（本会话）')
    await w.clock.advance(1 * SEC)
    expect(await keepaliveRow($)).toEqual({ text: '已停止（空闲超过 12 小时）', color: COLOR.muted })
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
      expect(await keepaliveRow($)).toEqual({ text: '已启用', color: COLOR.ok })
      const b = cacheOf(w.state)
      expect(b.hitRate).toEqual({ last: null, session: null })
      expect(b.coldWrites).toEqual({ count: 0, usd: 0 })
      // 计价用的模型（Opus 5.5，1 小时写入 $10/MTok）保留
      expect(b.rebuild).toEqual({ tokens: 200000, usd: 2 })

      const ui = await $.ui.mount(pane(70))
      expect(flat(await ui.find({ key: 'row:cache-hit' }))).toBe('命中率本会话    — · 上一条 —')
      expect(flat(await ui.find({ key: 'row:cache-rebuilt' }))).toBe('已重建本会话 0 次')
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

// ---------------------------------------------------------------- 缓存框

const SETTINGS: Settings = { threshold: 50000, autoKeepalive: true, guard: true, translateBackend: 'haiku', translateApiUrl: '', translateApiModel: '' }
const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')
/** 一行的值（不折行时就是整个值） */
const lineOf = (row: GridRow | undefined) => text(row?.lines[0] ?? [])

/** 一份缓存框读数：上下文 152k，命中率 99% · 94%，冷写 1 次 */
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
  test('上边框：有效 · HH:MM 过期；已过期 时长；还没有请求时不写', () => {
    const valid = cacheStatus(sample(), at(13, 20))
    expect(text(valid)).toBe('● 有效 · 21:40 过期')
    expect(valid[0]?.color).toBe(COLOR.ok)
    expect(text(cacheStatus(sample({ expiresAt: at(14, 0, 30) }), at(13, 23)))).toBe('● 有效 · 明天 00:30 过期')

    const expired = cacheStatus(sample(), at(13, 22, 50))
    expect(text(expired)).toBe('○ 已过期 1h10m')
    expect(expired[0]?.color).toBe(COLOR.danger)
    expect(cacheStatus(sample({ expiresAt: null }), at(13, 22))).toEqual([])
    expect(cacheStatus(sample({ compacted: true }), at(13, 22, 50))).toEqual([])
  })

  test('命中率：本会话在前、上一条在后；低于 80% 变黄，低于 50% 变红；没有读数写 —', () => {
    expect([1, 0.8, 0.79, 0.5, 0.49, 0].map(hitColor)).toEqual([undefined, undefined, COLOR.warn, COLOR.warn, COLOR.danger, COLOR.danger])
    const status: Segment = { text: '已启用', color: COLOR.ok }
    const [hit] = cacheRows(sample({ hitRate: { last: 0.31, session: 0.72 } }), status, at(13, 20), 66)
    expect(hit?.label).toBe('命中率')
    expect(lineOf(hit)).toBe('本会话  72% · 上一条 31%')
    expect(hit?.lines[0]?.find(one => one.text.includes('72%'))?.color).toBe(COLOR.warn)
    expect(hit?.lines[0]?.at(-1)?.color).toBe(COLOR.danger)
    const [fresh] = cacheRows(sample({ hitRate: { last: null, session: null } }), status, at(13, 20), 66)
    expect(lineOf(fresh)).toBe('本会话    — · 上一条 —')
  })

  test('过期代价：重建 N tokens ≈ $；已过期时重建量变红', () => {
    const status: Segment = { text: '已启用', color: COLOR.ok }
    const valid = cacheRows(sample(), status, at(13, 20), 66).find(row => row.key === 'cache-cost')
    expect(lineOf(valid)).toBe('重建 152k tokens ≈ $1.52')
    expect(valid?.lines[0]?.find(one => one.text.includes('152k'))?.color).toBe(undefined)
    const expired = cacheRows(sample(), status, at(13, 23), 66).find(row => row.key === 'cache-cost')
    expect(expired?.lines[0]?.find(one => one.text.includes('152k'))?.color).toBe(COLOR.danger)
  })

  test('已重建：本会话 N 次 · 共 $；0 次时不写金额', () => {
    const status: Segment = { text: '已启用', color: COLOR.ok }
    const once = cacheRows(sample(), status, at(13, 20), 66).find(row => row.key === 'cache-rebuilt')
    expect(lineOf(once)).toBe('本会话 1 次 · 共 $1.55')
    const none = cacheRows(sample({ coldWrites: { count: 0, usd: 0 } }), status, at(13, 20), 66).find(row => row.key === 'cache-rebuilt')
    expect(lineOf(none)).toBe('本会话 0 次')
  })

  test('数值定宽：命中率 9% 到 100%、重建量 9k 到 152k，同一行后面的字不挪位置', () => {
    const status: Segment = { text: '已启用', color: COLOR.ok }
    const after = (over: Partial<CacheView>, key: string, marker: string) =>
      lineOf(cacheRows(sample(over), status, at(13, 20), 66).find(row => row.key === key)).indexOf(marker)
    expect(after({ hitRate: { last: 1, session: 0.09 } }, 'cache-hit', '上一条')).toBe(after({ hitRate: { last: 1, session: 1 } }, 'cache-hit', '上一条'))
    expect(after({ hitRate: { last: 1, session: null } }, 'cache-hit', '上一条')).toBe(after({ hitRate: { last: 1, session: 1 } }, 'cache-hit', '上一条'))
    expect(after({ rebuild: { tokens: 9000, usd: 0.09 } }, 'cache-cost', '≈')).toBe(after({ rebuild: { tokens: 152000, usd: 1.52 } }, 'cache-cost', '≈'))
    expect(after({ expiresAt: null }, 'cache-cost', '≈')).toBe(after({}, 'cache-cost', '≈'))
  })

  test('还没有任何主会话请求时，命中率、过期代价、已重建写 —，不写像算出来的 0', () => {
    const status: Segment = { text: '已启用', color: COLOR.ok }
    const none = view(freshCache())
    expect(none.expiresAt).toBe(null)
    const rows = cacheRows(none, status, at(13, 20), 66)
    const row = (key: string) => rows.find(one => one.key === key)
    expect(lineOf(row('cache-hit'))).toBe('本会话    — · 上一条 —')
    expect(lineOf(row('cache-cost'))).toBe('重建    — tokens ≈ —')
    expect(lineOf(row('cache-rebuilt'))).toBe('本会话 —')
  })

  test('四行的名称：命中率、过期代价、已重建、保活', () => {
    const rows = cacheRows(sample(), { text: '已启用', color: COLOR.ok }, at(13, 20), 66)
    expect(rows.map(row => row.label)).toEqual(['命中率', '过期代价', '已重建', '保活'])
    expect(rows.every(row => cells(row.label) <= GRID.label)).toBe(true)
  })

  test('窄到放不下时各行整块折到下一行，长的保活状态逐行折下去，都不出现 …', () => {
    const stopped: Segment = { text: '已停止（续期请求出错：connect ECONNREFUSED 127.0.0.1:443）', color: COLOR.danger }
    const view = sample({ hitRate: { last: 1, session: 1 }, coldWrites: { count: 12, usd: 123.4 } })
    for (const columns of [40, 46, 50, 52, 60, 70, 90]) {
      const inner = columns - 4
      const rows = cacheRows(view, stopped, at(13, 20), inner)
      const lines = rows.flatMap(row => row.lines.map(text))
      expect(lines.join(' / '), `${columns} 列`).not.toContain('…')
      for (const line of lines) expect(cells(line) <= valueWidth(inner), `${columns} 列：${line}`).toBe(true)
      expect(lines.join(''), `${columns} 列`).toContain('本会话 100%')
      expect(lines.join('').replace(/ /g, ''), `${columns} 列`).toContain(stopped.text.replace(/ /g, ''))
      const keepalive = rows.find(row => row.key === 'keepalive')
      for (const line of keepalive?.lines ?? []) expect(line[0]?.color).toBe(COLOR.danger)
    }
  })

  test('保活状态：自动开启的五种，加上本会话手动开、手动关', () => {
    const idle = { stopped: null, renewing: false }
    const base = { settings: SETTINGS, override: null, context: 151000, loop: idle }
    expect(keepaliveStatus(base)).toEqual({ text: '已启用', color: COLOR.ok })
    expect(keepaliveStatus({ ...base, loop: { stopped: null, renewing: true } })).toEqual({ text: '进行中', color: COLOR.ok })
    expect(keepaliveStatus({ ...base, override: false })).toEqual({ text: '已关闭（本会话）', color: COLOR.muted })
    expect(keepaliveStatus({ ...base, context: 32000 })).toEqual({ text: '未启用（上下文低于 50k）', color: COLOR.muted })
    expect(keepaliveStatus({ ...base, settings: { ...SETTINGS, autoKeepalive: false } })).toEqual({
      text: '未启用（自动开启已关闭）',
      color: COLOR.muted,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'limit', reason: '空闲超过 12 小时' }, renewing: true } })).toEqual({
      text: '已停止（空闲超过 12 小时）',
      color: COLOR.muted,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'reading', reason: '续期时缓存已过期' }, renewing: false } })).toEqual({
      text: '已停止（续期时缓存已过期）',
      color: COLOR.danger,
    })
    expect(keepaliveStatus({ ...base, loop: { stopped: { kind: 'error', reason: '续期请求被中断' }, renewing: false } }).color).toBe(COLOR.danger)

    // 本会话手动开：不看自动开启和阈值；手动关：不看停下
    const manual = { ...base, override: true, context: 0, settings: { ...SETTINGS, autoKeepalive: false } }
    expect(keepaliveStatus(manual)).toEqual({ text: '已启用（本会话）', color: COLOR.ok })
    expect(keepaliveStatus({ ...manual, loop: { stopped: null, renewing: true } })).toEqual({ text: '进行中（本会话）', color: COLOR.ok })
    expect(keepaliveStatus({ ...manual, loop: { stopped: { kind: 'limit', reason: '空闲超过 12 小时' }, renewing: true } }).text).toBe(
      '已停止（空闲超过 12 小时）',
    )
    expect(keepaliveStatus({ ...base, override: false, loop: { stopped: { kind: 'error', reason: '续期请求被中断' }, renewing: false } }).text).toBe(
      '已关闭（本会话）',
    )
  })

  test('终端上画出缓存框：上边框状态、四行，各种宽度下不超宽', async ($, on) => {
    const w = engine(on, { forks: [] })
    await $.session.start(SESSION)
    await turn($)
    for (const columns of [70, 110, 52, 40]) {
      const ui = await $.ui.mount(pane(columns))
      expect(flat(await ui.find({ key: 'status:section:cache' })).trim()).toBe('● 有效 · 21:00 过期')
      for (const key of ['cache-hit', 'cache-cost', 'cache-rebuilt', 'keepalive']) {
        const row = await ui.find({ key: `row:${key}` })
        expect(row, `${columns} 列 ${key}`).toBeDefined()
        expect(row?.props.width).toBe(columns - 4)
      }
      if (columns >= 70) expect(flat(await ui.find({ key: 'row:cache-cost' }))).toBe('过期代价重建 152k tokens ≈ $1.52')
      await ui.unmount()
    }

    // 过期后（保活在 50 分钟那次停下了）：上边框改写已过期时长，重建量变红
    await w.clock.advance(2 * HOUR + 10 * MIN)
    const ui = await $.ui.mount(pane(70))
    expect(flat(await ui.find({ key: 'status:section:cache' })).trim()).toBe('○ 已过期 1h10m')
    expect(await colorOf(ui, '○ 已过期')).toBe(COLOR.danger)
    expect(await colorOf(ui, '152k tokens')).toBe(COLOR.danger)
    await ui.unmount()
  })
})
