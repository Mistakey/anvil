// 每段回复的速度和首字：接在原生收尾那行（TurnDuration）后面。本会话的平均已去掉（用户 2026-10-14 定，面板随之去掉）。
// token/s 照 .51 探针：首字是响应的第一块（引擎的信封也算），结束是 stop 那块，只算主会话；
// 思考不出正文，只隔一阵来一个空的 thinking 块，有时整段思考只在结尾来一个，跳过 engine 块会把思考的时间漏掉。
// 首字等待从请求开始算到首字。一段里几次请求合起来时 token/s 按 token 加权（总输出 ÷ 总生成用时）。
// 只放不碰 `$` 的纯逻辑和界面组件；记请求时刻在 register.ts。

import type { Elements, RenderElement } from 'claude-code'

import type { SpeedTally, TurnSpeed } from '../types'
import { formatDuration } from './cache'
import { cells } from './text'

export const EMPTY_TALLY: SpeedTally = { requests: 0, output: 0, generationMs: 0, firstTokenMs: 0, isLowerBound: false }

// ---------------------------------------------------------------- 速度

/**
 * 比这还快的不是流出来的，是整段一起到的：.51 探针里真流出来的 Opus 5.5 是 55–107、Haiku 5.5 是 189–247 token/s，
 * 整段一起到的算出来是 1980–9229
 */
const STREAM_CEILING = 1000

/**
 * 一次请求的读数：生成用时是首字到结束；整段一起到（快过 STREAM_CEILING）或只来了 stop 那块时退回整次用时，
 * 只会偏低不会偏高，标 isLowerBound。没有结束、没有输出或跨度不为正时算不出
 */
export function requestSpeed(output: number | null | undefined, startAt: number, firstAt: number | null, stopAt: number | null): SpeedTally | null {
  if (output == null || output <= 0 || stopAt === null) return null
  const first = firstAt ?? stopAt
  const isStreamed = stopAt > first && output / ((stopAt - first) / 1000) <= STREAM_CEILING
  const generationMs = isStreamed ? stopAt - first : stopAt - startAt
  if (generationMs <= 0) return null
  return { requests: 1, output, generationMs, firstTokenMs: first - startAt, isLowerBound: !isStreamed }
}

/**
 * 合起来：次数和首字都加。token/s 只用量得出流速的请求：一边是下限、一边量得出时只留量得出的那边，
 * 平均不会因为一次整段一起到的请求就一直标 ≥（用户 2026-10-14 反馈）；都是下限时才按下限合计
 */
export function addTally(a: SpeedTally, b: SpeedTally): SpeedTally {
  const counted = (one: SpeedTally) => one.requests > 0 && one.generationMs > 0
  const rate = !counted(a) ? b : !counted(b) ? a : a.isLowerBound === b.isLowerBound ? null : a.isLowerBound ? b : a
  return {
    requests: a.requests + b.requests,
    output: rate ? rate.output : a.output + b.output,
    generationMs: rate ? rate.generationMs : a.generationMs + b.generationMs,
    firstTokenMs: a.firstTokenMs + b.firstTokenMs,
    isLowerBound: rate ? rate.isLowerBound : a.isLowerBound,
  }
}

/** 按 token 加权：总输出 ÷ 总生成用时，不是把每次的速度再平均；还没有请求时为 null */
export function tokensPerSecond(tally: SpeedTally): number | null {
  return tally.requests > 0 && tally.generationMs > 0 ? Math.round(tally.output / (tally.generationMs / 1000)) : null
}

/** 速度的数字；计入的请求都用了退路时前面标 ≥（照 coralline） */
function speedNumber(tally: SpeedTally): string | null {
  const speed = tokensPerSecond(tally)
  return speed === null ? null : `${tally.isLowerBound ? '≥' : ''}${speed}`
}

/** 秒数：不到 60 秒一位小数（12.7s），60 秒起写 1m35s */
export function formatSeconds(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100)
  return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : formatDuration(ms)
}

// ---------------------------------------------------------------- 每段回复末尾

/**
 * 原生收尾那行的时长写法（Claude Code 2.1.299 的 formatDuration，不带 hideTrailingZeros）：
 * 不到 1 分钟按整秒往下取（4s），往上 1m 4s、1h 2m 3s、1d 2h 3m，秒数四舍五入
 */
export function engineDuration(ms: number): string {
  if (ms < 60_000) return ms === 0 ? '0s' : ms < 1 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 1000)}s`
  let days = Math.floor(ms / 86_400_000)
  let hours = Math.floor((ms % 86_400_000) / 3_600_000)
  let minutes = Math.floor((ms % 3_600_000) / 60_000)
  let seconds = Math.round((ms % 60_000) / 1000)
  if (seconds === 60) (seconds = 0), (minutes += 1)
  if (minutes === 60) (minutes = 0), (hours += 1)
  if (hours === 24) (hours = 0), (days += 1)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  return `${minutes}m ${seconds}s`
}

const two = (n: number) => String(n).padStart(2, '0')

/** 本地时刻 HH:MM：原生那行的"done 15:43" */
export function clockTime(at: number): string {
  const date = new Date(at)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/**
 * 原生收尾那行画出的字（图标之后）：`Baked for 1m 4s · done 15:43`；
 * 收尾时还有子 agent 在跑，写成 `Waiting for 1 background agent to finish`
 */
export function engineTurnText(props: { word: string; durationMs: number }, turn: Pick<TurnSpeed, 'doneAt' | 'waitingAgents'>): string {
  const count = turn.waitingAgents
  if (count > 0) return `Waiting for ${count} background ${count === 1 ? 'agent' : 'agents'} to finish`
  return `${props.word} for ${engineDuration(props.durationMs)} · done ${clockTime(turn.doneAt)}`
}

/** 接在原生那行后面的字：` · N token/s · 首字 N s`，这一段的请求都用了退路时 token/s 前标 ≥ */
export function turnSuffix(turn: TurnSpeed): string {
  const speed = speedNumber(turn.tally)
  return `${speed === null ? '' : ` · ${speed} token/s`} · 首字 ${formatSeconds(turn.firstTokenMs)}`
}

/** 原生那行的图标占 2 格（minWidth 2），字从第 3 格起 */
const ENGINE_ICON_CELLS = 2

/**
 * 原生收尾那行接上这一段的读数。原生那行宽 100%、拿不到它画了多宽，引擎也不许把它放进带 width 的 Box：
 * 读数用绝对定位压在它的最后一行上，起点按原生的写法算出来（anvil-k0t.52 伪终端实测）
 */
export function turnDurationRow(els: Pick<Elements['terminal'], 'Box' | 'Text'>, native: RenderElement, props: { word: string; durationMs: number }, turn: TurnSpeed): RenderElement {
  const { Box, Text } = els
  return (
    <Box>
      {native}
      <Box position="absolute" bottom={0} left={ENGINE_ICON_CELLS + cells(engineTurnText(props, turn))}>
        <Text dimColor wrap="truncate">
          {turnSuffix(turn)}
        </Text>
      </Box>
    </Box>
  )
}
