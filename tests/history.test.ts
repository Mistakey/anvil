import type { SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { HISTORY_KEYS, TREND, parseHistory, recordSample, storedLimits } from '../hooks/usage'
import type { History } from '../hooks/usage'
import { SESSION, world } from './world'

// 5h、7d 的读数存档（`$.store`，本机会话共用）：开局还没有读数时先画存档里最近的；
// 7d 跨重置记累计用量，给以后的用完预测留着（预测先不做，用户 2026-10-14 定）

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const START = new Date(2026, 9, 12, 0, 0).getTime()

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

test('7d 存档只留最近 8 天，加上 8 天前最近的一个；同一桶只留最后一个', () => {
  let history: History | null = null
  for (let at = START; at <= START + 10 * DAY; at += 5 * MINUTE) history = recordSample(history, 'seven_day', START + 7 * DAY, { at, percent: 1 })
  const now = START + 10 * DAY
  expect(history?.samples[0]?.at).toBe(now - 8 * DAY)
  expect(history?.samples.filter(one => one.at <= now - 8 * DAY).length).toBe(1)
  expect(history?.samples.length).toBe(8 * 288 + 1)
  // 同一桶
  const same = recordSample(recordSample(null, 'seven_day', START + 7 * DAY, { at: START, percent: 1 }), 'seven_day', START + 7 * DAY, { at: START + 4 * MINUTE, percent: 2 })
  expect(same.samples).toEqual([{ at: START + 4 * MINUTE, percent: 2, total: 2 }])
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
})

test('用满后本窗口第一个 ≥ 100% 的读数一直留在存档里：清理不清掉它，同一桶的新读数也不顶掉它', () => {
  const resetsAt = new Date(2026, 9, 19, 17, 0).getTime()
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

test('存档里最近的读数：窗口没过重置时当作现在的用量，过了就不用', () => {
  const now = START + HOUR
  const live: History = { resetsAt: now + HOUR, samples: [{ at: now - MINUTE, percent: 30 }] }
  const gone: History = { resetsAt: now - MINUTE, samples: [{ at: now - HOUR, percent: 80 }] }
  expect(storedLimits({ five_hour: live, seven_day: gone }, now)).toEqual([{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(now + HOUR).toISOString() }])
  expect(storedLimits({}, now)).toEqual([])
})

// ---------------------------------------------------------------- 读数进存档

const iso = (ms: number) => new Date(ms).toISOString()
test('读数按窗口记进 $.store', async ($, on) => {
  // 7d 窗口第 2 天 11:00：一天前 40%，现在 45%
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

})
