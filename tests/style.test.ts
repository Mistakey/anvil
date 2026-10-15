import { expect, test } from 'claude-code/testing'

import { COLOR, HEAT, bar, fitSegments, levelColor } from '../hooks/style'

// 色板：输入框上方那一行画在终端自己的底色上，按用户的 Dracula #282a36 量对比度（WCAG 相对亮度）

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const GROUND = '#282a36'

test('文字用的颜色在终端底色上都不低于 4.5:1；图标不低于 3:1', () => {
  for (const name of ['secondary', 'ok', 'warn', 'high', 'danger', 'branch', 'cost'] as const) {
    expect(contrast(COLOR[name], GROUND), name).toBeGreaterThanOrEqual(4.5)
  }
  expect(contrast(COLOR.icon, GROUND)).toBeGreaterThanOrEqual(3)
})

test('中性色由亮到暗：次要文字、图标、进度条的底', () => {
  expect(contrast(COLOR.secondary, GROUND)).toBeGreaterThan(contrast(COLOR.icon, GROUND))
  expect(contrast(COLOR.icon, GROUND)).toBeGreaterThan(contrast(COLOR.track, GROUND))
})

test('进度条：已用部分按位置取热度色（45% 前绿，60、80、90% 正好是四档），其余是暗底', () => {
  const at = (pos: number) => HEAT.find(([p]) => p === pos)?.[1]
  expect([at(60), at(80), at(90)]).toEqual([levelColor(60), levelColor(80), levelColor(90)])
  const full = bar(100, 10)
  expect(full.map(one => one.text).join('')).toBe('━'.repeat(10))
  expect(full[0]?.color).toBe(COLOR.ok)
  expect(full[full.length - 1]?.color).toBe(COLOR.danger)
  const low = bar(20, 10)
  expect(low).toEqual([{ text: '━━', color: COLOR.ok }, { text: '─'.repeat(8), color: COLOR.track }])
  expect(bar(0, 10)).toEqual([{ text: '─'.repeat(10), color: COLOR.track }])
})

test('百分比四档：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红', () => {
  expect([59, 60, 79, 80, 89, 90, 100].map(levelColor)).toEqual([COLOR.ok, COLOR.warn, COLOR.warn, COLOR.high, COLOR.high, COLOR.danger, COLOR.danger])
})

test('一行几段截到格数以内：放不下的那段截短加 …，后面的丢掉', () => {
  const line = [{ text: 'anvil' }, { text: ' · ', color: COLOR.icon }, { text: '中文分支名', color: COLOR.branch }]
  expect(fitSegments(line, 20)).toEqual(line)
  expect(fitSegments(line, 12)).toEqual([{ text: 'anvil' }, { text: ' · ', color: COLOR.icon }, { text: '中…', color: COLOR.branch }])
})
