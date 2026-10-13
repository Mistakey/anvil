// 缓存框（spec D8、D10，设计稿 Version 32 的状态对照画板）：上边框右侧的状态和四行。
// 读数来自 `$.state` 的 anvil.cache（缓存状态）和保活状态（keepalive.ts），绘制在 register.ts 和 panel.tsx。

import type { CacheView } from '../types'
import { formatDuration } from './cache'
import { COLOR, GRID, SEPARATOR, restWidth, spanWidth } from './style'
import type { Segment } from './style'
import { fitSegments, formatTokens, formatUsd, formatWhen } from './usage'
import type { GridRow } from './usage'

const muted = (text: string): Segment => ({ text, color: COLOR.muted })

const isExpired = (view: CacheView, now: number) => view.expiresAt !== null && !view.compacted && now >= view.expiresAt

/** 上边框右侧："● 有效 · 21:40 过期" 或 "○ 已过期 1h10m"；还没有请求、刚压缩完时不写 */
export function cacheStatus(view: CacheView, now: number): Segment[] {
  if (view.expiresAt === null || view.compacted) return []
  if (isExpired(view, now)) return [{ text: '○ 已过期', color: COLOR.danger }, muted(` ${formatDuration(now - view.expiresAt)}`)]
  return [{ text: '● 有效', color: COLOR.ok }, SEPARATOR, muted(`${formatWhen(view.expiresAt, now)} 过期`)]
}

/** 命中率低于 80% 变黄、低于 50% 变红，其余不着色 */
export function hitColor(rate: number): string | undefined {
  if (rate < 0.5) return COLOR.danger
  if (rate < 0.8) return COLOR.warn
  return undefined
}

function rate(label: string, value: number | null): Segment[] {
  if (value === null) return [muted(label), { text: ' —' }]
  return [muted(label), { text: ` ${Math.round(value * 100)}%`, color: hitColor(value) }]
}

/** 缓存框的四行：命中率、过期代价、已重建、保活；每行各列都已截到 inner 格（框内宽度）以内 */
export function cacheRows(view: CacheView, keepalive: Segment, now: number, inner: number): GridRow[] {
  const { rebuild, coldWrites } = view
  const rows: GridRow[] = [
    { key: 'cache-hit', label: '命中率', middle: rate('上一条消息', view.hitRate.last), rest: rate('本会话', view.hitRate.session) },
    {
      key: 'cache-cost',
      label: '过期代价',
      middle: [muted('重建'), { text: ` ${formatTokens(rebuild.tokens)} tokens`, color: isExpired(view, now) ? COLOR.danger : undefined }],
      rest: [muted('约'), { text: ` ${rebuild.usd === null ? '—' : formatUsd(rebuild.usd)}` }],
    },
    {
      key: 'cache-rebuilt',
      label: '已重建',
      middle: [muted('本会话'), { text: ` ${coldWrites.count} 次` }],
      rest: coldWrites.count > 0 ? [muted('共'), { text: ` ${formatUsd(coldWrites.usd)}` }] : [],
    },
    // 状态字长，占满后两列（设计稿 grid-column: 2 / -1）
    { key: 'keepalive', label: '保活', middle: [keepalive], rest: [], span: true },
  ]
  return rows.map(row => ({
    ...row,
    middle: fitSegments(row.middle, row.span ? spanWidth(inner) : GRID.middle),
    rest: fitSegments(row.rest, restWidth(inner)),
  }))
}
