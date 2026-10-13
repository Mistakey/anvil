import { atom, read, update } from 'claude-code'
import type {
  AgentSpawnInput,
  EngineInterface,
  PaneCloseInput,
  PromptSubmitInput,
  Register,
  RenderInput,
  ToolCallInput,
  ToolCallResult,
  TurnCompleteInput,
  TurnStepInput,
  TurnStepResult,
  TurnUsage,
  UiScrollInput,
} from 'claude-code'

import { agentList, callAgent, completeAgent, spawnAgent, stepAgent } from './agents'

import * as cacheState from './cache'
import type { Cache, ResumeFields, Submission } from './cache'
import { cacheRows, cacheStatus } from './cachebox'

import { COMMAND, answer } from './command'
import type { Subcommand } from './command'
import { describeInput } from './describe'
import {
  KEEPALIVE_SUBCOMMAND,
  LIMIT_STOP,
  PING_PROMPT,
  disarm,
  dueAction,
  freshLoop,
  isEnabled,
  keepaliveStatus,
  loopView,
  nextDelay,
  renew,
  startStretch,
  stopFor,
  thrownStop,
} from './keepalive'
import type { Loop } from './keepalive'
import { CLOSED, isClosed, scrollList, toggleDetail, toggleList } from './list'
import { PANE, PANEL_SUBCOMMAND, drawPanel, gridRow, hidesPanel, innerWidth } from './panel'
import { readSettings } from './settings'
import {
  EMPTY_BOX,
  TRANSLATE_SUBCOMMAND,
  apiReply,
  apiRequest,
  appendText,
  countWords,
  drawTranslateBox,
  failed,
  fillRefusal,
  inputKey,
  modelReply,
  modelRequest,
  startTranslating,
  translated,
  typed,
} from './translate'
import type { Translation } from './translate'
import { EMPTY_USAGE, applyReading, compacted as addCompaction, completeTurn, startTurn, usageRows } from './usage'
import type { GridRow, Reading } from './usage'
import type { KeepaliveStop, ListId, Settings, SubAgent } from '../types'

// 模块结构（照 flightdeck 的 register.tsx / core.ts），引擎扫描源码的规则见 AGENTS.md Pitfalls「模块结构」：
// - 所有 on(...) 都写在下面的 register 里；用到 `$` 的辅助函数写在本文件顶层（`$` 不能跨文件传）。
//   功能文件（settings.ts、command.ts 等）只放不碰 `$` 的纯逻辑和界面组件，由这里调用。
// - 几个功能都要的事件（session.start 等）只注册一次、不带匹配器：处理函数里按写下的顺序依次调用各功能，
//   先后顺序就是处理函数里的行序。新功能往这类事件里加一行调用，放在它依赖的功能之后、`/anvil` 命令之前。
// - 只属于一个功能的事件用真匹配器注册（带 args 的 command.run、按 requestId 的 Pane ui.render 等），
//   不用 `{}` 空匹配器。新功能的子命令说明加进 SUBCOMMANDS，执行写成带 args 匹配器的 command.run，
//   注册在兜底的 command.run 之前。
// - 面板的区块（panel.tsx 的 SECTIONS）由各功能填内容：在 drawAnvilPanel 里把该区块的 SectionBody
//   放进 bodies；三个列表（我的消息、自动模式拒绝、子 agent）交 ListBody 放进 lists，按上限截、
//   "更早的"那行、展开和收成一行由 panel.tsx 按共同规则做（list.ts）。身份栏接在 drawPanel 的区块之后。
// - 主输入框上方的 band（AbovePrompt）只画翻译框（translate.tsx），不放别的功能。

// ---------------------------------------------------------------- 设置

const SETTINGS = { plugin: 'anvil', key: 'settings' } as const

/** 把生效的设置写进 `$.state`，供拿不到 options 的读者（测试）核对 */
async function publishSettings($: EngineInterface, settings: Settings) {
  await $.state.set(SETTINGS, settings)
}

// ---------------------------------------------------------------- 缓存状态（D1、D2）与冷发送守卫（D4）

const CACHE = { plugin: 'anvil', key: 'cache' } as const
const cacheView = atom(CACHE, cacheState.view(cacheState.freshCache()))

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

// ---------------------------------------------------------------- 缓存保活（D3），循环照 cache-tax 的 keepwarm

const keepaliveOff = atom({ plugin: 'anvil', key: 'keepaliveOff' } as const, false)
const keepaliveLoop = atom({ plugin: 'anvil', key: 'keepalive' } as const, loopView(freshLoop()))

async function publishLoop($: EngineInterface, loop: Loop) {
  await update($, keepaliveLoop, () => loopView(loop))
}

/** 按缓存状态重新定时（cache-tax 的 arm）：没开、已停下、冷了都不定时；这段空闲到上限就停下 */
async function armKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  disarm(loop)
  if (loop.stopped || !isEnabled(settings, await read($, keepaliveOff), cache.context)) return publishLoop($, loop)
  const delay = nextDelay(cache, await $.clock.now())
  if (delay === 'limit') return stopKeepalive($, loop, LIMIT_STOP)
  if (delay !== null) loop.pending = $.clock.after(delay, () => void pingKeepalive($, cache, loop, settings).catch(() => undefined))
  await publishLoop($, loop)
}

async function stopKeepalive($: EngineInterface, loop: Loop, stop: KeepaliveStop) {
  disarm(loop)
  loop.stopped = stop
  await publishLoop($, loop)
}

/** 定时器到点：发一次 fork，读数达标就续期、再定时，否则停下（cache-tax 的 ping） */
async function pingKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  loop.pending = null
  if (loop.stopped || loop.inFlight) return
  if (!isEnabled(settings, await read($, keepaliveOff), cache.context)) return publishLoop($, loop)
  const now = await $.clock.now()
  const action = dueAction(cache, now)
  if (action === 'limit') return stopKeepalive($, loop, LIMIT_STOP)
  if (action === 'rearm') return armKeepalive($, cache, loop, settings)

  const stretch = cache.lastRequestAt
  loop.inFlight = true
  await publishLoop($, loop)
  let stop: KeepaliveStop | null
  try {
    stop = stopFor(await $.model.fork({ prompt: PING_PROMPT }))
  } catch (error) {
    stop = thrownStop(error)
  }
  loop.inFlight = false
  // 请求路上用户回来发了消息：这一段空闲已经结束，结果不再算到新的一段上（cache-tax 没有这层）
  if (cache.lastRequestAt !== stretch) return publishLoop($, loop)
  if (stop) return stopKeepalive($, loop, stop)
  renew(cache, now)
  loop.renewals += 1
  await publishCache($, cache)
  await armKeepalive($, cache, loop, settings)
}

async function turnKeepaliveOff($: EngineInterface, loop: Loop) {
  await update($, keepaliveOff, () => true)
  disarm(loop)
  await publishLoop($, loop)
  return '已关闭缓存保活（本会话）。/anvil keepalive on 重新启用。'
}

/** 重新启用：本会话的关闭和这一段空闲的停下都清掉，按缓存状态重新定时 */
async function turnKeepaliveOn($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  await update($, keepaliveOff, () => false)
  loop.stopped = null
  await armKeepalive($, cache, loop, settings)
  return settings.autoKeepalive ? '已重新启用缓存保活。' : '已重新启用缓存保活；/config 里关掉了自动开启，本会话仍不保活。'
}

// ---------------------------------------------------------------- 缓存框

/** 缓存框随时刻变的部分要重画：过期那一刻改写"已过期"，之后每分钟更新过期时长 */
type Redraw = { timer: { cancel: () => void } | null }

const EXPIRED_REDRAW_MS = 60 * 1000

async function scheduleRedraw($: EngineInterface, cache: Cache, redraw: Redraw) {
  redraw.timer?.cancel()
  redraw.timer = null
  if (cache.expiresAt === 0 || cache.compacted) return
  const now = await $.clock.now()
  const wait = now < cache.expiresAt ? cache.expiresAt - now : EXPIRED_REDRAW_MS
  redraw.timer = $.clock.after(wait, () => {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // 没有界面（headless、plugin test）：不用重画
    }
    void scheduleRedraw($, cache, redraw).catch(() => undefined)
  })
}

/** 缓存状态变了：保活按新的状态重新定时，缓存框定好下一次重画 */
async function cacheChanged($: EngineInterface, cache: Cache, loop: Loop, redraw: Redraw, settings: Settings) {
  await armKeepalive($, cache, loop, settings)
  await scheduleRedraw($, cache, redraw)
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

// ---------------------------------------------------------------- 子 agent 列表（数据来源照 flightdeck）

const agents = atom({ plugin: 'anvil', key: 'agents' } as const, [] as SubAgent[])

async function noteSpawn($: EngineInterface, e: AgentSpawnInput, agentId: string, model: string) {
  const at = await $.clock.now()
  await update($, agents, list => spawnAgent(list, { id: agentId, description: e.description, prompt: e.prompt, model, at }))
}

/** 子 agent 的一次请求结束；不在列表里的 id（引擎自己的 fork、工作流里没登记的）不管 */
async function noteAgentStep($: EngineInterface, e: TurnStepInput, agentId: string, result: TurnStepResult) {
  if (!(await read($, agents)).some(agent => agent.id === agentId)) return
  await update($, agents, list => stepAgent(list, agentId, { model: e.model, usage: result.usage, stopReason: result.stopReason ?? null }))
}

async function noteAgentCall($: EngineInterface, e: ToolCallInput, agentId: string, ran: ToolCallResult) {
  if (!(await read($, agents)).some(agent => agent.id === agentId)) return
  const isError = ran.deny !== undefined || ran.isError === true
  await update($, agents, list => callAgent(list, agentId, { tool: String(e.tool), text: describeInput(e), isError }))
}

async function noteAgentEnd($: EngineInterface, e: TurnCompleteInput, agentId: string) {
  if (!(await read($, agents)).some(agent => agent.id === agentId)) return
  const at = await $.clock.now()
  await update($, agents, list => completeAgent(list, agentId, { reason: e.reason, answer: e.answer, at }))
}

// ---------------------------------------------------------------- 面板按键：列表展开、详情、滚动（spec D9）

const fold = atom({ plugin: 'anvil', key: 'fold' } as const, CLOSED)

async function pressList($: EngineInterface, id: ListId) {
  await update($, fold, current => toggleList(current, id))
}

async function pressAgent($: EngineInterface, agentId: string) {
  await update($, fold, current => toggleDetail(current, agentId))
}

/** 展开的列表放不下时，滚轮滚的是列表自己（面板本身放得下，不需要引擎滚）；其余照引擎的 */
async function scrollPanel($: EngineInterface, e: UiScrollInput): Promise<boolean> {
  const current = await read($, fold)
  if (current.expanded === null || e.contentRows > e.bodyRows) return false
  const total = current.expanded === 'agents' ? (await read($, agents)).length : 0
  await update($, fold, () => scrollList(current, e.by, total))
  return true
}

/**
 * Esc 把焦点交回主输入框（引擎的固定键位，不经过 mod）：面板失去焦点后重画时按全收起画，
 * 并把展开状态清掉，下次再进面板也是收起的。
 */
async function foldForDrawing($: EngineInterface, isFocused: boolean) {
  const current = await read($, fold)
  if (isFocused || isClosed(current)) return current
  // 画的钩子里不能写 `$.state`：画完再清
  $.clock.after(0, () => void update($, fold, () => CLOSED).catch(() => undefined))
  return CLOSED
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

async function drawAnvilPanel($: EngineInterface, settings: Settings, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e)
  const [current, list, folding, now] = await Promise.all([read($, usage), read($, agents), foldForDrawing($, e.props.isFocused), $.clock.now()])
  const [cached, off, loop] = await Promise.all([read($, cacheView), read($, keepaliveOff), read($, keepaliveLoop)])
  const keepalive = keepaliveStatus({ settings, off, context: cached.context, loop })
  const inner = innerWidth(e.props.bodyColumns)
  const grid = (rows: GridRow[]) => rows.map(row => gridRow(els, row, inner))
  return drawPanel(els, {
    columns: e.props.bodyColumns,
    rows: e.props.scroll.bodyRows,
    bodies: {
      usage: { rows: grid(usageRows(current, now, inner)) },
      cache: { status: cacheStatus(cached, now), rows: grid(cacheRows(cached, keepalive, now, inner)) },
    },
    lists: { agents: agentList(els, list, { detail: folding.detail, now, inner, onPress: id => void pressAgent($, id) }) },
    fold: folding,
    onToggle: id => void pressList($, id),
  })
}

// ---------------------------------------------------------------- 翻译输入框（D5）与翻译后端（D6）

const translateBox = atom({ plugin: 'anvil', key: 'translate' } as const, EMPTY_BOX)
const translateHidden = atom({ plugin: 'anvil', key: 'translateHidden' } as const, false)

/** 按设置选的后端翻译一段中文 */
async function translateText($: EngineInterface, settings: Settings, text: string): Promise<Translation> {
  try {
    if (settings.translateBackend !== 'api') return modelReply(await $.model.complete(modelRequest(settings.translateBackend, text)))
    const request = apiRequest(settings.translateApiUrl, settings.translateApiModel, await $.env.get('ANVIL_TRANSLATE_API_KEY'), text)
    if ('error' in request) return request
    const response = await $.http.fetch(request.url, request.init)
    return apiReply(response.status, response.ok, response.text)
  } catch (error) {
    return { error: `请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 译文追加到主输入框末尾；返回 null 表示写进去了，否则是原因 */
async function appendToPrompt($: EngineInterface, translation: string): Promise<string | null> {
  try {
    const draft = await $.prompt.read().then(box => box.text, () => '')
    const filled = await $.prompt.fill({ text: appendText(draft, translation), mode: 'append' })
    return filled.isFilled ? null : fillRefusal(filled)
  } catch (error) {
    return `写入主输入框出错：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 翻译框里按 Enter：翻译、追加；中文留在框里，失败时显示原因，再按 Enter 重试 */
async function submitChinese($: EngineInterface, settings: Settings, value: string) {
  if (value.trim() === '') return
  if ((await read($, translateBox)).phase === 'working') return
  await update($, translateBox, box => startTranslating(box, value))
  const translation = await translateText($, settings, value)
  const refusal = 'error' in translation ? translation.error : await appendToPrompt($, translation.text)
  await update($, translateBox, box =>
    refusal === null && 'text' in translation ? translated(box, countWords(translation.text)) : failed(box, refusal ?? ''),
  )
}

/** 翻译框里改字：开始写下一句时换一代输入框，焦点交给新的那个 */
async function typeChinese($: EngineInterface, band: string, value: string) {
  const box = await read($, translateBox)
  const next = typed(box, value)
  if (next === null) return
  await update($, translateBox, () => next)
  // plugin test 里没有 ui.focus 的实现，会拒绝；焦点只能在交互会话里验证
  if (next.field !== box.field) await $.ui.focus({ requestId: band, key: inputKey(next) }).catch(() => undefined)
}

/** 画翻译框；隐藏了、有问卷占着那一栏时返回 null，让出来 */
async function drawTranslate($: EngineInterface, settings: Settings, e: RenderInput<'AbovePrompt'>) {
  // 先排除 mobile，resolve 出来的元素才有 Input
  if (e.surface === 'mobile' || e.props.hasSurvey || (await read($, translateHidden))) return null
  const els = $.ui.resolve(e)
  const box = await read($, translateBox)
  return drawTranslateBox(els, {
    columns: e.props.bodyColumns,
    box,
    onSubmit: value => void submitChinese($, settings, value),
    onInput: value => void typeChinese($, e.requestId, value),
  })
}

async function hideTranslate($: EngineInterface) {
  await update($, translateHidden, () => true)
  return '已隐藏翻译框（本会话）。/anvil translate show 重新显示。'
}

async function showTranslate($: EngineInterface) {
  await update($, translateHidden, () => false)
  return '已显示翻译框。'
}

// ---------------------------------------------------------------- /anvil 命令

// 各功能交出的 /anvil 子命令说明，按列出的顺序排
const SUBCOMMANDS: readonly Subcommand[] = [PANEL_SUBCOMMAND, TRANSLATE_SUBCOMMAND, KEEPALIVE_SUBCOMMAND]

async function registerAnvil($: EngineInterface) {
  await $.command.register({ name: 'anvil', description: COMMAND.description, argumentHint: COMMAND.argumentHint })
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const cache = cacheState.freshCache()
  const loop = freshLoop()
  const redraw: Redraw = { timer: null }

  on('session.start', async ($, e, next) => {
    await publishSettings($, settings)
    // 功能在这里按顺序接入
    await startCache($, cache)
    // 重新加载模块时循环是新的：换掉上一次加载留下的读数
    await publishLoop($, loop)
    await startUsage($)
    await startPanel($)
    await registerAnvil($)
    return next(e)
  })

  // `/clear`、恢复会话不触发 session.start，只走这里
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await resumeCache($, cache, e)
    // `/clear` 是新的对话，上一段空闲的停下不再算；恢复的会话按起步的缓存状态定时（冷了不发）
    if (e.source === 'clear') startStretch(loop)
    await cacheChanged($, cache, loop, redraw, settings)
    return result
  })

  on('turn.start', async ($, e, next) => {
    await startUsageTurn($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const agentId = e.agentId
      const result = yield* next(e)
      await noteAgentStep($, e, agentId, result).catch(() => undefined)
      return result
    }
    await stepStarted($, cache)
    // 用户回来了：这一段空闲结束，一轮结束时再定时（cache-tax 也是一轮结束才定时）
    startStretch(loop)
    await publishLoop($, loop)
    await scheduleRedraw($, cache, redraw)
    const result = yield* next(e)
    if (result.usage) await stepAnswered($, cache, result.usage)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await turnCompleted($, cache, e)
      await cacheChanged($, cache, loop, redraw, settings)
      await completeUsageTurn($)
    } else {
      await noteAgentEnd($, e, e.agentId).catch(() => undefined)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId) await noteSpawn($, e, started.agentId, started.model).catch(() => undefined)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) await noteAgentCall($, e, e.agentId, ran).catch(() => undefined)
    return ran
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
      await cacheChanged($, cache, loop, redraw, settings)
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

  on('ui.render', { component: 'Pane', requestId: 'anvil' }, async ($, e) => drawAnvilPanel($, settings, e))

  // 翻译框常驻在主输入框上方
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawTranslate($, settings, e)) ?? next(e))

  on('ui.scroll', { component: 'Pane', requestId: 'anvil' }, async ($, e, next) => {
    // 改了展开状态，引擎自己会重画
    if (await scrollPanel($, e).catch(() => false)) return {}
    return next(e)
  })

  // 功能自己的子命令在这里接入（带 args 匹配器），兜底的放最后
  on('command.run', { command: 'anvil', args: /^\s*panel\s+hide\s*$/ }, async $ => ({ text: await hidePanel($) }))
  on('command.run', { command: 'anvil', args: /^\s*panel\s+show\s*$/ }, async $ => ({ text: await showPanel($) }))
  on('command.run', { command: 'anvil', args: /^\s*translate\s+hide\s*$/ }, async $ => ({ text: await hideTranslate($) }))
  on('command.run', { command: 'anvil', args: /^\s*translate\s+show\s*$/ }, async $ => ({ text: await showTranslate($) }))
  on('command.run', { command: 'anvil', args: /^\s*keepalive\s+off\s*$/ }, async $ => ({ text: await turnKeepaliveOff($, loop) }))
  on('command.run', { command: 'anvil', args: /^\s*keepalive\s+on\s*$/ }, async $ => ({
    text: await turnKeepaliveOn($, cache, loop, settings),
  }))

  // 兜底回答功能没接走的 /anvil
  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(SUBCOMMANDS, e.args) }))
}