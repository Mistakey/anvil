// 缓存框（spec D8、D10）：三行。缓存图标 | 本会话命中率；● | 过期状态；保活。名称一列和用量框同宽，两框的值从同一列起。
// 读数来自 `$.state` 的 anvil.cache（缓存状态）和保活状态（keepalive.ts），绘制在 register.ts 和 panel.tsx。

import type { CacheView } from '../types'
import { COLOR, ICON, SEPARATOR, piece, valueWidth } from './style'
import type { Segment } from './style'
import { wrap } from './text'
import { formatWhen, layoutRow } from './usage'
import type { GridRow, GridSpec } from './usage'

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

/**
 * ● | 过期状态，● 和状态词同色。好状态只给符号和状态词上色："● 有效 · 过期 21:40"里 ● 有效绿、"过期"次要色、时刻正文色；
 * 过期了整句红："● 已过期 N 分钟"。还没有请求、刚压缩完时"● —"（● 图标色、— 次要色），框始终三行
 */
function stateRow(view: CacheView, now: number): GridSpec {
  if (view.expiresAt === null || view.compacted) return { key: 'state', label: [{ text: '●', color: COLOR.icon }], value: [piece([{ text: '—', color: COLOR.secondary }])] }
  if (now >= view.expiresAt) {
    return { key: 'state', label: [{ text: '●', color: COLOR.danger }], value: [piece([{ text: `已过期 ${formatExpired(now - view.expiresAt)}`, color: COLOR.danger }])] }
  }
  const value: Segment[] = [{ text: '有效', color: COLOR.ok }, SEPARATOR, { text: '过期 ', color: COLOR.secondary }, { text: formatWhen(view.expiresAt, now) }]
  return { key: 'state', label: [{ text: '●', color: COLOR.ok }], value: [piece(value)] }
}

/** 缓存框的几行，按框内宽度 inner 排好（layoutRow） */
export function cacheRows(view: CacheView, keepalive: Segment, now: number, inner: number): GridRow[] {
  const session = view.hitRate.session
  // 不写"命中率"，名称一列放缓存图标；还没有读数写 —，不写像算出来的 0
  const hit: Segment = session === null ? { text: '—' } : { text: `${Math.round(session * 100)}%`, color: hitColor(session) }
  const rows: GridSpec[] = [
    { key: 'cache', label: [{ text: ICON.cache, color: COLOR.icon }], value: [piece([hit])] },
    stateRow(view, now),
    // 状态字长（如出错原因）时逐行折下去，同一个颜色
    {
      key: 'keepalive',
      label: '保活',
      value: wrap(keepalive.text, valueWidth(inner), Number.MAX_SAFE_INTEGER).map(line => piece([{ ...keepalive, text: line }], { text: ' ' })),
    },
  ]
  return rows.map(row => layoutRow(row, inner))
}
