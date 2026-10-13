import type { SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { EMPTY_USAGE, HISTORY_KEYS, TREND, burnRate, parseHistory, recordSample, usageRows } from '../hooks/usage'
import type { Histories, History } from '../hooks/usage'
import type { Usage } from '../types'
import { SESSION, world } from './world'

// 用量预测的速度（spec D8）：5h 看最近 1 小时、7d 看最近 24 小时，不够时退回窗口平均

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WINDOW = { five_hour: 5 * HOUR, seven_day: 7 * DAY } as const
type Kind = keyof typeof WINDOW

const FINE = '\u{F0079}'
const ALERT = '\u{F0083}'
const EMPTY = '\u{F008E}'

/** 一个窗口的第二行预测：用不完绿、会用完红、已用满 full */
function stateOf(kind: Kind, percent: number, resetsAt: number, now: number, history: History | null): 'green' | 'red' | 'full' {
  const usage: Usage = { ...EMPTY_USAGE, rateLimits: [{ kind, percentUsed: percent, resetsAt: new Date(resetsAt).toISOString() }] }
  const histories: Histories = history ? { [kind]: history } : {}
  const row = usageRows(usage, now, 66, histories).find(one => one.key === kind)
  const forecast = row?.lines[1]?.at(-1)?.text ?? ''
  if (forecast === FINE) return 'green'
  if (forecast.startsWith(ALERT)) return 'red'
  if (forecast === EMPTY) return 'full'
  throw new Error(`没有预测：${forecast}`)
}

type Step = { at: number; percent: number; state: 'green' | 'red' | 'full' }

/** 按读数时刻依次记进存档、现算预测，和面板一样 */
function simulate(kind: Kind, start: number, readings: readonly { at: number; percent: number }[]): Step[] {
  const resetsAt = start + WINDOW[kind]
  let history: History | null = null
  return readings.map(({ at, percent }) => {
    history = recordSample(history, kind, resetsAt, { at, percent })
    return { at, percent, state: stateOf(kind, percent, resetsAt, at, history) }
  })
}

// 7d：窗口 10-12 00:00 开始，每天 9–21 点匀速用，每 5 分钟一个读数
const START = new Date(2026, 9, 12, 0, 0).getTime()

function week(daily: readonly number[]) {
  const readings: { at: number; percent: number }[] = []
  let before = 0
  for (const [day, percent] of daily.entries()) {
    for (let minute = 0; minute <= 12 * 60; minute += 5) {
      readings.push({ at: START + day * DAY + 9 * HOUR + minute * MINUTE, percent: before + (percent * minute) / (12 * 60) })
    }
    before += percent
  }
  return simulate('seven_day', START, readings).map(step => ({ ...step, day: Math.floor((step.at - START) / DAY), hour: new Date(step.at).getHours() }))
}

test('7d 每天 12%：一周一直绿', () => {
  const steps = week([12, 12, 12, 12, 12, 12, 12])
  expect(steps.filter(step => step.state === 'red')).toEqual([])
})

test('7d 第 1 天 40%、之后每天 5%：第 2 天晚上起一直绿', () => {
  const steps = week([40, 5, 5, 5, 5, 5, 5])
  const lastRed = steps.findLastIndex(step => step.state === 'red')
  expect(lastRed >= 0).toBe(true)
  const turn = steps[lastRed + 1]
  expect([turn?.day, (turn?.hour ?? 0) >= 18]).toEqual([1, true])
  // 第 2 天早上还红（前一天猛用了）
  expect(steps.find(step => step.day === 1 && step.hour === 9)?.state).toBe('red')
})

test('7d 前 4 天每天 2%、第 5 天起每天 35%：前 4 天绿，第 5 天内变红', () => {
  const steps = week([2, 2, 2, 2, 35, 35, 35])
  expect(steps.filter(step => step.day < 4 && step.state === 'red')).toEqual([])
  expect(steps.find(step => step.state === 'red')?.day).toBe(4)
})

test('7d 每天 16%：第 1 天起红，之后早上开工也不因前一晚的空档变绿', () => {
  const steps = week([16, 16, 16, 16, 16, 16, 16])
  const firstRed = steps.findIndex(step => step.state === 'red')
  expect(steps[firstRed]?.day).toBe(0)
  expect(steps.slice(firstRed).filter(step => step.state === 'green')).toEqual([])
})

test('5h 前 2 小时用 60%、之后每小时 5%：第 3 小时起一直绿', () => {
  const start = new Date(2026, 9, 13, 9, 0).getTime()
  const readings = Array.from({ length: 5 * 60 }, (_, minute) => ({
    at: start + minute * MINUTE,
    percent: minute <= 120 ? (60 * minute) / 120 : 60 + (5 * (minute - 120)) / 60,
  }))
  const steps = simulate('five_hour', start, readings)
  const lastRed = steps.findLastIndex(step => step.state === 'red')
  const turn = steps[lastRed + 1]
  expect(turn !== undefined && turn.at >= start + 2 * HOUR && turn.at < start + 3 * HOUR).toBe(true)
  expect(steps.slice(lastRed + 1).every(step => step.state === 'green')).toBe(true)
})

// ---------------------------------------------------------------- 速度与存档

test('窗口开始到现在不到 L：按窗口平均', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 20 * HOUR
  const samples = [{ at: START, percent: 0 }, { at: START + 10 * HOUR, percent: 5 }]
  expect(burnRate(10, resetsAt, WINDOW.seven_day, now, DAY, samples)).toEqual({ used: 10, span: 20 * HOUR })
})

test('存档里没有 now − L 之前的读数：退回窗口平均', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 2 * DAY
  const samples = [{ at: START + 30 * HOUR, percent: 20 }, { at: now, percent: 30 }]
  expect(burnRate(30, resetsAt, WINDOW.seven_day, now, DAY, samples)).toEqual({ used: 30, span: 2 * DAY })
})

test('够 L 时取 now − L 之前最近的读数当那时的用量，分母固定是 L', () => {
  const resetsAt = START + 7 * DAY
  const now = START + DAY + 13 * HOUR
  // 前一晚 21:00 之后没读数：空档里用量不变，读数时刻比 now − L 早得多，分母仍是 L
  const samples = [{ at: START + 10 * HOUR, percent: 12 }, { at: START + 12 * HOUR, percent: 16 }, { at: START + 14 * HOUR, percent: 20 }]
  expect(burnRate(40, resetsAt, WINDOW.seven_day, now, DAY, samples)).toEqual({ used: 24, span: DAY })
})

test('速度 ≤ 0 当作用不完', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 3 * DAY
  const history: History = { resetsAt, samples: [{ at: now - 2 * DAY, percent: 50 }, { at: now, percent: 50 }] }
  expect(stateOf('seven_day', 50, resetsAt, now, history)).toBe('green')
})

test('同一桶只留最后一个读数：5h 每 1 分钟、7d 每 5 分钟', () => {
  const resetsAt = START + 5 * HOUR
  let five: History | null = null
  for (const [second, percent] of [[0, 1], [20, 2], [59, 3], [60, 4]] as const) five = recordSample(five, 'five_hour', resetsAt, { at: START + second * 1000, percent })
  expect(five?.samples).toEqual([{ at: START + 59_000, percent: 3 }, { at: START + 60_000, percent: 4 }])
  let seven: History | null = null
  for (const [minute, percent] of [[0, 1], [2, 2], [4, 3], [5, 4]] as const) seven = recordSample(seven, 'seven_day', resetsAt, { at: START + minute * MINUTE, percent })
  expect(seven?.samples).toEqual([{ at: START + 4 * MINUTE, percent: 3 }, { at: START + 5 * MINUTE, percent: 4 }])
})

test('清理：只留晚于 now − L 的读数，加上 now − L 之前最近的一个', () => {
  const resetsAt = START + 7 * DAY
  const old = [0, 2, 4, 6].map(hour => ({ at: START + hour * HOUR, percent: hour }))
  const history = recordSample({ resetsAt, samples: old }, 'seven_day', resetsAt, { at: START + 29 * HOUR, percent: 30 })
  // now − L = 第 5 小时：4 点那个是之前最近的，0、2 点的清掉
  expect(history.samples).toEqual([{ at: START + 4 * HOUR, percent: 4 }, { at: START + 6 * HOUR, percent: 6 }, { at: START + 29 * HOUR, percent: 30 }])
})

test('重置时刻变了（新窗口）：清空这个窗口的存档', () => {
  const old: History = { resetsAt: START + 5 * HOUR, samples: [{ at: START, percent: 90 }] }
  const fresh = recordSample(old, 'five_hour', START + 10 * HOUR, { at: START + 5 * HOUR + MINUTE, percent: 1 })
  expect(fresh).toEqual({ resetsAt: START + 10 * HOUR, samples: [{ at: START + 5 * HOUR + MINUTE, percent: 1 }] })
})

test('存档的最大条数：5h 不超过 62 条，7d 不超过 290 条', () => {
  for (const [kind, max] of [['five_hour', 62], ['seven_day', 290]] as const) {
    let history: History | null = null
    const step = TREND[kind].bucketMs / 3
    for (let at = START; at < START + 3 * TREND[kind].lookbackMs; at += step) history = recordSample(history, kind, START + 7 * DAY, { at, percent: 1 })
    expect((history?.samples.length ?? 0) <= max, kind).toBe(true)
  }
})

test('读回来不是存档的样子就当没有', () => {
  expect([parseHistory(undefined), parseHistory('x'), parseHistory({ resetsAt: 1 }), parseHistory({ resetsAt: 1, samples: [{ at: 'a' }] })]).toEqual([null, null, null, null])
  expect(parseHistory({ resetsAt: 1, samples: [{ at: 2, percent: 3 }] })).toEqual({ resetsAt: 1, samples: [{ at: 2, percent: 3 }] })
})

// ---------------------------------------------------------------- 读数进存档、面板按存档画

const iso = (ms: number) => new Date(ms).toISOString()
const pane = {
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
}

test('读数按窗口记进 $.store；面板按存档的最近一段算速度', async ($, on) => {
  // 7d 窗口第 2 天 11:00；前一天猛用到 40%，最近 24 小时只用了 5%：窗口平均会红，最近一段是绿
  const now = START + DAY + 11 * HOUR
  const clock = mock.clock(on, { now: now - DAY - MINUTE })
  const resetsAt = START + 7 * DAY
  const reading = (percent: number): SessionUsage => ({
    startedAt: 0,
    context: { tokens: 1000, window: 1_000_000, percent: 0 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 1, resetsAt: iso(now + HOUR) },
      { kind: 'seven_day', percentUsed: percent, resetsAt: iso(resetsAt) },
    ],
  })
  const current = { current: reading(40) }
  const { store } = world(on, { reading: current })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(SESSION)
  await clock.advance(DAY + MINUTE)
  current.current = reading(45)
  await $.session.measure({ ...reading(45), changed: ['rateLimits'] })

  const seven = parseHistory(store.get(HISTORY_KEYS.seven_day))
  expect(seven?.resetsAt).toBe(resetsAt)
  expect(seven?.samples.map(one => one.percent)).toEqual([40, 45])
  // 5h 那个窗口没变：一天前的读数是 now − L 之前最近的一个，留着
  expect(parseHistory(store.get(HISTORY_KEYS.five_hour))?.samples.map(one => one.percent)).toEqual([1, 1])

  const ui = await $.ui.mount(pane)
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : Array.isArray(node) ? node.map(flat).join('') : node && typeof node === 'object' ? flat((node as { children?: unknown }).children ?? []) : ''
  expect(flat(await ui.find({ key: 'row:seven_day:2' })).endsWith(FINE)).toBe(true)
  await ui.unmount()
})
