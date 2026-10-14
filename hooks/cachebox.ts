// 缓存框（spec D8、D10）：两行。缓存图标 | 本会话命中率；保活。过期状态交还 statusline（它有引擎给的真实过期时刻，2026-10-14 用户定）。
// 读数来自 `$.state` 的 anvil.cache（缓存状态）和保活状态（keepalive.ts），绘制在 register.ts 和 panel.tsx。

import type { CacheView } from '../types'
import { COLOR, ICON, piece, valueWidth } from './style'
import type { Segment } from './style'
import { wrap } from './text'
import { layoutRow } from './usage'
import type { GridRow, GridSpec } from './usage'

/** 命中率低于 80% 变黄、低于 50% 变红，其余不着色 */
export function hitColor(rate: number): string | undefined {
  if (rate < 0.5) return COLOR.danger
  if (rate < 0.8) return COLOR.warn
  return undefined
}

/** 缓存框的几行，按框内宽度 inner 排好（layoutRow） */
export function cacheRows(view: CacheView, keepalive: Segment, inner: number): GridRow[] {
  const session = view.hitRate.session
  // 不写"命中率"，名称一列放缓存图标；还没有读数写 —，不写像算出来的 0
  const hit: Segment = session === null ? { text: '—' } : { text: `${Math.round(session * 100)}%`, color: hitColor(session) }
  const rows: GridSpec[] = [
    { key: 'cache', label: [{ text: ICON.cache, color: COLOR.icon }], value: [piece([hit])] },
    // 状态字长（如出错原因）时逐行折下去，同一个颜色
    {
      key: 'keepalive',
      label: '保活',
      value: wrap(keepalive.text, valueWidth(inner), Number.MAX_SAFE_INTEGER).map(line => piece([{ ...keepalive, text: line }], { text: ' ' })),
    },
  ]
  return rows.map(row => layoutRow(row, inner))
}
