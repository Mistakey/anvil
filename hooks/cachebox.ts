// 缓存框（spec D8、D10）：两行。第一行名称的位置是缓存图标加本会话命中率，值是过期状态；第二行是保活。
// 读数来自 `$.state` 的 anvil.cache（缓存状态）和保活状态（keepalive.ts），绘制在 register.ts 和 panel.tsx。

import type { CacheView } from '../types'
import { COLOR, ICON, piece, valueWidth } from './style'
import type { Segment } from './style'
import { wrap } from './text'
import { formatWhen, layoutRow } from './usage'
import type { GridRow, GridSpec } from './usage'

/** 缓存框名称一列的宽度：放得下"图标 100%"，状态和保活从同一列起 */
export const CACHE_LABEL = 8

const MINUTE = 60_000

/** 过期了多久：不到 1 小时写"N 分钟"，1 小时起写"N 小时 M 分钟" */
export function formatExpired(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE))
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

/** 命中率低于 80% 变黄、低于 50% 变红，其余不着色 */
export function hitColor(rate: number): string | undefined {
  if (rate < 0.5) return COLOR.danger
  if (rate < 0.8) return COLOR.warn
  return undefined
}

/** "● 有效 · 21:40 过期"（绿）或"● 已过期 N 分钟"（红）；还没有请求、刚压缩完时不写 */
function cacheState(view: CacheView, now: number): Segment[] {
  if (view.expiresAt === null || view.compacted) return []
  if (now >= view.expiresAt) return [{ text: `● 已过期 ${formatExpired(now - view.expiresAt)}`, color: COLOR.danger }]
  return [{ text: `● 有效 · ${formatWhen(view.expiresAt, now)} 过期`, color: COLOR.ok }]
}

/** 缓存框的两行，按框内宽度 inner 排好（layoutRow） */
export function cacheRows(view: CacheView, keepalive: Segment, now: number, inner: number): GridRow[] {
  const session = view.hitRate.session
  // 不写"命中率"，用缓存图标代替；还没有读数写 —，不写像算出来的 0
  const hit: Segment[] = [
    { text: `${ICON.cache} `, color: COLOR.label },
    session === null ? { text: '—' } : { text: `${Math.round(session * 100)}%`, color: hitColor(session) },
  ]
  const state = cacheState(view, now)
  const rows: GridSpec[] = [
    { key: 'cache', label: hit, value: state.length > 0 ? [piece(state)] : [] },
    // 状态字长（如出错原因）时逐行折下去，同一个颜色
    {
      key: 'keepalive',
      label: '保活',
      value: wrap(keepalive.text, valueWidth(inner, CACHE_LABEL), Number.MAX_SAFE_INTEGER).map(line => piece([{ ...keepalive, text: line }], { text: ' ' })),
    },
  ]
  return rows.map(row => layoutRow(row, inner, CACHE_LABEL))
}
