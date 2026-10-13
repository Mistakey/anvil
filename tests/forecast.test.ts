import type { SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { EMPTY_USAGE, HISTORY_KEYS, TREND, burnRate, emptyAt, formatWhen, parseHistory, recordSample, usageRows } from '../hooks/usage'
import type { Histories, History } from '../hooks/usage'
import type { Usage } from '../types'
import { COLOR } from '../hooks/style'
import { SESSION, world } from './world'

// 用量预测（spec D8）：5h 按最近 1 小时匀速外推；7d 照上周同一时段重演，存档不足 7 天时照最近 24 小时逐时段重放；
// 窗口不到 L 时开始前当作没用，存档缺 now − L 之前的读数时退回窗口平均

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WINDOW = { five_hour: 5 * HOUR, seven_day: 7 * DAY } as const
type Kind = keyof typeof WINDOW

const FINE = '\u{F0079}'
const ALERT = '\u{F0083}'
const EMPTY = '\u{F008E}'

/** 一个窗口第二行的预测（右列） */
function forecastOf(kind: Kind, percent: number, resetsAt: number, now: number, history: History | null) {
  const usage: Usage = { ...EMPTY_USAGE, rateLimits: [{ kind, percentUsed: percent, resetsAt: new Date(resetsAt).toISOString() }] }
  const histories: Histories = history ? { [kind]: history } : {}
  const row = usageRows(usage, now, 66, histories).find(one => one.key === kind)
  return row?.lines[1]?.at(-1)
}

/** 一个窗口的第二行预测：用不完绿、会用完红、已用满 full */
function stateOf(kind: Kind, percent: number, resetsAt: number, now: number, history: History | null): 'green' | 'red' | 'full' {
  const forecast = forecastOf(kind, percent, resetsAt, now, history)?.text ?? ''
  if (forecast.startsWith(`${FINE} `)) return 'green'
  if (forecast.startsWith(`${ALERT} `)) return 'red'
  if (forecast.startsWith(`${EMPTY} `)) return 'full'
  throw new Error(`没有预测：${forecast}`)
}

type Step = { at: number; percent: number; state: 'green' | 'red' | 'full'; empty: number | null }

/** 按读数时刻依次记进存档、现算预测，和面板一样 */
function simulate(kind: Kind, start: number, readings: readonly { at: number; percent: number }[]): Step[] {
  const resetsAt = start + WINDOW[kind]
  let history: History | null = null
  return readings.map(({ at, percent }) => {
    history = recordSample(history, kind, resetsAt, { at, percent })
    return { at, percent, state: stateOf(kind, percent, resetsAt, at, history), empty: emptyAt(kind, percent, resetsAt, at, history.samples) }
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

test('7d 每天 14%（一周 98%）：全周不翻红', () => {
  const steps = week([14, 14, 14, 14, 14, 14, 14])
  expect(steps.filter(step => step.state === 'red')).toEqual([])
})

test('7d 每天 16%：推出的用完时刻落在平时干活的 9–21 点之间', () => {
  const steps = week([16, 16, 16, 16, 16, 16, 16])
  // 第一个读数还没用（0%）没有时刻，其余都推出时刻
  expect(steps.filter(step => step.empty === null).map(step => step.percent)).toEqual([0])
  const outside = steps.filter(step => {
    if (step.empty === null) return false
    const minutes = new Date(step.empty).getHours() * 60 + new Date(step.empty).getMinutes()
    return minutes < 9 * 60 || minutes > 21 * 60
  })
  expect(outside).toEqual([])
  expect(steps.some(step => step.state === 'red')).toBe(true)
})

test('7d 重放：一天用 U，整天数 k = ⌊need ÷ U⌋，余下的在最近 24 小时里找第一个用到 base + r 的时刻', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 2 * DAY + 21 * HOUR
  // 前一天 21:00 是 30%，今天 9 点起每小时 2%（9:00 30%、10:00 32% …… 21:00 54%）：U = 24，need = 46，k = 1，r = 22
  const samples = Array.from({ length: 13 }, (_, hour) => ({ at: START + 2 * DAY + (9 + hour) * HOUR, percent: 30 + 2 * hour }))
  const history = [{ at: now - DAY, percent: 30 }, ...samples]
  // 第一个 ≥ 52% 的读数是 20:00：用完时刻 = now + 1 天 + (20:00 − 前一天 21:00)，即 2 天后的 20:00
  expect(emptyAt('seven_day', 54, resetsAt, now, history)).toBe(START + 4 * DAY + 20 * HOUR)
  // 正好整天：U = 24、need = 48 → k = 2，r = 0，用完时刻 = now + 2 天
  const exact = [{ at: now - DAY, percent: 28 }, { at: now, percent: 52 }]
  expect(emptyAt('seven_day', 52, resetsAt, now, exact)).toBe(now + 2 * DAY)
  // 最近 24 小时没用：用不完
  expect(emptyAt('seven_day', 30, resetsAt, now, [{ at: now - 2 * DAY, percent: 30 }])).toBe(null)
  // 窗口开始前当作 0：窗口 10 小时前开始，用了 10%，k = 9，用完时刻按窗口开始后的读数平移
  const fresh = START + 10 * HOUR
  const early = [{ at: START + 2 * HOUR, percent: 5 }, { at: fresh, percent: 10 }]
  expect(emptyAt('seven_day', 10, resetsAt, fresh, early)).toBe(fresh + 9 * DAY)
  expect(emptyAt('seven_day', 12, resetsAt, fresh, early)).toBe(fresh + 7 * DAY + (START + 2 * HOUR - (fresh - DAY)))
  // 窗口超过 24 小时、存档缺那之前的读数：退回窗口平均匀速（2 天用了 20%）
  expect(emptyAt('seven_day', 20, resetsAt, START + 2 * DAY, [{ at: START + 30 * HOUR, percent: 15 }])).toBe(START + 2 * DAY + 8 * DAY)
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

// ---------------------------------------------------------------- 7d 照上周同一时段重演

/** 7d 一周的工作日、周末：10-12 是周一 */
const WORKWEEK = [15, 15, 15, 15, 15, 3, 3]

/**
 * 两个窗口：上周 START 起、本周 START + 7 天起；每天 9–21 点匀速用，每 5 分钟一个读数，百分比到 100 封顶。
 * 按读数时刻依次记进存档（跨重置），返回本周每个读数的预测
 */
function twoWeeks(last: readonly number[], current: readonly number[]) {
  let history: History | null = null
  const steps: (Step & { day: number })[] = []
  for (const [index, daily] of [last, current].entries()) {
    const start = START + index * 7 * DAY
    const resetsAt = start + 7 * DAY
    let before = 0
    for (const [day, used] of daily.entries()) {
      for (let minute = 0; minute <= 12 * 60; minute += 5) {
        const at = start + day * DAY + 9 * HOUR + minute * MINUTE
        const percent = Math.min(100, before + (used * minute) / (12 * 60))
        history = recordSample(history, 'seven_day', resetsAt, { at, percent })
        if (index === 0) continue
        const state = stateOf('seven_day', percent, resetsAt, at, history)
        steps.push({ at, percent, state, empty: emptyAt('seven_day', percent, resetsAt, at, history.samples, history.base), day })
      }
      before += used
    }
  }
  return steps
}

test('7d 上周与本周都是工作日每天 15%、周末每天 3%（一周 81%）：全周绿，周五晚上不翻红', () => {
  const steps = twoWeeks(WORKWEEK, WORKWEEK)
  expect(steps.filter(step => step.state !== 'green')).toEqual([])
  // 周五 21:00 照最近 24 小时会当作周六也干活、翻红；照上周不会
  expect(steps.find(step => step.day === 4 && new Date(step.at).getHours() === 21)?.state).toBe('green')
})

test('7d 上周同上、本周工作日每天 22%：变红，用完时刻落在 9–21 点；越接近实际用完（周五 15:33）越准，周四 16:00 起都在周五', () => {
  const steps = twoWeeks(WORKWEEK, [22, 22, 22, 22, 22, 3, 3])
  const red = steps.filter(step => step.state === 'red' && step.percent < 100)
  expect(red.length > 0).toBe(true)
  const outside = red.filter(step => {
    const empty = new Date(step.empty ?? 0)
    const minutes = empty.getHours() * 60 + empty.getMinutes()
    return minutes < 9 * 60 || minutes > 21 * 60
  })
  expect(outside).toEqual([])
  // 周三晚上刚变红时推到周末（上周周末每天用 3%），周四 16:00 起落在周五
  const late = red.filter(step => step.at >= START + 7 * DAY + 3 * DAY + 16 * HOUR)
  expect(late.length > 0).toBe(true)
  expect(late.filter(step => new Date(step.empty ?? 0).getDay() !== 5)).toEqual([])
})

test('7d 重置后第一天：上周每天 18%（会用完）、本周照旧，第一天开始用就红', () => {
  const daily = [18, 18, 18, 18, 18, 18, 18]
  const first = twoWeeks(daily, daily).filter(step => step.day === 0 && step.percent > 0)
  expect(first.length > 0).toBe(true)
  expect(first.filter(step => step.state !== 'red')).toEqual([])
})

test('7d 照上周重演：一周用 U = C(now) − C(now − 7 天)，整周数 k = ⌊need ÷ U⌋，余下的在最近 7 天里找第一个用到 C(now − 7 天) + r 的时刻', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 3 * DAY + 12 * HOUR
  // 上一个窗口留下 base 70；7 天前累计 40，之后 2 天累计 60、5 天累计 90，现在 30%（累计 100）：U = 60，need = 70，k = 1，r = 10
  const samples = [
    { at: now - 8 * DAY, percent: 10, total: 10 },
    { at: now - 7 * DAY, percent: 40, total: 40 },
    { at: now - 5 * DAY, percent: 60, total: 60 },
    { at: now - 2 * DAY, percent: 20, total: 90 },
    { at: now, percent: 30, total: 100 },
  ]
  // 第一个累计 ≥ 50 的读数是 5 天前那个：用完时刻 = now + 1 周 + 2 天
  expect(emptyAt('seven_day', 30, resetsAt, now, samples, 70)).toBe(now + 9 * DAY)
  // 正好整周：U = 60、need = 60 → k = 1，r = 0
  expect(emptyAt('seven_day', 40, resetsAt, now, [{ at: now - 7 * DAY, percent: 50, total: 50 }], 70)).toBe(now + 7 * DAY)
  // 最近 7 天没用：用不完
  expect(emptyAt('seven_day', 30, resetsAt, now, [{ at: now - 7 * DAY, percent: 100, total: 100 }], 70)).toBe(null)
})

test('7d 存档不足 7 天：退回最近 24 小时重放，只看本窗口的读数', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 2 * DAY + 21 * HOUR
  // 和上面 24 小时重放的例子一样，只是上一个窗口留下 base 50，存档里还有上个窗口的读数
  const samples = Array.from({ length: 13 }, (_, hour) => ({ at: START + 2 * DAY + (9 + hour) * HOUR, percent: 30 + 2 * hour, total: 80 + 2 * hour }))
  const history = [{ at: START - DAY, percent: 50, total: 50 }, { at: now - DAY, percent: 30, total: 80 }, ...samples]
  expect(emptyAt('seven_day', 54, resetsAt, now, history, 50)).toBe(START + 4 * DAY + 20 * HOUR)
})

test('7d 跨重置时累计用量连续：新窗口的 base 加上旧窗口最后一个读数的百分比，存档不清空', () => {
  let history = recordSample(null, 'seven_day', START + 7 * DAY, { at: START + HOUR, percent: 10 })
  history = recordSample(history, 'seven_day', START + 7 * DAY, { at: START + 6 * DAY, percent: 60 })
  expect([history.base, history.samples.map(one => one.total)]).toEqual([0, [10, 60]])
  // resetsAt 抖 1 分钟：同一个窗口
  history = recordSample(history, 'seven_day', START + 7 * DAY + MINUTE, { at: START + 6 * DAY + HOUR, percent: 61 })
  expect([history.resetsAt, history.base, history.samples.at(-1)?.total]).toEqual([START + 7 * DAY, 0, 61])
  // 新窗口
  history = recordSample(history, 'seven_day', START + 15 * DAY, { at: START + 8 * DAY, percent: 2 })
  expect([history.resetsAt, history.base, history.samples.map(one => one.total)]).toEqual([START + 15 * DAY, 61, [10, 60, 61, 63]])
  history = recordSample(history, 'seven_day', START + 22 * DAY, { at: START + 15 * DAY + HOUR, percent: 1 })
  expect([history.base, history.samples.at(-1)?.total]).toEqual([63, 64])
  // 旧存档没有 total：按它自己的 base 补上
  const old = recordSample({ resetsAt: START + 7 * DAY, samples: [{ at: START + 6 * DAY, percent: 70 }] }, 'seven_day', START + 15 * DAY, { at: START + 8 * DAY, percent: 1 })
  expect(old.samples).toEqual([{ at: START + 6 * DAY, percent: 70, total: 70 }, { at: START + 8 * DAY, percent: 1, total: 71 }])
})

test('7d 存档只留最近 8 天，加上 8 天前最近的一个；同一桶只留最后一个；用满的时刻只看本窗口', () => {
  let history: History | null = null
  for (let at = START; at <= START + 10 * DAY; at += 5 * MINUTE) history = recordSample(history, 'seven_day', START + 7 * DAY, { at, percent: 1 })
  const now = START + 10 * DAY
  expect(history?.samples[0]?.at).toBe(now - 8 * DAY)
  expect(history?.samples.filter(one => one.at <= now - 8 * DAY).length).toBe(1)
  expect(history?.samples.length).toBe(8 * 288 + 1)
  // 同一桶
  const same = recordSample(recordSample(null, 'seven_day', START + 7 * DAY, { at: START, percent: 1 }), 'seven_day', START + 7 * DAY, { at: START + 4 * MINUTE, percent: 2 })
  expect(same.samples).toEqual([{ at: START + 4 * MINUTE, percent: 2, total: 2 }])
  // 上个窗口用满了：本窗口还没用满时不拿它当用满的时刻；本窗口用满后取本窗口第一个 ≥ 100% 的读数
  let full = recordSample(null, 'seven_day', START + 7 * DAY, { at: START + 6 * DAY, percent: 100 })
  full = recordSample(full, 'seven_day', START + 14 * DAY, { at: START + 7 * DAY + HOUR, percent: 5 })
  expect(full.samples.length).toBe(2)
  full = recordSample(full, 'seven_day', START + 14 * DAY, { at: START + 13 * DAY + HOUR, percent: 100 })
  const now2 = START + 13 * DAY + 2 * HOUR
  expect(forecastOf('seven_day', 100, START + 14 * DAY, now2, full)?.text).toBe(`${EMPTY} ${formatWhen(START + 13 * DAY + HOUR, now2)}`)
})

// ---------------------------------------------------------------- 速度与存档

test('窗口开始到现在不到 L：窗口开始前当作没用，速度 = 现在百分比 ÷ L', () => {
  const resetsAt = START + 7 * DAY
  const now = START + 20 * HOUR
  const samples = [{ at: START, percent: 0 }, { at: START + 10 * HOUR, percent: 5 }]
  expect(burnRate(10, resetsAt, WINDOW.seven_day, now, DAY, samples)).toEqual({ used: 10, span: DAY })
})

test('5h 窗口开始 10 分钟用了 5%：速度按 5%/小时', () => {
  const start = new Date(2026, 9, 13, 9, 0).getTime()
  const now = start + 10 * MINUTE
  const samples = [{ at: start + MINUTE, percent: 1 }, { at: now, percent: 5 }]
  expect(burnRate(5, start + WINDOW.five_hour, WINDOW.five_hour, now, HOUR, samples)).toEqual({ used: 5, span: HOUR })
  // 还差 95%，19 小时用完：10-14 04:10，晚于 14:00 的重置，绿
  expect(forecastOf('five_hour', 5, start + WINDOW.five_hour, now, { resetsAt: start + WINDOW.five_hour, samples })).toEqual({ text: `${FINE} 04:10 10-14`, color: COLOR.ok })
})

test('7d 窗口从 17:00 开始、每天 9–21 点用 12%：第一天也是绿', () => {
  const start = new Date(2026, 9, 12, 17, 0).getTime()
  const readings: { at: number; percent: number }[] = []
  // 每天 9–21 点每小时 1%，每 5 分钟一个读数；第一天只有 17–21 点
  for (let at = start; at < start + WINDOW.seven_day; at += 5 * MINUTE) {
    const hour = new Date(at).getHours()
    if (hour < 9 || hour >= 21) continue
    readings.push({ at, percent: (readings.at(-1)?.percent ?? 0) + 1 / 12 })
  }
  const steps = simulate('seven_day', start, readings)
  expect(steps.filter(step => step.at < start + DAY).length > 0).toBe(true)
  expect(steps.filter(step => step.state !== 'green')).toEqual([])
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
  expect(seven?.samples).toEqual([{ at: START + 4 * MINUTE, percent: 3, total: 3 }, { at: START + 5 * MINUTE, percent: 4, total: 4 }])
})

test('清理：5h 只留晚于 now − 1 小时的读数，加上那之前最近的一个；7d 留 8 天', () => {
  const resetsAt = START + 5 * HOUR
  const old = [0, 20, 40, 60].map(minute => ({ at: START + minute * MINUTE, percent: minute }))
  const history = recordSample({ resetsAt, samples: old }, 'five_hour', resetsAt, { at: START + 110 * MINUTE, percent: 90 })
  // now − L = 第 50 分钟：40 分那个是之前最近的，0、20 分的清掉
  expect(history.samples).toEqual([{ at: START + 40 * MINUTE, percent: 40 }, { at: START + 60 * MINUTE, percent: 60 }, { at: START + 110 * MINUTE, percent: 90 }])
  const week = [0, 2, 4, 6].map(hour => ({ at: START + hour * HOUR, percent: hour }))
  const seven = recordSample({ resetsAt: START + 7 * DAY, samples: week }, 'seven_day', START + 7 * DAY, { at: START + 8 * DAY + 5 * HOUR, percent: 30 })
  expect(seven.samples.map(one => one.at)).toEqual([START + 4 * HOUR, START + 6 * HOUR, START + 8 * DAY + 5 * HOUR])
})

test('重置时刻晚了 10 分钟以上（新窗口）才清空存档：差 5 小时清空，差 1 分钟不清空', () => {
  const old: History = { resetsAt: START + 5 * HOUR, samples: [{ at: START, percent: 90 }] }
  const fresh = recordSample(old, 'five_hour', START + 10 * HOUR, { at: START + 5 * HOUR + MINUTE, percent: 1 })
  expect(fresh).toEqual({ resetsAt: START + 10 * HOUR, samples: [{ at: START + 5 * HOUR + MINUTE, percent: 1 }] })
  // resetsAt 抖了 1 分钟：同一个窗口，沿用存档里记的重置时刻
  const jitter = recordSample(old, 'five_hour', START + 5 * HOUR + MINUTE, { at: START + 30 * MINUTE, percent: 92 })
  expect(jitter).toEqual({ resetsAt: START + 5 * HOUR, samples: [{ at: START, percent: 90 }, { at: START + 30 * MINUTE, percent: 92 }] })
  // 面板也把差 1 分钟的存档当同一个窗口：最近 1 小时用了 30%（60% → 90%），重置前用完，红；差 5 小时就不用这份存档
  const now = START + 4 * HOUR
  const history: History = { resetsAt: START + 5 * HOUR, samples: [{ at: now - HOUR, percent: 60 }, { at: now, percent: 90 }] }
  expect(stateOf('five_hour', 90, START + 5 * HOUR + MINUTE, now, history)).toBe('red')
  expect(forecastOf('five_hour', 90, START + 10 * HOUR, START + 9 * HOUR, history)?.text).toBe(forecastOf('five_hour', 90, START + 10 * HOUR, START + 9 * HOUR, null)?.text)
})

test('已用满：红色"󰂎 用满的时刻"，取本窗口存档里第一个 ≥ 100% 的读数（当天 HH:MM，不是当天 HH:MM MM-DD），一直留在存档里', () => {
  const now = new Date(2026, 9, 13, 20, 0).getTime()
  const resetsAt = new Date(2026, 9, 19, 17, 0).getTime()
  const full = (history: History | null) => forecastOf('seven_day', 100, resetsAt, now, history)
  const today: History = { resetsAt, samples: [{ at: now - 3 * HOUR, percent: 99 }, { at: now - 2 * HOUR - 55 * MINUTE, percent: 100 }, { at: now, percent: 100 }] }
  expect(full(today)).toEqual({ text: `${EMPTY} 17:05`, color: COLOR.danger })
  const earlier: History = { resetsAt, samples: [{ at: new Date(2026, 9, 12, 23, 30).getTime(), percent: 100 }, { at: now, percent: 100 }] }
  expect(full(earlier)).toEqual({ text: `${EMPTY} 23:30 10-12`, color: COLOR.danger })
  expect(full(null)).toEqual({ text: `${EMPTY} —`, color: COLOR.danger })
  // 用满两天：清理不清掉第一个 ≥ 100% 的读数，同一桶的新读数也不顶掉它
  const first = new Date(2026, 9, 13, 9, 2).getTime()
  let history = recordSample(null, 'seven_day', resetsAt, { at: first - 5 * MINUTE, percent: 99 })
  for (let at = first; at <= first + 2 * DAY; at += MINUTE) history = recordSample(history, 'seven_day', resetsAt, { at, percent: 100 })
  expect(history.samples.find(one => one.percent >= 100)?.at).toBe(first)
  expect(history.samples.length <= 2 * DAY / (5 * MINUTE) + 3).toBe(true)
})

test('存档的最大条数：5h 不超过 62 条，7d 不超过 2305 条（8 天的 5 分钟桶加 8 天前最近的一个）', () => {
  for (const [kind, max] of [['five_hour', 62], ['seven_day', 2305]] as const) {
    let history: History | null = null
    const step = TREND[kind].bucketMs / 2
    for (let at = START; at < START + TREND[kind].keepMs + 6 * HOUR; at += step) history = recordSample(history, kind, START + 30 * DAY, { at, percent: 1 })
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
  expect(flat(await ui.find({ key: 'row:seven_day:2' }))).toContain(`  ${FINE} `)
  await ui.unmount()
})
