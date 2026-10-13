import type { On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COLOR, FIELD, GRID, barWidth, levelColor, valueWidth } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import { EMPTY_USAGE, exhaustAt, formatReset, formatTokens, formatUsd, formatWhen, projectedPercent, usageRows } from '../hooks/usage'
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
}

const INNER = 66
const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')
const rowOf = (rows: GridRow[], key: string) => rows.find(row => row.key === key)
/** 第一行：进度条和百分比（花费是金额） */
const firstOf = (rows: GridRow[], key: string) => text(rowOf(rows, key)?.lines[0] ?? [])
/** 第二行起的细节，折下去的几行用 " / " 连起来 */
const detailOf = (rows: GridRow[], key: string) => (rowOf(rows, key)?.lines.slice(1) ?? []).map(text).join(' / ')
/** 进度条：按框内宽度定长，已用部分按比例 */
const barText = (percent: number, inner = INNER) => {
  const width = barWidth(inner)
  const filled = Math.round((percent / 100) * width)
  return `${'━'.repeat(filled)}${'─'.repeat(width - filled)}`
}

// ---------------------------------------------------------------- 纯逻辑

test('四项固定顺序：5h、7d、上下文、花费；名称一列暗色', () => {
  const rows = usageRows(WORKING, NOW, INNER)
  expect(rows.map(row => text(row.label))).toEqual(['5h', '7d', '上下文', '花费'])
  expect(rows.every(row => row.label.every(one => one.color === COLOR.label))).toBe(true)
  expect(rows.every(row => row.labelWidth === GRID.label)).toBe(true)
})

test('5h：第一行进度条、百分比；第二行 ↻ 重置时刻，会在重置前用尽时接红字"· 预计 HH:MM 用尽"', () => {
  const rows = usageRows(WORKING, NOW, INNER)
  expect(firstOf(rows, 'five_hour')).toBe(`${barText(62)}  62%`)
  // 窗口 17:00 开始，3 小时用了 62%，剩下 38% 约 1h50m 用完
  expect(detailOf(rows, 'five_hour')).toBe('↻ 22:00 · 预计 21:50 用尽')
  const detail = rowOf(rows, 'five_hour')?.lines[1] ?? []
  expect(detail[0]).toEqual({ text: '↻ 22:00', color: COLOR.label })
  expect(detail.slice(1).every(one => one.color === COLOR.danger)).toBe(true)
})

test('照这个速度到重置也用不完时，第二行 ↻ 重置时刻后接暗色"· 预计用到 N%"', () => {
  // 窗口 17:00 开始，3 小时用了 30%，到 22:00 重置时用到 50%
  const slow: Usage = { ...WORKING, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(at(13, 22)) }] }
  const rows = usageRows(slow, NOW, INNER)
  expect(firstOf(rows, 'five_hour')).toBe(`${barText(30)}  30%`)
  expect(detailOf(rows, 'five_hour')).toBe('↻ 22:00 · 预计用到 50%')
  expect(rowOf(rows, 'five_hour')?.lines[1]?.every(one => one.color === COLOR.label)).toBe(true)
  expect(exhaustAt(0, at(13, 22), 5 * 3_600_000, NOW)).toBe(null)
})

test('窗口刚开始也照常推算，不设等待期；还没用时写"预计用到 0%"', () => {
  // 窗口 19:50 开始，10 分钟用了 2%，按这个速度 5 小时用到 60%
  const early: Usage = { ...WORKING, rateLimits: [{ kind: 'five_hour', percentUsed: 2, resetsAt: iso(at(14, 0, 50)) }] }
  expect(detailOf(usageRows(early, NOW, INNER), 'five_hour')).toBe('↻ 00:50 明天 · 预计用到 60%')
  // 10 分钟用了 4%：120% 会用尽
  const fast: Usage = { ...WORKING, rateLimits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: iso(at(14, 0, 50)) }] }
  expect(detailOf(usageRows(fast, NOW, INNER), 'five_hour')).toBe('↻ 00:50 明天 · 预计 明天 00:00 用尽')
  const idle: Usage = { ...WORKING, rateLimits: [{ kind: 'five_hour', percentUsed: 0, resetsAt: iso(at(13, 22)) }] }
  expect(detailOf(usageRows(idle, NOW, INNER), 'five_hour')).toBe('↻ 22:00 · 预计用到 0%')
  expect(projectedPercent(30, at(13, 22), 5 * 3_600_000, NOW)).toBe(50)
})

test('7d：重置时刻时间在前（↻ 09:00 周四、↻ 09:00 明天）；7d 也写预计', () => {
  // 窗口 10/8 09:00 开始，131 小时用了 18%，到重置时用到 23%
  expect(detailOf(usageRows(WORKING, NOW, INNER), 'seven_day')).toBe('↻ 09:00 周四 · 预计用到 23%')
  // 窗口 10/7 09:00 开始，155 小时用了 95%，剩下 5% 约 8 小时用完
  const tomorrow: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 95, resetsAt: iso(at(14, 9)) }] }
  expect(detailOf(usageRows(tomorrow, NOW, INNER), 'seven_day')).toBe('↻ 09:00 明天 · 预计 明天 04:09 用尽')
  // 周一 17:00 重置，按当前速度周四 09:00 用尽（窗口 10/12 17:00 开始，27 小时用了 42.1875%）
  const fast: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 42.1875, resetsAt: iso(at(19, 17)) }] }
  const rows = usageRows(fast, NOW, INNER)
  expect(firstOf(rows, 'seven_day')).toBe(`${barText(42.1875)}  42%`)
  expect(detailOf(rows, 'seven_day')).toBe('↻ 17:00 周一 · 预计 周四 09:00 用尽')
})

test('窗口还没开始（没有读数，或已过重置时刻）：0%，第二行"发送消息后开始计时"', () => {
  const cold: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 24, resetsAt: iso(at(13, 19)) }] }
  const rows = usageRows(cold, NOW, INNER)
  for (const key of ['five_hour', 'seven_day']) {
    expect(firstOf(rows, key)).toBe(`${barText(0)}   0%`)
    expect(detailOf(rows, key)).toBe('发送消息后开始计时')
  }
})

test('上下文：第一行进度条、百分比，第二行已用 / 上限；还没有读数时写 —', () => {
  const rows = usageRows(WORKING, NOW, INNER)
  expect(firstOf(rows, 'context')).toBe(`${barText(76)}  76%`)
  expect(detailOf(rows, 'context')).toBe('152k / 200k')
  const small: Usage = { ...WORKING, context: { tokens: 49_000, window: 1_000_000, percent: 5 } }
  expect(firstOf(usageRows(small, NOW, INNER), 'context')).toBe(`${barText(5)}   5%`)
  expect(detailOf(usageRows(small, NOW, INNER), 'context')).toBe('49k / 1M')
  expect(firstOf(usageRows(EMPTY_USAGE, NOW, INNER), 'context')).toBe(`${barText(0)}    —`)
  expect(detailOf(usageRows(EMPTY_USAGE, NOW, INNER), 'context')).toBe('—')
  const windowOnly: Usage = { ...EMPTY_USAGE, context: { window: 1_000_000 } }
  expect(detailOf(usageRows(windowOnly, NOW, INNER), 'context')).toBe('— / 1M')
})

test('花费：只有本会话总额一行', () => {
  expect(rowOf(usageRows(WORKING, NOW, INNER), 'cost')?.lines.map(text)).toEqual(['$4.21'])
  expect(rowOf(usageRows(EMPTY_USAGE, NOW, INNER), 'cost')?.lines.map(text)).toEqual(['—'])
})

test('第二行的细节都暗色（预计用尽除外）；不写"本会话""上一条""压缩""≈"', () => {
  // 7d 用不完：预计用到也是暗色
  const rows = usageRows(WORKING, NOW, INNER)
  for (const key of ['seven_day', 'context']) {
    const detail = rowOf(rows, key)?.lines[1] ?? []
    expect(detail.length > 0 && detail.every(one => one.color === COLOR.label), key).toBe(true)
  }
  const all = rows.flatMap(row => row.lines.map(text)).join('\n')
  for (const word of ['本会话', '上一条', '压缩', '≈']) expect(all).not.toContain(word)
})

test('三条进度条一样长、百分比上下对齐，数字变长变短不挪位置', () => {
  for (const inner of [36, 44, 47, 66, 86]) {
    for (const percent of [0, 9, 62, 100]) {
      const usage: Usage = {
        ...WORKING,
        context: { tokens: 9_000, window: 1_000_000, percent },
        rateLimits: [
          { kind: 'five_hour', percentUsed: percent, resetsAt: iso(at(13, 22)) },
          { kind: 'seven_day', percentUsed: 18, resetsAt: iso(at(15, 9)) },
        ],
      }
      const rows = usageRows(usage, NOW, inner)
      for (const key of ['five_hour', 'seven_day', 'context']) {
        const line = firstOf(rows, key)
        // 进度条一样长，百分比右对齐在同一列
        expect(cells(line), `${inner} 格 ${percent}% ${key}：${line}`).toBe(barWidth(inner) + 1 + FIELD.percent)
        expect([...line].slice(0, barWidth(inner)).join(''), `${inner} 格 ${key}`).toMatch(/^[━─]+$/)
      }
    }
  }
})

test('进度条加长：值那一列除了百分比都给进度条，右边留一格', () => {
  // 用户的终稿：框 48 列（框内 44 格）时进度条 30 格
  expect(barWidth(44)).toBe(30)
  expect(barWidth(47)).toBe(33)
  expect(barWidth(66)).toBe(valueWidth(66) - FIELD.percent - 2)
})

test('进度条四档颜色：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红；百分比同色', () => {
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
  const rows = usageRows(WORKING, NOW, INNER)
  const colorOf = (key: string, part: string) => rowOf(rows, key)?.lines[0]?.find(one => one.text.includes(part))?.color
  expect([colorOf('five_hour', '━'), colorOf('five_hour', '%'), colorOf('seven_day', '━'), colorOf('seven_day', '%'), colorOf('context', '%')]).toEqual([
    COLOR.warn,
    COLOR.warn,
    COLOR.ok,
    COLOR.ok,
    COLOR.warn,
  ])
})

// 面板可能停靠的宽度：请求的 70 列，开着别的面板（带页签）时更窄，拖宽后更宽
const WIDTHS = [40, 44, 48, 50, 51, 52, 56, 60, 66, 70, 90, 120]

test('各种宽度下每行都不超出值那一列，放不下的整块折到下一行，不出现 …', () => {
  const busy: Usage = {
    ...WORKING,
    costUsd: 1234.5,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 62, resetsAt: iso(at(13, 22)) },
      { kind: 'seven_day', percentUsed: 42.1875, resetsAt: iso(at(19, 17)) },
    ],
  }
  for (const columns of [30, ...WIDTHS]) {
    const inner = columns - 4
    const rows = usageRows(busy, NOW, inner)
    for (const row of rows) {
      expect(cells(text(row.label)) <= GRID.label, `${columns} 列 ${row.key} 名称`).toBe(true)
      for (const line of row.lines) expect(cells(text(line)) <= valueWidth(inner), `${columns} 列 ${row.key}`).toBe(true)
      if (columns >= 40) expect(row.lines.map(text).join(' / '), `${columns} 列 ${row.key}`).not.toContain('…')
    }
    if (columns >= 40) {
      expect(detailOf(rows, 'seven_day'), `${columns} 列`).toContain('↻ 17:00 周一')
      expect(detailOf(rows, 'seven_day'), `${columns} 列`).toContain('预计 周四 09:00 用尽')
      expect(detailOf(rows, 'five_hour'), `${columns} 列`).toContain('预计 21:50 用尽')
    }
  }
  // 约 51 列停靠（框内 47 格）：7d 的重置和预计用尽在第二行一行排完
  expect(rowOf(usageRows(busy, NOW, 47), 'seven_day')?.lines).toHaveLength(2)
})

test('格式：token、金额、时刻、重置时刻', () => {
  expect([formatTokens(999), formatTokens(152_000), formatTokens(999_600), formatTokens(1_000_000), formatTokens(1_250_000)]).toEqual([
    '999',
    '152k',
    '1M',
    '1M',
    '1.3M',
  ])
  expect([formatUsd(0.314), formatUsd(4.2), formatUsd(123.4)]).toEqual(['$0.31', '$4.20', '$123'])
  expect(formatWhen(at(13, 21, 5), NOW)).toBe('21:05')
  expect([formatReset(at(13, 23), NOW), formatReset(at(14, 1, 30), NOW), formatReset(at(19, 17), NOW)]).toEqual(['23:00', '01:30 明天', '17:00 周一'])
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

test('花费取引擎报的会话总额，一轮结束、压缩之后都只写总额', async ($, on) => {
  const reading = engine(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: '继续', turnId: 't1' })
  reading.current = { ...READING, cost: { usd: 4.21 } }
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })

  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'row:cost' }))).toBe('花费$4.21')
  expect(flat(await ui.find({ key: 'section:usage' }))).not.toContain('压缩')
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
  expect(flat(await ui.find({ key: 'row:context' }))).toContain(' 92%')
  expect(flat(await ui.find({ key: 'row:context:2' }))).toBe('184k / 200k')
  expect(flat(await ui.find({ key: 'row:cost' }))).toContain('$5.00')
  await ui.unmount()
})

test('终端上，约 70 列和拖宽、拖窄后：用量框每项两行（花费一行）、名称一列定宽且暗色、不超宽', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [70, 110, 90, 51, 40]) {
    const ui = await $.ui.mount(pane(columns))
    const inner = columns - 4
    for (const key of ['five_hour', 'five_hour:2', 'seven_day', 'seven_day:2', 'context', 'context:2', 'cost']) {
      const row = await ui.find({ key: `row:${key}` })
      expect(row, `${columns} 列 ${key}`).toBeDefined()
      expect(row?.props.width).toBe(inner)
      // 名称一列定宽，值从同一列起；第二行名称那一列空着
      expect((row?.children[0] as { props?: { width?: number } } | undefined)?.props?.width, `${columns} 列 ${key}`).toBe(GRID.label)
    }
    expect(await ui.find({ key: 'row:cost:2' })).toBeUndefined()
    const name = (await ui.findAll({ type: 'Text' })).filter(one => one.text === '上下文').at(-1)
    expect(name?.props.color).toBe(COLOR.label)
    expect(flat(await ui.find({ key: 'row:five_hour:2' }))).toBe('↻ 22:00 · 预计 21:50 用尽')
    expect(flat(await ui.find({ key: 'section:usage' }))).not.toContain('…')
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

test('窗口还没开始时用量框第二行写"发送消息后开始计时"', async ($, on) => {
  const reading = engine(on)
  reading.current = { ...READING, rateLimits: [] }
  await $.session.start(SESSION)

  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'row:five_hour' }))).toContain('0%')
  expect(flat(await ui.find({ key: 'row:five_hour:2' }))).toBe('发送消息后开始计时')
  await ui.unmount()
})

test('终端上（框内约 50、70 格）：5h 会用尽写红字"预计 HH:MM 用尽"，7d 用不完写暗色"预计用到 N%"', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [54, 74]) {
    const ui = await $.ui.mount(pane(columns))
    expect(flat(await ui.find({ key: 'row:five_hour:2' })), `${columns} 列`).toBe('↻ 22:00 · 预计 21:50 用尽')
    expect(flat(await ui.find({ key: 'row:seven_day:2' })), `${columns} 列`).toBe('↻ 09:00 周四 · 预计用到 23%')
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(one => one.text === '预计 21:50 用尽').at(-1)?.props.color).toBe(COLOR.danger)
    expect(texts.filter(one => one.text === '预计用到 23%').at(-1)?.props.color).toBe(COLOR.label)
    expect(flat(await ui.find({ key: 'section:usage' }))).not.toContain('…')
    await ui.unmount()
  }
})
