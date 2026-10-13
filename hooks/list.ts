// 面板三个列表的共同规则（spec D8、D9）：旧的在上、新的在下；超出上限时顶部显示"▴ 更早的 N 条"；
// 展开一个列表时其余收成一行；Esc 收起。只放纯逻辑，绘制在 panel.tsx，状态的读写在 register.ts。

import type { ListId, PanelFold } from '../types'

/** 全收起：三个列表都按上限显示，没有展开的详情 */
export const CLOSED: PanelFold = { expanded: null, detail: null, scrolled: 0 }

export const isClosed = (fold: PanelFold) => fold.expanded === null && fold.detail === null && fold.scrolled === 0

/** a / d / m：展开这个列表，再按一次收起；换一个列表时滚动归零 */
export function toggleList(fold: PanelFold, id: ListId): PanelFold {
  return { ...fold, expanded: fold.expanded === id ? null : id, scrolled: 0 }
}

/** 1–9、Enter：展开这个子 agent 的详情，再按一次收起；同时只展开一个 */
export function toggleDetail(fold: PanelFold, agentId: string): PanelFold {
  return { ...fold, detail: fold.detail === agentId ? null : agentId }
}

/**
 * 展开的列表滚动：by 是引擎给的行数，负数朝上（看更早的）。
 * 按条滚，最多滚到只剩最早的一条在最下面；画的时候 fitRows 再按实际能放下的收紧。
 */
export function scrollList(fold: PanelFold, by: number, total: number): PanelFold {
  if (fold.expanded === null) return fold
  const scrolled = Math.min(Math.max(0, total - 1), Math.max(0, fold.scrolled - Math.sign(by) * Math.max(1, Math.round(Math.abs(by)))))
  return { ...fold, scrolled }
}

/** 一个列表这次画出哪几项：items.slice(start, end)；start 就是"更早的"条数 */
export type Fit = { start: number; end: number }

/** 收起时按条数取最新的 limit 条 */
export function fitCount(total: number, limit: number): Fit {
  return { start: Math.max(0, total - Math.max(1, limit)), end: total }
}

/**
 * 按行数取：从下往上放，放不下时顶部留一行给"▴ 更早的 N 条"。
 * heights 是每一项占的行数（展开详情的那项多几行），scrolled 是往上滚过的条数。
 * 至少画一项，哪怕它比 room 还高。
 */
export function fitRows(heights: readonly number[], room: number, scrolled = 0): Fit {
  const total = heights.length
  let end = total - Math.min(Math.max(0, scrolled), Math.max(0, total - 1))
  const fill = (from: number, rows: number) => {
    let start = from
    let used = 0
    while (start > 0 && used + (heights[start - 1] ?? 1) <= rows) {
      used += heights[start - 1] ?? 1
      start -= 1
    }
    return { start, used }
  }
  let { start, used } = fill(end, room)
  if (start > 0) ({ start, used } = fill(end, room - 1))
  // 滚过头了，上面已经全放下：把下面空出来的行补回较新的条目
  if (start === 0) {
    while (end < total && used + (heights[end] ?? 1) <= room) {
      used += heights[end] ?? 1
      end += 1
    }
  }
  if (start === end && end > 0) start = end - 1
  return { start, end }
}

/** 顶部那一行："▴ 更早的 N 个 · 按 a 展开"；展开的列表里放不下的，滚动查看 */
export function earlierText(count: number, unit: string, hotkey: string, isExpanded: boolean): string {
  return `更早的 ${count} ${unit} · ${isExpanded ? '向上滚动查看' : `按 ${hotkey} 展开`}`
}
