// 缓存框（spec D8、D10，设计稿 Version 32 的状态对照画板）：上边框右侧的状态和四行。
// 读数来自 `$.state` 的 anvil.cache（缓存状态）和保活状态（keepalive.ts），绘制在 register.ts 和 panel.tsx。

import type { CacheView } from '../types'
import { formatDuration } from './cache'
import { COLOR, FIELD, SEPARATOR, piece, valueWidth } from './style'
import type { Segment } from './style'
import { wrap } from './text'
import { field, formatTokens, formatUsd, formatWhen, layoutRow } from './usage'
import type { GridRow, GridSpec } from './usage'

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

/** 命中率：定宽的百分比，没有读数写 — */
function rate(value: number | null, width: number): Segment {
  if (value === null) return { text: ` ${field('—', width)}` }
  return { text: ` ${field(`${Math.round(value * 100)}%`, width)}`, color: hitColor(value) }
}

/** 缓存框的四行：命中率、过期代价、已重建、保活；按框内宽度 inner 排好（layoutRow） */
export function cacheRows(view: CacheView, keepalive: Segment, now: number, inner: number): GridRow[] {
  const { rebuild, coldWrites } = view
  // 还没有任何主会话请求：没有可算的，和命中率一样写 —，不写像算出来的 0
  const unseen = view.expiresAt === null
  const tokens = unseen ? '—' : formatTokens(rebuild.tokens)
  const rows: GridSpec[] = [
    // 成对的值本会话在前、上一条在后；后面还有字的数值定宽，数字变长变短时不挪位置
    {
      key: 'cache-hit',
      label: '命中率',
      value: [piece([muted('本会话'), rate(view.hitRate.session, FIELD.percent)]), piece([muted('上一条'), rate(view.hitRate.last, 0)], SEPARATOR)],
    },
    {
      key: 'cache-cost',
      label: '过期代价',
      value: [
        piece([muted('重建 '), { text: `${field(tokens, FIELD.tokens)} tokens`, color: isExpired(view, now) ? COLOR.danger : undefined }]),
        piece([muted('≈'), { text: ` ${unseen || rebuild.usd === null ? '—' : formatUsd(rebuild.usd)}` }], { text: ' ' }),
      ],
    },
    {
      key: 'cache-rebuilt',
      label: '已重建',
      value: [
        piece([muted('本会话'), { text: unseen ? ' —' : ` ${coldWrites.count} 次` }]),
        ...(coldWrites.count > 0 ? [piece([muted('共'), { text: ` ${formatUsd(coldWrites.usd)}` }], SEPARATOR)] : []),
      ],
    },
    // 状态字长（如出错原因）时逐行折下去，同一个颜色
    {
      key: 'keepalive',
      label: '保活',
      value: wrap(keepalive.text, valueWidth(inner), Number.MAX_SAFE_INTEGER).map(line => piece([{ ...keepalive, text: line }], { text: ' ' })),
    },
  ]
  return rows.map(row => layoutRow(row, inner))
}
