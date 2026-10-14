import type { On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COLOR, FIELD, GRID, barWidth, levelColor, valueWidth } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import { EMPTY_USAGE, burnRate, formatTokens, formatUsd, formatWhen, usageRows } from '../hooks/usage'
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

test('四项固定顺序：5h、7d、上下文、花费；名称一列次要色', () => {
  const rows = usageRows(WORKING, NOW, INNER)
  expect(rows.map(row => text(row.label))).toEqual(['5h', '7d', '上下文', '花费'])
  expect(rows.every(row => row.label.every(one => one.color === COLOR.secondary))).toBe(true)
  expect(rows.every(row => row.labelWidth === GRID.label)).toBe(true)
})

// 第二行两列的图标（Nerd Font）
const RESET = '\u{F0450}'
const FINE = '\u{F0079}'
const ALERT = '\u{F0083}'
const EMPTY = '\u{F008E}'

/** 第二行两列：左列"󰑐 重置时刻"按最长的"󰑐 00:00 00-00"（13 格，图标 1 格）留宽，列间 2 格，右列预测图标 */
const two = (reset: string, forecast: string) => `${RESET} ${reset}${' '.repeat(11 - reset.length)}  ${forecast}`
const lineAt = (rows: GridRow[], key: string) => rowOf(rows, key)?.lines[1] ?? []
const limitsOf = (...rateLimits: Usage['rateLimits']): Usage => ({ ...WORKING, rateLimits })

test('5h：第一行进度条、百分比；第二行两列："󰑐 重置时刻"（图标图标色、时刻次要色），会用完时红"󰂃 用完时刻"', () => {
  const rows = usageRows(WORKING, NOW, INNER)
  expect(firstOf(rows, 'five_hour')).toBe(`${barText(62)}  62%`)
  // 窗口 17:00 开始，3 小时用了 62%，按这个速度 4 小时 50 分钟用完：21:50
  expect(detailOf(rows, 'five_hour')).toBe(two('22:00', `${ALERT} 21:50`))
  const detail = lineAt(rows, 'five_hour')
  // 图标用图标色，时刻是次要文字
  expect(detail.slice(0, 2)).toEqual([
    { text: `${RESET} `, color: COLOR.icon },
    { text: '22:00      ', color: COLOR.secondary },
  ])
  expect(detail.slice(2).filter(one => one.text.trim() !== '')).toEqual([{ text: `${ALERT} 21:50`, color: COLOR.danger }])
})

test('没有存档时预测按窗口平均的速度外推：用不完绿色"󰁹 用完时刻"；会用完红色"󰂃 用完时刻"', () => {
  // 窗口 18:00 开始，2 小时用了 18.4%，到 23:00 重置时用到 46%；按这个速度 8 小时 52 分钟用完，10-14 04:52
  const slow = usageRows(limitsOf({ kind: 'five_hour', percentUsed: 18.4, resetsAt: iso(at(13, 23)) }), NOW, INNER)
  expect(detailOf(slow, 'five_hour')).toBe(two('23:00', `${FINE} 04:52 10-14`))
  // 好状态只给图标上色，时刻和重置时刻一样是次要色
  expect(lineAt(slow, 'five_hour').slice(-2)).toEqual([{ text: `${FINE} `, color: COLOR.ok }, { text: '04:52 10-14', color: COLOR.secondary }])
  // 当天用完、晚于重置：窗口 16:00 开始，4 小时用了 60%，22:40 用完，重置是 21:00
  const today = usageRows(limitsOf({ kind: 'five_hour', percentUsed: 60, resetsAt: iso(at(13, 21)) }), NOW, INNER)
  expect(lineAt(today, 'five_hour').slice(-2)).toEqual([{ text: `${FINE} `, color: COLOR.ok }, { text: '22:40', color: COLOR.secondary }])
  // 7d 窗口 10-12 17:00 开始，27 小时用了 128 × 27 / 168 %：131 小时 15 分钟用完，10-18 04:15
  const fast = usageRows(limitsOf({ kind: 'seven_day', percentUsed: (128 * 27) / 168, resetsAt: iso(at(19, 17)) }), NOW, INNER)
  expect(firstOf(fast, 'seven_day')).toBe(`${barText((128 * 27) / 168)}  21%`)
  expect(detailOf(fast, 'seven_day')).toBe(two('17:00 10-19', `${ALERT} 04:15 10-18`))
  expect(lineAt(fast, 'seven_day').at(-1)).toEqual({ text: `${ALERT} 04:15 10-18`, color: COLOR.danger })
  // 正好在重置那一刻用完也算用完
  const edge = usageRows(limitsOf({ kind: 'five_hour', percentUsed: 60, resetsAt: iso(at(13, 22)) }), NOW, INNER)
  expect(detailOf(edge, 'five_hour')).toBe(two('22:00', `${ALERT} 22:00`))
})

test('窗口刚开始也照常推算，不设等待期，窗口开始前当作没用；还没用时是"󰁹 —"', () => {
  // 窗口 19:50 开始，10 分钟用了 2%：速度按 2%/小时，49 小时用完，10-15 21:00；重置不在当天写 HH:MM MM-DD
  const early = limitsOf({ kind: 'five_hour', percentUsed: 2, resetsAt: iso(at(14, 0, 50)) })
  expect(detailOf(usageRows(early, NOW, INNER), 'five_hour')).toBe(two('00:50 10-14', `${FINE} 21:00 10-15`))
  const idle = limitsOf({ kind: 'five_hour', percentUsed: 0, resetsAt: iso(at(13, 22)) })
  expect(detailOf(usageRows(idle, NOW, INNER), 'five_hour')).toBe(two('22:00', `${FINE} —`))
  expect(lineAt(usageRows(idle, NOW, INNER), 'five_hour').slice(-2)).toEqual([{ text: `${FINE} `, color: COLOR.ok }, { text: '—', color: COLOR.secondary }])
  // 窗口 17:00 开始，3 小时用了 30%：没有存档，按窗口平均
  expect(burnRate(30, at(13, 22), 5 * 3_600_000, NOW, 3_600_000, [])).toEqual({ used: 30, span: 3 * 3_600_000 })
})

test('已用满 100%、存档里没有 ≥ 100% 的读数：红色"󰂎 —"', () => {
  const full = limitsOf(
    { kind: 'five_hour', percentUsed: 100, resetsAt: iso(at(13, 22)) },
    { kind: 'seven_day', percentUsed: 100, resetsAt: iso(at(19, 17)) },
  )
  const rows = usageRows(full, NOW, INNER)
  expect(detailOf(rows, 'five_hour')).toBe(two('22:00', `${EMPTY} —`))
  expect(detailOf(rows, 'seven_day')).toBe(two('17:00 10-19', `${EMPTY} —`))
  for (const key of ['five_hour', 'seven_day']) expect(lineAt(rows, key).at(-1), key).toEqual({ text: `${EMPTY} —`, color: COLOR.danger })
})

test('重置时刻、用完时刻一律绝对时刻：当天 HH:MM，不是当天 HH:MM MM-DD；不写星期、"明天"', () => {
  // 窗口 10/8 09:00 开始，131 小时用了 18%，没有存档按窗口平均：596 小时 47 分钟用完，11-07 16:46，晚于重置
  expect(detailOf(usageRows(WORKING, NOW, INNER), 'seven_day')).toBe(two('09:00 10-15', `${FINE} 16:46 11-07`))
  // 窗口 10/7 09:00 开始，155 小时用了 95%：163 小时 9 分钟用完，10-14 04:09
  const tomorrow = limitsOf({ kind: 'seven_day', percentUsed: 95, resetsAt: iso(at(14, 9)) })
  expect(detailOf(usageRows(tomorrow, NOW, INNER), 'seven_day')).toBe(two('09:00 10-14', `${ALERT} 04:09 10-14`))
})

test('第二行两列：5h、7d 的右列起点相同，不管是哪个图标', () => {
  const mixed = limitsOf(
    { kind: 'five_hour', percentUsed: 18.4, resetsAt: iso(at(13, 23)) },
    { kind: 'seven_day', percentUsed: (128 * 27) / 168, resetsAt: iso(at(19, 17)) },
  )
  for (const usage of [WORKING, mixed]) {
    for (const inner of [46, 47, 50, 66, 70]) {
      const rows = usageRows(usage, NOW, inner)
      const starts = ['five_hour', 'seven_day'].map(key => {
        const line = text(lineAt(rows, key))
        const at = [...line].findIndex(char => [FINE, ALERT, EMPTY].includes(char))
        return cells([...line].slice(0, at).join(''))
      })
      expect(starts, `${inner} 格`).toEqual([15, 15])
    }
  }
})

test('窗口还没开始（没有读数，或已过重置时刻）：0%，第二行"发送消息后开始计时"', () => {
  const cold: Usage = { ...WORKING, rateLimits: [{ kind: 'seven_day', percentUsed: 24, resetsAt: iso(at(13, 19)) }] }
  const rows = usageRows(cold, NOW, INNER)
  for (const key of ['five_hour', 'seven_day']) {
    expect(firstOf(rows, key)).toBe(`${barText(0)}   0%`)
    expect(detailOf(rows, key)).toBe('发送消息后开始计时')
  }
})

test('本会话还没有读数（开局、/clear 后）：窗口没过重置时用存档里最近的读数，过了才写"发送消息后开始计时"', () => {
  const histories = {
    five_hour: { resetsAt: at(13, 22), samples: [{ at: at(13, 18), percent: 30 }, { at: at(13, 19, 30), percent: 41 }] },
    seven_day: { resetsAt: at(13, 19), base: 0, samples: [{ at: at(13, 18), percent: 24, total: 24 }] },
  }
  const rows = usageRows(EMPTY_USAGE, NOW, INNER, histories)
  expect(firstOf(rows, 'five_hour')).toBe(`${barText(41)}  41%`)
  expect(detailOf(rows, 'five_hour')).toContain(`${RESET} 22:00`)
  // 7d 的存档窗口已过重置
  expect(detailOf(rows, 'seven_day')).toBe('发送消息后开始计时')
  // 有本会话的读数就用读数
  expect(firstOf(usageRows(WORKING, NOW, INNER, histories), 'five_hour')).toBe(`${barText(62)}  62%`)
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

test('第二行的细节都是次要色（󰑐 图标色，预测图标除外）；不写"预计"、↻、"本会话""上一条""压缩""≈"、星期、"明天""用尽"', () => {
  // 7d 用不完：除了开头的 󰑐 和绿色 󰁹 都是次要色，用完时刻也是
  const rows = usageRows(WORKING, NOW, INNER)
  const seven = lineAt(rows, 'seven_day')
  expect(seven.at(-2)).toEqual({ text: `${FINE} `, color: COLOR.ok })
  expect(seven.slice(1).filter(one => one.text !== `${FINE} `).every(one => one.color === COLOR.secondary)).toBe(true)
  expect(lineAt(rows, 'seven_day')[0]).toEqual({ text: `${RESET} `, color: COLOR.icon })
  const context = lineAt(rows, 'context')
  expect(context.length > 0 && context.every(one => one.color === COLOR.secondary)).toBe(true)
  const all = rows.flatMap(row => row.lines.map(text)).join('\n')
  for (const word of ['预计', '↻', '本会话', '上一条', '压缩', '≈', '周', '明天', '用尽']) expect(all).not.toContain(word)
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

test('进度条加长：值那一列除了百分比都给进度条，右边留一格，最长 30 格', () => {
  // 用户的终稿：框 48 列（框内 44 格）时进度条 30 格；拖宽到 70 列也不超过 30 格（anvil-k0t.46）
  expect(barWidth(36)).toBe(valueWidth(36) - FIELD.percent - 2)
  expect(barWidth(44)).toBe(30)
  expect(barWidth(47)).toBe(30)
  expect(barWidth(66)).toBe(30)
  expect(barWidth(86)).toBe(30)
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
  // 百分比按四档；进度条按位置取热度色：填到哪，最后一格就和百分比同色一带
  const colorOf = (key: string, part: string) => rowOf(rows, key)?.lines[0]?.find(one => one.text.includes(part))?.color
  const lastFill = (key: string) => rowOf(rows, key)?.lines[0]?.filter(one => one.text.includes('━')).at(-1)?.color
  expect([colorOf('five_hour', '%'), colorOf('seven_day', '%'), colorOf('context', '%')]).toEqual([COLOR.warn, COLOR.ok, COLOR.warn])
  expect(colorOf('seven_day', '━')).toBe(COLOR.ok)
  expect(colorOf('five_hour', '━')).toBe(COLOR.ok)
  expect(lastFill('five_hour')).not.toBe(COLOR.ok)
})

// 面板可能停靠的宽度：请求的 70 列，开着别的面板（带页签）时更窄，拖宽后更宽
const WIDTHS = [40, 44, 48, 50, 51, 52, 56, 60, 66, 70, 90, 120]

test('各种宽度下每行都不超出值那一列，放不下的整块折到下一行，不出现 …', () => {
  const busy: Usage = {
    ...WORKING,
    costUsd: 1234.5,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 62, resetsAt: iso(at(13, 22)) },
      { kind: 'seven_day', percentUsed: (128 * 27) / 168, resetsAt: iso(at(19, 17)) },
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
      // 第二行起不超出百分比那一列的右边界（40 列时 7d 的用完时刻整块折到第三行）
      for (const key of ['five_hour', 'seven_day']) {
        for (const line of rowOf(rows, key)?.lines.slice(1) ?? []) {
          expect(cells(text(line)) <= barWidth(inner) + 1 + FIELD.percent, `${columns} 列 ${key}`).toBe(true)
        }
      }
    }
    if (columns >= 44) {
      expect(detailOf(rows, 'seven_day'), `${columns} 列`).toBe(two('17:00 10-19', `${ALERT} 04:15 10-18`))
      expect(detailOf(rows, 'five_hour'), `${columns} 列`).toBe(two('22:00', `${ALERT} 21:50`))
    }
  }
  // 约 51 列停靠（框内 47 格）：7d 的重置和用完时刻在第二行一行排完
  expect(rowOf(usageRows(busy, NOW, 47), 'seven_day')?.lines).toHaveLength(2)
})

test('格式：token、金额、时刻（当天 HH:MM，不是当天 HH:MM MM-DD）', () => {
  expect([formatTokens(999), formatTokens(152_000), formatTokens(999_600), formatTokens(1_000_000), formatTokens(1_250_000)]).toEqual([
    '999',
    '152k',
    '1M',
    '1M',
    '1.3M',
  ])
  expect([formatUsd(0.314), formatUsd(4.2), formatUsd(123.4)]).toEqual(['$0.31', '$4.20', '$123'])
  expect([formatWhen(at(13, 21, 5), NOW), formatWhen(at(14, 1, 30), NOW), formatWhen(at(19, 17), NOW), formatWhen(at(12, 9), NOW)]).toEqual([
    '21:05',
    '01:30 10-14',
    '17:00 10-19',
    '09:00 10-12',
  ])
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

function engine(on: On) {
  mock.clock(on, { now: NOW })
  const reading = { current: READING }
  world(on, { reading })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return reading
}

test('用量框交还 statusline：面板不画用量框；读数照记', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount(pane(70))
  expect(await ui.find({ key: 'section:usage' })).toBeUndefined()
  expect(await ui.find({ key: 'row:five_hour' })).toBeUndefined()
  await ui.unmount()
})

test('还没有请求时缓存框上边框右侧什么都不画（不留空格）', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount(pane(52))
  expect(await ui.find({ key: 'status:section:cache' })).toBeUndefined()
  await ui.unmount()
})
