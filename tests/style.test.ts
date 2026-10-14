import { expect, test } from 'claude-code/testing'

import { COLOR, HEAT, bar, edgeLine, levelColor } from '../hooks/style'

// 色板（spec D10，anvil-k0t.47）：按面板的底色量对比度（WCAG 相对亮度）：引擎给面板画的 #262626，
// 和翻译框所在的终端底色（用户的 Dracula #282a36）

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const GROUNDS = ['#262626', '#282a36']

test('文字用的颜色在面板底色上都不低于 4.5:1；图标不低于 3:1；线比图标暗', () => {
  for (const ground of GROUNDS) {
    for (const name of ['secondary', 'ok', 'warn', 'high', 'danger', 'cache', 'usage', 'agents', 'denials', 'active'] as const) {
      expect(contrast(COLOR[name], ground), `${name} / ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(COLOR.icon, ground), ground).toBeGreaterThanOrEqual(3)
    expect(contrast(COLOR.line, ground), ground).toBeLessThan(contrast(COLOR.icon, ground))
    expect(contrast(COLOR.line, ground), ground).toBeGreaterThanOrEqual(2)
  }
})

test('中性色只有三级，由亮到暗：次要文字、图标、线', () => {
  for (const ground of GROUNDS) {
    expect(contrast(COLOR.secondary, ground)).toBeGreaterThan(contrast(COLOR.icon, ground))
    expect(contrast(COLOR.icon, ground)).toBeGreaterThan(contrast(COLOR.line, ground))
  }
})

test('框：侧边是识别色同色相调暗的一档（3.2–3.6:1，比图标暗、比线亮）；标题原色比侧边亮得多', () => {
  const ground = '#262626'
  for (const side of [COLOR.cacheLine, COLOR.usageLine, COLOR.agentsLine, COLOR.denialsLine, COLOR.messagesLine]) {
    expect(contrast(side, ground), side).toBeGreaterThan(3.1)
    expect(contrast(side, ground), side).toBeLessThan(3.7)
    expect(contrast(side, ground), side).toBeLessThan(contrast(COLOR.icon, ground))
    expect(contrast(side, ground), side).toBeGreaterThan(contrast(COLOR.line, ground))
  }
  for (const [title, side] of [[COLOR.cache, COLOR.cacheLine], [COLOR.usage, COLOR.usageLine], [COLOR.agents, COLOR.agentsLine], [COLOR.denials, COLOR.denialsLine]] as const) {
    expect(contrast(title, ground) / contrast(side, ground), title).toBeGreaterThan(1.5)
  }
})

test('上边框：两角是侧边色；标题后面最亮（识别色七成），往右渐暗回侧边色；标题前那格三成半', () => {
  const line = edgeLine(51, 10, COLOR.cache, COLOR.cacheLine)
  const glyphs = line.map(one => one.text).join('')
  expect(glyphs).toBe(`╭${'─'.repeat(49)}╮`)
  expect(line[0]?.color).toBe(COLOR.cacheLine)
  expect(line[line.length - 1]?.color).toBe(COLOR.cacheLine)
  // 逐格的颜色
  const each = line.flatMap(one => [...one.text].map(() => one.color ?? ''))
  const bright = (x: number) => contrast(each[x] ?? '', '#262626')
  expect(bright(10)).toBeGreaterThan(bright(20))
  expect(bright(20)).toBeGreaterThan(bright(40))
  expect(each[45]).toBe(COLOR.cacheLine)
  expect(bright(1)).toBeGreaterThan(bright(2))
  expect(bright(10)).toBeGreaterThan(4.5)
})

test('进度条：已用部分按位置取热度色（45% 前绿，60、80、90% 正好是四档），底比线暗', () => {
  const at = (pos: number) => HEAT.find(([p]) => p === pos)?.[1]
  expect([at(60), at(80), at(90)]).toEqual([levelColor(60), levelColor(80), levelColor(90)])
  const full = bar(100, 30)
  expect(full.map(one => one.text).join('')).toBe('━'.repeat(30))
  expect(full[0]?.color).toBe(COLOR.ok)
  expect(full[full.length - 1]?.color).toBe(COLOR.danger)
  expect(new Set(full.map(one => one.color)).size).toBeGreaterThan(4)
  const low = bar(20, 30)
  expect(low.map(one => one.text).join('')).toBe(`${'━'.repeat(6)}${'─'.repeat(24)}`)
  expect(low[0]).toEqual({ text: '━━━━━━', color: COLOR.ok })
  expect(low[low.length - 1]?.color).toBe(COLOR.track)
  expect(contrast(COLOR.track, '#262626')).toBeLessThan(contrast(COLOR.line, '#262626'))
})

test('翻译框的线和引擎主输入框的线同色；失败时换成危险红，亮度相近（只换色相）', () => {
  expect(COLOR.promptLine).toBe('#888888')
  const ground = '#282a36'
  expect(Math.abs(contrast(COLOR.danger, ground) - contrast(COLOR.promptLine, ground))).toBeLessThan(1)
})
