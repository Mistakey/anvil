import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneCloseInput, PromptSubmitInput, Register, RenderInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import * as cacheState from './cache'
import type { Cache, ResumeFields, Submission } from './cache'

import { COMMAND, answer } from './command'
import type { Subcommand } from './command'
import { PANE, PANEL_SUBCOMMAND, drawPanel, gridRow, hidesPanel, innerWidth } from './panel'
import { readSettings } from './settings'
import { EMPTY_USAGE, applyReading, compacted as addCompaction, completeTurn, startTurn, usageRows } from './usage'
import type { Reading } from './usage'
import type { Settings } from '../types'

// 模块结构（照 flightdeck 的 register.tsx / core.ts），引擎扫描源码的规则见 AGENTS.md Pitfalls「模块结构」：
// - 所有 on(...) 都写在下面的 register 里；用到 `$` 的辅助函数写在本文件顶层（`$` 不能跨文件传）。
//   功能文件（settings.ts、command.ts 等）只放不碰 `$` 的纯逻辑和界面组件，由这里调用。
// - 几个功能都要的事件（session.start 等）只注册一次、不带匹配器：处理函数里按写下的顺序依次调用各功能，
//   先后顺序就是处理函数里的行序。新功能往这类事件里加一行调用，放在它依赖的功能之后、`/anvil` 命令之前。
// - 只属于一个功能的事件用真匹配器注册（带 args 的 command.run、按 requestId 的 Pane ui.render 等），
//   不用 `{}` 空匹配器。新功能的子命令说明加进 SUBCOMMANDS，执行写成带 args 匹配器的 command.run，
//   注册在兜底的 command.run 之前。
// - 面板的区块（panel.tsx 的 SECTIONS）由各功能填内容：在 drawAnvilPanel 里把该区块的 SectionBody
//   放进 bodies；身份栏接在 drawPanel 的区块之后。

// ---------------------------------------------------------------- 设置

const SETTINGS = { plugin: 'anvil', key: 'settings' } as const

/** 把生效的设置写进 `$.state`，供拿不到 options 的读者（测试）核对 */
async function publishSettings($: EngineInterface, settings: Settings) {
  await $.state.set(SETTINGS, settings)
}

// ---------------------------------------------------------------- 缓存状态（D1、D2）与冷发送守卫（D4）

const CACHE = { plugin: 'anvil', key: 'cache' } as const

/** 把缓存状态的读数写进 `$.state`，缓存框和测试从这里读 */
async function publishCache($: EngineInterface, cache: Cache) {
  await $.state.set(CACHE, cacheState.view(cache))
}

/** 会话开始（含重新加载模块）：取计价用的模型和引擎的实时上下文；还没有请求，不判过期 */
async function startCache($: EngineInterface, cache: Cache) {
  cache.model = await $.session.model()
  const live = (await $.session.usage()).context.tokens
  if (live !== undefined && live > 0) cache.context = live
  await publishCache($, cache)
}

/** `classic.SessionStart`：`/clear` 清零；恢复会话按引擎给的字段起步 */
async function resumeCache($: EngineInterface, cache: Cache, e: ResumeFields) {
  if (e.source === 'clear') cacheState.resetForClear(cache)
  else cacheState.seedFromResume(cache, e, await $.clock.now())
  await publishCache($, cache)
}

/** 主会话一次请求开始：过期时刻顺延 */
async function stepStarted($: EngineInterface, cache: Cache) {
  cacheState.stampRequest(cache, await $.clock.now())
  await publishCache($, cache)
}

/** 主会话一次请求的回复到了 */
async function stepAnswered($: EngineInterface, cache: Cache, usage: TurnUsage) {
  cacheState.recordResponse(cache, usage)
  await publishCache($, cache)
}

/** 主会话一轮结束 */
async function turnCompleted($: EngineInterface, cache: Cache, e: TurnCompleteInput) {
  const now = await $.clock.now()
  // turn.step 记下的是请求的确切时刻；这一轮没有一次 step 记过时，以轮末为下限（cache-tax 的做法）
  if (now - cache.lastRequestAt > e.durationMs) cacheState.stampRequest(cache, now)
  if (e.usage) {
    const live = (await $.session.usage()).context.tokens
    cacheState.recordTurn(cache, e.usage, cache.context, live, now)
  }
  await publishCache($, cache)
}

async function compacted($: EngineInterface, cache: Cache) {
  cacheState.recordCompact(cache)
  await publishCache($, cache)
}

/** 守卫：该拦就记下这段过期已拦过，返回提示行；不拦返回 null */
async function guardSubmission($: EngineInterface, cache: Cache, submission: Submission, threshold: number): Promise<string | null> {
  const now = await $.clock.now()
  if (!cacheState.shouldGuard(cache, submission, threshold, now)) return null
  cache.ackedFor = cache.expiresAt
  // drop 之后引擎不一定把原文留在主输入框（D11 待实测）：等 drop 落定，主输入框空着就放回去
  $.clock.after(0, () => { void restoreDraft($, submission.text) })
  return cacheState.guardText(cache, now)
}

/** 主输入框空着时，把被拦的原文放回去；引擎已保留原文或用户已在写别的，就不动 */
async function restoreDraft($: EngineInterface, text: string) {
  try {
    const box = await $.prompt.read()
    if (box.text.trim() === '') await $.prompt.fill({ text, mode: 'replace' })
  } catch {
    // 没有主输入框（headless）或读写被拒：提示行仍在，用户可以重新输入
  }
}

// ---------------------------------------------------------------- 用量框

const usage = atom({ plugin: 'anvil', key: 'usage' } as const, EMPTY_USAGE)

/** 会话现在的花费；拿不到读数（无头、SDK 宿主）时为 null */
async function costNow($: EngineInterface): Promise<number | null> {
  const now = await $.session.usage().catch(() => null)
  return now?.cost?.usd ?? null
}

async function noteReading($: EngineInterface, reading: Reading) {
  await update($, usage, current => applyReading(current, reading))
}

async function startUsage($: EngineInterface) {
  const reading = await $.session.usage().catch(() => null)
  if (reading) await noteReading($, reading)
}

async function startUsageTurn($: EngineInterface) {
  const cost = await costNow($)
  await update($, usage, current => startTurn(current, cost))
}

async function completeUsageTurn($: EngineInterface) {
  const cost = await costNow($)
  await update($, usage, current => completeTurn(current, cost))
}

async function noteCompaction($: EngineInterface) {
  await update($, usage, current => addCompaction(current))
}

// ---------------------------------------------------------------- anvil 面板

const panelHidden = atom({ plugin: 'anvil', key: 'panelHidden' } as const, false)

async function openPanel($: EngineInterface) {
  // 不设 closeOnEscape：Esc 只把按键交回主输入框，面板留着（spec D9）
  return $.ui.open({ id: PANE.id, title: PANE.title, columns: PANE.columns })
}

/** 会话开始时自己打开；终端不够宽时引擎先不放下，等用户下一次提交消息 */
async function startPanel($: EngineInterface) {
  if (await read($, panelHidden)) return
  // 不等它画出来：会话开始的钩子还没返回，画不了
  void openPanel($).catch(() => undefined)
}

/** 用户提交消息时，面板该在却还没放下，就再开一次：这次算用户请求，110 列即可停靠 */
async function reopenPanel($: EngineInterface, e: PromptSubmitInput) {
  if (e.origin.kind !== 'composer') return
  if (await read($, panelHidden)) return
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === PANE.id && pane.isPlaced)) return
  await openPanel($).catch(() => undefined)
}

async function hidePanel($: EngineInterface) {
  await update($, panelHidden, () => true)
  await $.ui.close({ id: PANE.id })
  return '已隐藏 anvil 面板（本会话）。/anvil panel show 重新显示。'
}

async function showPanel($: EngineInterface) {
  await update($, panelHidden, () => false)
  const opened = await openPanel($)
  return opened.isPlaced ? '已显示 anvil 面板。' : `anvil 面板暂时放不下：${opened.reason}`
}

async function notePanelClosed($: EngineInterface, e: PaneCloseInput) {
  if (hidesPanel(e.origin)) await update($, panelHidden, () => true)
}

async function drawAnvilPanel($: EngineInterface, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e)
  const [current, now] = await Promise.all([read($, usage), $.clock.now()])
  const inner = innerWidth(e.props.bodyColumns)
  return drawPanel(els, {
    columns: e.props.bodyColumns,
    rows: e.props.scroll.bodyRows,
    bodies: { usage: { rows: usageRows(current, now, inner).map(row => gridRow(els, row, inner)) } },
  })
}

// ---------------------------------------------------------------- /anvil 命令

// 各功能交出的 /anvil 子命令说明，按列出的顺序排
const SUBCOMMANDS: readonly Subcommand[] = [PANEL_SUBCOMMAND]

async function registerAnvil($: EngineInterface) {
  await $.command.register({ name: 'anvil', description: COMMAND.description, argumentHint: COMMAND.argumentHint })
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const cache = cacheState.freshCache()

  on('session.start', async ($, e, next) => {
    await publishSettings($, settings)
    // 功能在这里按顺序接入
    await startCache($, cache)
    await startUsage($)
    await startPanel($)
    await registerAnvil($)
    return next(e)
  })

  // `/clear`、恢复会话不触发 session.start，只走这里
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await resumeCache($, cache, e)
    return result
  })

  on('turn.start', async ($, e, next) => {
    await startUsageTurn($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    await stepStarted($, cache)
    const result = yield* next(e)
    if (result.usage) await stepAnswered($, cache, result.usage)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await turnCompleted($, cache, e)
      await completeUsageTurn($)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await noteReading($, e)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // precompute 只预先算好摘要、不换掉对话；被否决的压缩也没换
    if (!e.agentId && e.trigger !== 'precompute' && result.skip === undefined) {
      await compacted($, cache)
      await noteCompaction($).catch(() => undefined)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // 先补开面板，再过守卫：用户按了 Enter 就算用户请求，守卫拦下这条时面板照样打开（缓存框正好说明为什么拦）
    await reopenPanel($, e).catch(() => undefined)
    if (settings.guard) {
      const drop = await guardSubmission($, cache, e, settings.threshold)
      if (drop !== null) return { drop }
    }
    return next(e)
  })

  on('ui.close', { id: 'anvil' }, async ($, e, next) => {
    await notePanelClosed($, e).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'anvil' }, async ($, e) => drawAnvilPanel($, e))

  // 功能自己的子命令在这里接入（带 args 匹配器），兜底的放最后
  on('command.run', { command: 'anvil', args: /^\s*panel\s+hide\s*$/ }, async $ => ({ text: await hidePanel($) }))
  on('command.run', { command: 'anvil', args: /^\s*panel\s+show\s*$/ }, async $ => ({ text: await showPanel($) }))

  // 兜底回答功能没接走的 /anvil
  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(SUBCOMMANDS, e.args) }))
}