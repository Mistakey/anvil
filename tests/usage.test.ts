import type { On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COLOR, GRID, levelColor, restWidth } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import { EMPTY_USAGE, exhaustAt, formatTokens, formatUsd, formatWhen, usageRows } from '../hooks/usage'
import type { GridRow } from '../hooks/usage'
import type { Usage } from '../types'
import { SESSION, world } from './world'

// 本地时间 2026-10-13（周二）20:00；格式化按本地时区，测试也按本地时区造时刻
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const NOW = at(13, 20)
const iso = (ms: number) => new Date(ms).toISOString()

const WORKING: Usage = {
  ...EMPTY_USAGE,
  context: { tokens: 152_000, window: 200_000, percent: 76 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: iso(at(13, 22)) },
    { kind: 'seven_day', percentUsed: 18, resetsAt: iso(at(15, 9)) },
  ],
  costUsd: 4.21,
  compactions: 1,
  lastMessageCostUsd: 0.31,
}

const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')
const restOf = (rows: GridRow[], key: string) => text(rows.find(row => row.key === key)?.rest ?? [])

// ---------------------------------------------------------------- 纯逻辑

test('四行固定顺序：5h、7d、上下文、花费', () => {
  expect(usageRows(WORKING, NOW, 66).map(row => row.label)).toEqual(['5h', '7d', '上下文', '花费'])
})

test('5h：进度条、百分比、重置时刻；按当前速度会在重置前用尽时写预计用尽时刻', () => {
  const rows = usageRows(WORKING, NOW, 66)
  // 窗口 17:00 开始，3 小时用了 62%，剩下 38% 约 1h50m 用完
  expect(restOf(rows, 'five_hour')).toBe(' 62% 22:00 重置 · 预计 21:50 用尽')
  const projected = rows[0]?.rest.at(-1)
  expect(projected?.color).toBe(COLOR.high)
})

test('5h：照这个速度到重置也用不完时，不写预计用尽', () => {
  const slow: Usage = { ...WORKING, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(at(13, 22)) }] }
  expect(restOf(usageRows(slow, NOW, 66), 'five_hour')).toBe(' 30% 22:00 重置')
  expect(exhaustAt(0, at(13, 22), 5 * 3_600_000, NOW)).toBe(null)
})

test('7d：重置时刻明天写"明天"，更远写星期；7d 不写预计用尽', () => {
  expect(restOf(usageRows(WORKING, NOW, 66), 'seven_day')).toBe(' 18% 周四 09:00 重置')
  const tomorrow: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 95, resetsAt: iso(at(14, 9)) }] }
  expect(restOf(usageRows(tomorrow, NOW, 66), 'seven_day')).toBe(' 95% 明天 09:00 重置')
})

test('窗口还没开始（没有读数，或已过重置时刻）：0% 加"发送消息后开始计时"', () => {
  const cold: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 24, resetsAt: iso(at(13, 19)) }] }
  const rows = usageRows(cold, NOW, 66)
  expect(restOf(rows, 'five_hour')).toBe('  0% 发送消息后开始计时')
  expect(restOf(rows, 'seven_day')).toBe('  0% 发送消息后开始计时')
  expect(text(rows[0]?.middle ?? [])).toBe('─'.repeat(GRID.middle))
})

test('上下文：百分比、已用 / 上限、已压缩次数；还没有读数时写 —', () => {
  expect(restOf(usageRows(WORKING, NOW, 66), 'context')).toBe(' 76% 152k / 200k · 已压缩 1 次')
  expect(restOf(usageRows(EMPTY_USAGE, NOW, 66), 'context')).toBe('   — — · 已压缩 0 次')
})

test('花费：上一条消息 · 本会话', () => {
  const row = usageRows(WORKING, NOW, 66).find(one => one.key === 'cost')
  expect(text(row?.middle ?? [])).toBe('上一条消息 $0.31')
  expect(text(row?.rest ?? [])).toBe('本会话 $4.21')
  const fresh = usageRows(EMPTY_USAGE, NOW, 66).find(one => one.key === 'cost')
  expect(text(fresh?.middle ?? [])).toBe('上一条消息 —')
})

test('进度条四档颜色：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红', () => {
  expect([0, 59, 60, 79, 80, 89, 90, 100].map(levelColor)).toEqual([
    COLOR.ok,
    COLOR.ok,
    COLOR.warn,
    COLOR.warn,
    COLOR.high,
    COLOR.high,
    COLOR.danger,
    COLOR.danger,
  ])
  const rows = usageRows(WORKING, NOW, 66)
  // 5h 62% 黄，7d 18% 绿，上下文 76% 黄；进度条和百分比同色
  expect(rows.map(row => row.middle[0]?.color).slice(0, 3)).toEqual([COLOR.warn, COLOR.ok, COLOR.warn])
  expect(rows.map(row => row.rest[0]?.color).slice(0, 3)).toEqual([COLOR.warn, COLOR.ok, COLOR.warn])
})

test('进度条占满中间 18 格，已用部分按比例', () => {
  const [five] = usageRows(WORKING, NOW, 66)
  expect(cells(text(five?.middle ?? []))).toBe(18)
  expect(five?.middle[0]?.text).toBe('━'.repeat(11))
})

test('各种宽度下每列都不超出自己的格数；请求宽度和更宽时不截断', () => {
  const busy: Usage = { ...WORKING, costUsd: 1234.5, lastMessageCostUsd: 123.4, compactions: 12 }
  for (const columns of [30, 40, 50, 60, 70, 90, 120]) {
    const inner = columns - 4
    for (const row of usageRows(busy, NOW, inner)) {
      expect(cells(row.label) <= GRID.label, `${columns} 列 ${row.key} 标签`).toBe(true)
      expect(cells(text(row.middle)) <= GRID.middle, `${columns} 列 ${row.key} 中间`).toBe(true)
      expect(cells(text(row.rest)) <= restWidth(inner), `${columns} 列 ${row.key} 其余`).toBe(true)
      if (columns >= 70) expect(text(row.rest), `${columns} 列 ${row.key}`).not.toContain('…')
    }
  }
})

test('格式：token、金额、时刻', () => {
  expect([formatTokens(999), formatTokens(152_000), formatTokens(1_000_000), formatTokens(1_250_000)]).toEqual(['999', '152k', '1M', '1.3M'])
  expect([formatUsd(0.314), formatUsd(4.2), formatUsd(123.4)]).toEqual(['$0.31', '$4.20', '$123'])
  expect(formatWhen(at(13, 21, 5), NOW)).toBe('21:05')
})

// ---------------------------------------------------------------- 读数的收集与绘制

const READING: SessionUsage = {
  startedAt: 0,
  context: { tokens: 152_000, window: 200_000, percent: 76 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: iso(at(13, 22)) },
    { kind: 'seven_day', percentUsed: 18, resetsAt: iso(at(15, 9)) },
  ],
  cost: { usd: 3.9 },
}

const pane = (bodyColumns: number) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: {
    title: 'anvil',
    isFocused: false,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 48 },
    view: {},
  },
})

const SUMMARY = [{ role: 'user' as const, text: '摘要', toolUses: [] }]

function engine(on: On) {
  mock.clock(on, { now: NOW })
  const reading = { current: READING }
  world(on, { reading })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return reading
}

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

test('一轮的花费是开始和结束两次读数之差；压缩次数只数主会话真正压缩的', async ($, on) => {
  const reading = engine(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: '继续', turnId: 't1' })
  reading.current = { ...READING, cost: { usd: 4.21 } }
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  // 子 agent 的一轮不算上一条消息
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: SUMMARY })

  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'row:cost' }))).toBe('花费上一条消息 $0.31本会话 $4.21')
  expect(flat(await ui.find({ key: 'row:context' }))).toContain('已压缩 1 次')
  await ui.unmount()
})

test('session.measure 的新读数进用量框', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.session.measure({
    context: { tokens: 184_000, window: 200_000, percent: 92 },
    rateLimits: READING.rateLimits,
    cost: { usd: 5 },
    changed: ['context', 'cost'],
  })

  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'row:context' }))).toContain('92% 184k / 200k')
  expect(flat(await ui.find({ key: 'row:cost' }))).toContain('本会话 $5.00')
  await ui.unmount()
})

test('终端上，约 70 列和拖宽、拖窄后：六个区块按顺序、用量框四行齐全且不超宽', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [70, 110, 90, 52, 40]) {
    const ui = await $.ui.mount(pane(columns))
    const titles = (await ui.findAll({ key: undefined, type: 'Text' }))
      .map(one => one.text.trim())
      .filter(one => /^\S+ (我的消息|自动模式拒绝|子 agent|用量|缓存)$/.test(one))
    expect(titles.map(one => one.replace(/^\S+ /, ''))).toEqual(['我的消息', '自动模式拒绝', '子 agent', '用量', '缓存'])

    const inner = columns - 4
    for (const key of ['five_hour', 'seven_day', 'context', 'cost']) {
      const row = await ui.find({ key: `row:${key}` })
      expect(row, `${columns} 列 ${key}`).toBeDefined()
      expect(row?.props.width).toBe(inner)
    }
    const five = flat(await ui.find({ key: 'row:five_hour' }))
    if (columns >= 70) expect(five).toContain('预计 21:50 用尽')
    await ui.unmount()
  }
})

test('窗口还没开始时用量框写"发送消息后开始计时"', async ($, on) => {
  const reading = engine(on)
  reading.current = { ...READING, rateLimits: [] }
  await $.session.start(SESSION)

  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'row:five_hour' }))).toContain('0% 发送消息后开始计时')
  await ui.unmount()
})
