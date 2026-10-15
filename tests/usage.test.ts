import { expect, test } from 'claude-code/testing'

import { EMPTY_USAGE, applyReading, formatTokens, formatUsd, formatWhen, limitSegments } from '../hooks/usage'

// 本地时间 2026-10-13（周二）20:00；格式化按本地时区，测试也按本地时区造时刻
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const NOW = at(13, 20)
const iso = (ms: number) => new Date(ms).toISOString()

test('格式：token、金额、时刻（当天 HH:MM，不是当天 HH:MM MM-DD；不写星期、"明天"）', () => {
  expect([formatTokens(999), formatTokens(152_000), formatTokens(999_600), formatTokens(1_000_000), formatTokens(1_250_000)]).toEqual(['999', '152k', '1M', '1M', '1.3M'])
  expect([formatUsd(0.314), formatUsd(4.2), formatUsd(123.4)]).toEqual(['$0.31', '$4.20', '$123'])
  expect([formatWhen(at(13, 21, 5), NOW), formatWhen(at(14, 1, 30), NOW), formatWhen(at(19, 17), NOW), formatWhen(at(12, 9), NOW)]).toEqual([
    '21:05',
    '01:30 10-14',
    '17:00 10-19',
    '09:00 10-12',
  ])
})

test('读数：有 5h、7d 就换上；读数里没有时（开局）留着原来的，花费没有时也留着', () => {
  const limits = [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(at(13, 22)) }]
  const first = applyReading(EMPTY_USAGE, { rateLimits: limits, cost: { usd: 1 } })
  expect(first).toEqual({ rateLimits: limits, costUsd: 1 })
  expect(applyReading(first, { rateLimits: [] })).toEqual(first)
})

test('5h、7d 一段：标签、10 格进度条、百分比、重置时刻；窄屏不画进度条', () => {
  const limits = [{ kind: 'seven_day', percentUsed: 41.4, resetsAt: iso(at(15, 9)) }]
  const text = (withBar: boolean) => limitSegments('seven_day', limits, NOW, withBar).map(one => one.text).join('')
  expect(text(true)).toBe('7d ━━━━────── 41% \u{F0450} 09:00 10-15')
  expect(text(false)).toBe('7d 41% \u{F0450} 09:00 10-15')
})
