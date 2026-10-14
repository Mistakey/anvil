import { expect, test } from 'claude-code/testing'

import { COLOR } from '../hooks/style'

// 色板（spec D10，anvil-k0t.46）：按面板的底色量对比度（WCAG 相对亮度）：引擎给面板画的 #262626，
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
    for (const name of ['secondary', 'ok', 'warn', 'high', 'danger', 'cache', 'usage', 'agents', 'denials', 'branch', 'active'] as const) {
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

test('五个框的边框一样亮（对面板底约 2.8:1，和线同一档）：彩框是识别色同色相调暗的一档，标题保留原色', () => {
  const ground = '#262626'
  const borders = [COLOR.cacheLine, COLOR.usageLine, COLOR.agentsLine, COLOR.denialsLine, COLOR.line]
  for (const border of borders) {
    expect(Math.abs(contrast(border, ground) - 2.8), border).toBeLessThan(0.1)
    // 边框比图标暗，不和框里的字抢
    expect(contrast(border, ground)).toBeLessThan(contrast(COLOR.icon, ground))
  }
  // 标题原色比边框亮得多
  for (const [title, border] of [[COLOR.cache, COLOR.cacheLine], [COLOR.usage, COLOR.usageLine], [COLOR.agents, COLOR.agentsLine], [COLOR.denials, COLOR.denialsLine]] as const) {
    expect(contrast(title, ground) / contrast(border, ground), title).toBeGreaterThan(1.8)
  }
})

test('翻译框的线和引擎主输入框的线同色；失败时换成危险红，亮度相近（只换色相）', () => {
  expect(COLOR.promptLine).toBe('#888888')
  const ground = '#282a36'
  expect(Math.abs(contrast(COLOR.danger, ground) - contrast(COLOR.promptLine, ground))).toBeLessThan(1)
})
