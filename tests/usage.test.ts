import type { On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COLOR, GRID, levelColor, valueWidth } from '../hooks/style'
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
/** 一行的值，连同折下去的几行用 " / " 连起来 */
const valueOf = (rows: GridRow[], key: string) => (rows.find(row => row.key === key)?.lines ?? []).map(text).join(' / ')
/** 进度条：已用 filled 格，其余是底 */
const barText = (filled: number) => `${'━'.repeat(filled)}${'─'.repeat(GRID.bar - filled)}`

// ---------------------------------------------------------------- 纯逻辑

test('四行固定顺序：5h、7d、上下文、花费', () => {
  expect(usageRows(WORKING, NOW, 66).map(row => row.label)).toEqual(['5h', '7d', '上下文', '花费'])
})

test('5h：进度条、百分比、↻ 重置时刻；按当前速度会在重置前用尽时写预计用尽时刻', () => {
  const rows = usageRows(WORKING, NOW, 66)
  // 窗口 17:00 开始，3 小时用了 62%，剩下 38% 约 1h50m 用完
  expect(valueOf(rows, 'five_hour')).toBe(`${barText(9)}  62%  ↻ 22:00  预计 21:50 用尽`)
  const projected = rows[0]?.lines[0]?.at(-1)
  expect(projected?.color).toBe(COLOR.high)
})

test('5h：照这个速度到重置也用不完时，不写预计用尽', () => {
  const slow: Usage = { ...WORKING, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(at(13, 22)) }] }
  expect(valueOf(usageRows(slow, NOW, 66), 'five_hour')).toBe(`${barText(5)}  30%  ↻ 22:00`)
  expect(exhaustAt(0, at(13, 22), 5 * 3_600_000, NOW)).toBe(null)
})

test('7d：重置时刻明天写"明天"，更远写星期；7d 不写预计用尽', () => {
  expect(valueOf(usageRows(WORKING, NOW, 66), 'seven_day')).toBe(`${barText(3)}  18%  ↻ 周四 09:00`)
  const tomorrow: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 95, resetsAt: iso(at(14, 9)) }] }
  expect(valueOf(usageRows(tomorrow, NOW, 66), 'seven_day')).toBe(`${barText(14)}  95%  ↻ 明天 09:00`)
})

test('窗口还没开始（没有读数，或已过重置时刻）：0% 加"发送消息后开始计时"', () => {
  const cold: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 24, resetsAt: iso(at(13, 19)) }] }
  const rows = usageRows(cold, NOW, 66)
  expect(valueOf(rows, 'five_hour')).toBe(`${barText(0)}   0%  发送消息后开始计时`)
  expect(valueOf(rows, 'seven_day')).toBe(`${barText(0)}   0%  发送消息后开始计时`)
})

test('上下文：已用 / 上限、百分比、压缩次数；还没有读数时写 —', () => {
  expect(valueOf(usageRows(WORKING, NOW, 66), 'context')).toBe('152k / 200k  76%  压缩 1 次')
  const small: Usage = { ...WORKING, context: { tokens: 49_000, window: 1_000_000, percent: 5 }, compactions: 0 }
  expect(valueOf(usageRows(small, NOW, 66), 'context')).toBe('49k / 1M    5%  压缩 0 次')
  expect(valueOf(usageRows(EMPTY_USAGE, NOW, 66), 'context')).toBe('—  压缩 0 次')
  const windowOnly: Usage = { ...EMPTY_USAGE, context: { window: 1_000_000 } }
  expect(valueOf(usageRows(windowOnly, NOW, 66), 'context')).toBe('— / 1M  压缩 0 次')
})

test('花费：本会话在前、上一条在后，不写"本会话"', () => {
  expect(valueOf(usageRows(WORKING, NOW, 66), 'cost')).toBe('$4.21   上一条 $0.31')
  expect(valueOf(usageRows(EMPTY_USAGE, NOW, 66), 'cost')).toBe('—       上一条 —')
})

test('主次：主值正常亮度在前；上一条、↻ 重置时刻、压缩次数暗色；四行都不写"本会话"', () => {
  const rows = usageRows(WORKING, NOW, 66)
  for (const row of rows) expect(valueOf([row], row.key), row.key).not.toContain('本会话')
  const segmentsOf = (key: string) => rows.find(row => row.key === key)?.lines.flat() ?? []
  const colorsOf = (key: string, from: string) => {
    const list = segmentsOf(key)
    const start = list.findIndex(one => one.text.includes(from))
    return list.slice(start).filter(one => one.text.trim() !== '').map(one => one.color)
  }
  expect(colorsOf('cost', '上一条')).toEqual([COLOR.label])
  expect(segmentsOf('cost')[0]).toEqual({ text: '$4.21 ' })
  expect(colorsOf('five_hour', '↻')[0]).toBe(COLOR.label)
  expect(colorsOf('context', '压缩')).toEqual([COLOR.label])
})

test('数值定宽：百分比 9% 到 100%、金额 $0.02 到 $12.34、tokens 9k 到 152k，同一行后面的字不挪位置', () => {
  const after = (usage: Usage, key: string, marker: string) => valueOf(usageRows(usage, NOW, 66), key).indexOf(marker)
  const limits = (percent: number): Usage => ({
    ...WORKING,
    rateLimits: [
      { kind: 'five_hour', percentUsed: percent, resetsAt: iso(at(13, 22)) },
      { kind: 'seven_day', percentUsed: percent, resetsAt: iso(at(15, 9)) },
    ],
  })
  expect(after(limits(9), 'five_hour', '↻')).toBe(after(limits(100), 'five_hour', '↻'))
  expect(after(limits(9), 'seven_day', '↻')).toBe(after(limits(100), 'seven_day', '↻'))
  const context = (tokens: number, percent: number): Usage => ({ ...WORKING, context: { tokens, window: 1_000_000, percent } })
  expect(after(context(9_000, 9), 'context', '压缩')).toBe(after(context(152_000, 100), 'context', '压缩'))
  expect(after(context(9_000, 1), 'context', '压缩')).toBe(after(context(1_000_000, 100), 'context', '压缩'))
  expect(after(context(9_000, 1), 'context', '%')).toBe(after(context(152_000, 10), 'context', '%'))
  const cost = (usd: number): Usage => ({ ...WORKING, costUsd: usd, lastMessageCostUsd: 0.02 })
  expect(after(cost(0.02), 'cost', '上一条')).toBe(after(cost(12.34), 'cost', '上一条'))
  expect(after(cost(0.02), 'cost', '上一条')).toBe(after(cost(1234.5), 'cost', '上一条'))
  expect(after({ ...WORKING, costUsd: null }, 'cost', '上一条')).toBe(after(cost(0.02), 'cost', '上一条'))
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
  // 5h 62% 黄，7d 18% 绿：进度条和百分比同色；上下文 76% 的百分比黄
  const colorOf = (key: string, part: string) => rows.find(row => row.key === key)?.lines[0]?.find(one => one.text.includes(part))?.color
  expect([colorOf('five_hour', '━'), colorOf('five_hour', '%'), colorOf('seven_day', '━'), colorOf('seven_day', '%')]).toEqual([
    COLOR.warn,
    COLOR.warn,
    COLOR.ok,
    COLOR.ok,
  ])
  expect(colorOf('context', '%')).toBe(COLOR.warn)
})

test('进度条定宽 15 格，已用部分按比例', () => {
  const [five] = usageRows(WORKING, NOW, 66)
  const bar = (five?.lines[0] ?? []).filter(one => /^[━─]+$/.test(one.text))
  expect(cells(text(bar))).toBe(GRID.bar)
  expect(bar[0]?.text).toBe('━'.repeat(9))
})

// 面板可能停靠的宽度：请求的 70 列，开着别的面板（带页签）时更窄，拖宽后更宽
const WIDTHS = [40, 44, 48, 50, 52, 56, 60, 66, 70, 90, 120]

test('各种宽度下每行都不超出值那一列，放不下的整块折到下一行，不出现 …', () => {
  const busy: Usage = { ...WORKING, costUsd: 1234.5, lastMessageCostUsd: 123.4, compactions: 12 }
  for (const columns of [30, ...WIDTHS]) {
    const inner = columns - 4
    for (const row of usageRows(busy, NOW, inner)) {
      expect(cells(row.label) <= GRID.label, `${columns} 列 ${row.key} 名称`).toBe(true)
      for (const line of row.lines) expect(cells(text(line)) <= valueWidth(inner), `${columns} 列 ${row.key}`).toBe(true)
      if (columns >= 40) expect(valueOf([row], row.key), `${columns} 列 ${row.key}`).not.toContain('…')
    }
  }
})

test('窄到放不下时 7d 带星期的重置时刻、压缩次数、预计用尽、上一条花费都完整折到下一行', () => {
  // 用户实测（.22）：7d 写成"周一 17:00 重…"，上下文写成"5% 48k / 1M · 已…"
  const narrow: Usage = {
    ...WORKING,
    context: { tokens: 48_000, window: 1_000_000, percent: 5 },
    rateLimits: [...WORKING.rateLimits.filter(one => one.kind === 'five_hour'), { kind: 'seven_day', percentUsed: 18, resetsAt: iso(at(19, 17)) }],
  }
  for (const columns of WIDTHS) {
    const rows = usageRows(narrow, NOW, columns - 4)
    const joined = (key: string) => valueOf(rows, key)
    expect(joined('seven_day'), `${columns} 列`).toContain('↻ 周一 17:00')
    expect(joined('five_hour'), `${columns} 列`).toContain('预计 21:50 用尽')
    expect(joined('context'), `${columns} 列`).toContain('48k / 1M    5%')
    expect(joined('context'), `${columns} 列`).toContain('压缩 1 次')
    expect(joined('cost'), `${columns} 列`).toContain('上一条 $0.31')
  }
  // 约 51 列停靠（框内 47 格，值那一列 39 格）：带星期的重置时刻也排在同一行，只有预计用尽折下去
  const docked = usageRows(narrow, NOW, 47)
  expect(docked.find(row => row.key === 'seven_day')?.lines).toHaveLength(1)
  expect(valueOf(docked, 'five_hour')).toBe(`${barText(9)}  62%  ↻ 22:00 / 预计 21:50 用尽`)
  // 70 列：一行排完，不折
  expect(usageRows(narrow, NOW, 66).every(row => row.lines.length === 1)).toBe(true)
})

test('格式：token、金额、时刻', () => {
  expect([formatTokens(999), formatTokens(152_000), formatTokens(999_600), formatTokens(1_000_000), formatTokens(1_250_000)]).toEqual([
    '999',
    '152k',
    '1M',
    '1M',
    '1.3M',
  ])
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
  expect(flat(await ui.find({ key: 'row:cost' }))).toBe('花费$4.21   上一条 $0.31')
  expect(flat(await ui.find({ key: 'row:context' }))).toContain('压缩 1 次')
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
  expect(flat(await ui.find({ key: 'row:context' }))).toContain('184k / 200k  92%')
  expect(flat(await ui.find({ key: 'row:cost' }))).toContain('$5.00')
  await ui.unmount()
})

test('终端上，约 70 列和拖宽、拖窄后：用量框四行齐全、名称一列定宽且暗色、不超宽', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [70, 110, 90, 52, 40]) {
    const ui = await $.ui.mount(pane(columns))
    const inner = columns - 4
    for (const key of ['five_hour', 'seven_day', 'context', 'cost']) {
      const row = await ui.find({ key: `row:${key}` })
      expect(row, `${columns} 列 ${key}`).toBeDefined()
      expect(row?.props.width).toBe(inner)
      // 名称一列定宽，值从同一列起
      expect((row?.children[0] as { props?: { width?: number } } | undefined)?.props?.width, `${columns} 列 ${key}`).toBe(GRID.label)
    }
    const name = (await ui.findAll({ type: 'Text' })).find(one => one.text === '上下文')
    expect(name?.props.color).toBe(COLOR.label)
    const five = flat(await ui.find({ key: 'row:five_hour' }))
    if (columns >= 70) expect(five).toContain('预计 21:50 用尽')
    await ui.unmount()
  }
})

test('终端上，比请求的 70 列窄时：用量框、缓存框不截断，折下去的行接在本行下面', async ($, on) => {
  const reading = engine(on)
  reading.current = {
    ...READING,
    context: { tokens: 48_000, window: 1_000_000, percent: 5 },
    rateLimits: [READING.rateLimits[0]!, { kind: 'seven_day', percentUsed: 18, resetsAt: iso(at(19, 17)) }],
  }
  await $.session.start(SESSION)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  for (const columns of [40, 46, 50, 52, 60, 70, 90]) {
    const ui = await $.ui.mount(pane(columns))
    for (const id of ['usage', 'cache']) {
      const section = flat(await ui.find({ key: `section:${id}` }))
      expect(section, `${columns} 列 ${id}`).not.toContain('…')
    }
    const usage = flat(await ui.find({ key: 'section:usage' }))
    expect(usage, `${columns} 列`).toContain('↻ 周一 17:00')
    expect(usage, `${columns} 列`).toContain('压缩 1 次')
    expect(usage, `${columns} 列`).toContain('预计 21:50 用尽')
    // 折下去的行各是一行，宽度和框内一样
    const inner = columns - 4
    const keys = ['five_hour', 'seven_day', 'context', 'cost'].flatMap(key => [2, 3, 4].map(line => `row:${key}:${line}`))
    const wrapped = (await Promise.all(keys.map(key => ui.find({ key })))).filter(one => one !== undefined)
    for (const one of wrapped) expect(one.props.width).toBe(inner)
    if (columns <= 52) expect(wrapped.length > 0, `${columns} 列有折行`).toBe(true)
    if (columns >= 70) expect(wrapped).toHaveLength(0)
    await ui.unmount()
  }
})

test('还没有请求时缓存框上边框右侧什么都不画（不留空格）', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount(pane(52))
  expect(await ui.find({ key: 'status:section:cache' })).toBeUndefined()
  await ui.unmount()
})

test('窗口还没开始时用量框写"发送消息后开始计时"', async ($, on) => {
  const reading = engine(on)
  reading.current = { ...READING, rateLimits: [] }
  await $.session.start(SESSION)

  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'row:five_hour' }))).toContain('0%  发送消息后开始计时')
  await ui.unmount()
})
