// anvil 的 hooks 入口：所有 on(...) 和用到 `$` 的辅助函数都在这里，结构说明见下面「模块结构」。
// 模块结构和子 agent 的接线照 flightdeck（https://github.com/scasella/claude-flightdeck）的 register.tsx / core.ts：
// MIT License, Copyright (c) 2026 Stephen Casella。缓存状态的估算和保活循环的接线照 cache-tax
// （https://github.com/karanb192/cache-tax，HEAD 06cac47）改写：MIT License, Copyright (c) 2026 Karan Bansal。
// 两份许可原文见 THIRD_PARTY_NOTICES.md。

import { atom, read, update } from 'claude-code'
import type {
  AgentSpawnInput,
  EngineInterface,
  PaneCloseInput,
  PromptSubmitInput,
  Register,
  ClassicEventOf,
  RenderInput,
  RenderSurface,
  SessionAppendMessage,
  ToolCallInput,
  ToolCallResult,
  TurnCompleteInput,
  TurnStepInput,
  TurnStepResult,
  TurnUsage,
  UiFaultInput,
  UiScrollInput,
} from 'claude-code'

import { agentList, callAgent, completeAgent, spawnAgent, stepAgent } from './agents'

import * as cacheState from './cache'
import type { Cache, ResumeFields, Submission } from './cache'
import { cacheRows } from './cachebox'

import { answer, describe } from './command'
import { addDenial, denialContent, denialList, denialSource } from './denials'
import { EMPTY_IDENTITY, EMPTY_TALLY, addTally, identityRows, requestSpeed, turnDurationRow } from './identity'
import type { Listed, Subcommand } from './command'
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
  loopMemory,
  loopView,
  nextDelay,
  renew,
  restart,
  restoreLoop,
  startStretch,
  stopFor,
  thrownStop,
} from './keepalive'
import type { Loop } from './keepalive'
import { CLOSED, isClosed, scrollList, toggleDetail, toggleList } from './list'
import { faultedModule, glowText, isLive, liveOf, spinAfter, toCells } from './live'
import type { Span } from './live'
import { LIGHT } from './motion'
import { NO_MESSAGES, addMessage, contentText, isMyMessage, messageList, reconcile, settleMessages, userTexts } from './messages'
import { PANE, PANEL_SUBCOMMAND, drawPanel, gridRow, hidesPanel, innerWidth } from './panel'
import { isShown, readSettings, sessionHiddenFor, shownText } from './settings'
import { normalized, normalizing } from './shape'
import { GRID } from './style'
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
  shouldTranslate,
  startTranslating,
  translated,
  typed,
} from './translate'
import type { Translation } from './translate'
import { EMPTY_USAGE, HISTORY_KEYS, applyReading, parseHistory, parseResetsAt, recordSample } from './usage'
import type { GridRow, Reading } from './usage'
import type { Denial, KeepaliveStop, ListId, Scrolled, Settings, SpeedTally, SubAgent, TurnSpeeds } from '../types'

// 模块结构（照 flightdeck 的 register.tsx / core.ts），引擎扫描源码的规则见 AGENTS.md Pitfalls「模块结构」：
// - 所有 on(...) 都写在下面的 register 里；用到 `$` 的辅助函数写在本文件顶层（`$` 不能跨文件传）。
//   功能文件（settings.ts、command.ts 等）只放不碰 `$` 的纯逻辑和界面组件，由这里调用。
// - 几个功能都要的事件（session.start 等）只注册一次、不带匹配器：处理函数里按写下的顺序依次调用各功能，
//   先后顺序就是处理函数里的行序。新功能往这类事件里加一行调用，放在它依赖的功能之后、`/anvil` 命令之前。
// - 只属于一个功能的事件用真匹配器注册（带 args 的 command.run、按 requestId 的 Pane ui.render 等），
//   不用 `{}` 空匹配器。新功能的子命令说明加进 SUBCOMMANDS（补全菜单的参数提示也由它列出）、现在的状态加进 subcommandStates，
//   执行写成带 args 匹配器的 command.run（只认子命令本身，敲一次切换一次），注册在兜底的 command.run 之前。
// - 面板的区块（panel.tsx 的 SECTIONS）由各功能填内容：在 drawAnvilPanel 里把该区块的 SectionBody
//   放进 bodies；三个列表（我的消息、自动模式拒绝、子 agent）交 ListBody 放进 lists，按上限截、
//   "更早的"那行、展开和收成一行由 panel.tsx 按共同规则做（list.ts）。身份栏的一行交 identity，接在区块之后。
// - 热重载不清 `$.state`，旧代码按旧形状写下的值还在：对象、列表形状的 atom 读写时合并到现在的形状上
//   （`normalized(x, await read($, x))`、`update($, x, normalizing(x, …))`，形状写在 shape.ts）；新加或改了形状的 atom 同样处理。
// - 主输入框上方的 band（AbovePrompt）只画翻译框（translate.tsx），不放别的功能。
// - 动效（进行中图标、运行中的耗时）用 live.tsx 的 spin / clock 画：有 Client 时交给 spinner.tsx、elapsed.tsx，
//   没有或出过错时退回静止；画的时候用 liveFor 取这次怎么画。

// ---------------------------------------------------------------- 设置

const SETTINGS = { plugin: 'anvil', key: 'settings' } as const

/** 把生效的设置写进 `$.state`，供拿不到 options 的读者（测试）核对 */
async function publishSettings($: EngineInterface, settings: Settings) {
  await $.state.set(SETTINGS, settings)
}

// ---------------------------------------------------------------- 缓存状态（D1、D2）与冷发送守卫（D4）

const CACHE = { plugin: 'anvil', key: 'cache' } as const
const cacheView = atom(CACHE, cacheState.view(cacheState.freshCache()))
const CACHE_MEMORY = { plugin: 'anvil', key: 'cacheMemory' } as const

/** 把缓存状态的读数写进 `$.state`，缓存框和测试从这里读；原样另存一份，热重载后接上 */
async function publishCache($: EngineInterface, cache: Cache) {
  await $.state.set(CACHE_MEMORY, cache)
  await $.state.set(CACHE, cacheState.view(cache))
}

/**
 * 会话开始（含热重载）：`$.state` 里有上一次加载存下的缓存状态（热重载换掉模块内存、`$.state` 还在）就接上；
 * 没有（新会话）或认不出就冷启动：取计价用的模型和引擎的实时上下文，还没有请求，不判过期
 */
async function startCache($: EngineInterface, cache: Cache) {
  const restored = cacheState.restoreCache((await $.state.get(CACHE_MEMORY)).value)
  if (restored) {
    Object.assign(cache, restored)
    cache.model ??= await $.session.model()
  } else {
    cache.model = await $.session.model()
    const live = (await $.session.usage()).context.tokens
    if (live !== undefined && live > 0) cache.context = live
  }
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
  await publishCache($, cache)
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

const keepaliveOverride = atom({ plugin: 'anvil', key: 'keepaliveOverride' } as const, null as boolean | null)
const keepaliveLoop = atom({ plugin: 'anvil', key: 'keepalive' } as const, loopView(freshLoop()))
const LOOP_MEMORY = { plugin: 'anvil', key: 'keepaliveMemory' } as const

async function publishLoop($: EngineInterface, loop: Loop) {
  await $.state.set(LOOP_MEMORY, loopMemory(loop))
  await update($, keepaliveLoop, () => loopView(loop))
}

/**
 * 会话开始（含热重载）：接上上一次加载存下的续期次数、停下和重新开启的时刻。
 * 旧模块的定时器已被引擎撤掉、路上的续期请求随它丢了：这次重新定时（cacheChanged），动效里的续期收起
 */
async function startLoop($: EngineInterface, loop: Loop) {
  restoreLoop(loop, (await $.state.get(LOOP_MEMORY)).value)
  await markActivity($, 'keep', false).catch(() => undefined)
}

/** 按缓存状态重新定时（cache-tax 的 arm）：没开、已停下、冷了都不定时；这段空闲到上限就停下 */
async function armKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  disarm(loop)
  if (loop.stopped || !isEnabled(settings, await read($, keepaliveOverride), cache.context)) return publishLoop($, loop)
  const delay = nextDelay(cache, loop, await $.clock.now())
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
  if (!isEnabled(settings, await read($, keepaliveOverride), cache.context)) return publishLoop($, loop)
  const now = await $.clock.now()
  const action = dueAction(cache, loop, now)
  if (action === 'limit') return stopKeepalive($, loop, LIMIT_STOP)
  if (action === 'rearm') return armKeepalive($, cache, loop, settings)

  const stretch = cache.lastRequestAt
  loop.inFlight = true
  await markActivity($, 'keep', true).catch(() => undefined)
  await publishLoop($, loop)
  let stop: KeepaliveStop | null
  try {
    stop = stopFor(await $.model.fork({ prompt: PING_PROMPT }))
  } catch (error) {
    stop = thrownStop(error)
  }
  loop.inFlight = false
  await markActivity($, 'keep', false).catch(() => undefined)
  // 请求路上用户回来发了消息：这一段空闲已经结束，结果不再算到新的一段上（cache-tax 没有这层）
  if (cache.lastRequestAt !== stretch) return publishLoop($, loop)
  if (stop) return stopKeepalive($, loop, stop)
  renew(cache, now)
  loop.renewals += 1
  await publishCache($, cache)
  await armKeepalive($, cache, loop, settings)
}

/**
 * `/anvil keepalive`：运行中（已启用、进行中）就关掉，没开或已停下就开启，之后不再看自动开启和阈值（D3）。
 * 开启时这一段空闲的停下也清掉、12 小时上限从现在重新算，按缓存状态重新定时；关闭时 armKeepalive 只撤掉定时器。
 */
async function toggleKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  const isRunning = isEnabled(settings, await read($, keepaliveOverride), cache.context) && loop.stopped === null
  const isOn = !isRunning
  await update($, keepaliveOverride, () => isOn)
  if (isOn) restart(loop, await $.clock.now())
  await armKeepalive($, cache, loop, settings)
  return isOn ? '缓存保活已开启（本会话）' : '缓存保活已关闭（本会话）'
}

/** 缓存框和 `/anvil` 列表里的保活状态 */
async function keepaliveNow($: EngineInterface, settings: Settings) {
  const [cached, override, loop] = await Promise.all([read($, cacheView).then(value => normalized(cacheView, value)), read($, keepaliveOverride), read($, keepaliveLoop).then(value => normalized(keepaliveLoop, value))])
  return keepaliveStatus({ settings, override, context: cached.context, loop })
}

// ---------------------------------------------------------------- 缓存框

/** 过期那一刻重画一次：保活状态跟着变（过期时长交还 statusline 后不再每分钟重画） */
type Redraw = { timer: { cancel: () => void } | null }

async function scheduleRedraw($: EngineInterface, cache: Cache, redraw: Redraw) {
  redraw.timer?.cancel()
  redraw.timer = null
  if (cache.expiresAt === 0 || cache.compacted) return
  const now = await $.clock.now()
  if (now >= cache.expiresAt) return
  redraw.timer = $.clock.after(cache.expiresAt - now, () => {
    redraw.timer = null
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // 没有界面（headless、plugin test）：不用重画
    }
  })
}

/** 缓存状态变了：保活按新的状态重新定时，缓存框定好下一次重画 */
async function cacheChanged($: EngineInterface, cache: Cache, loop: Loop, redraw: Redraw, settings: Settings) {
  await armKeepalive($, cache, loop, settings)
  await scheduleRedraw($, cache, redraw)
}

// ---------------------------------------------------------------- 用量框

// 用量框暂不画（2026-10-14 交还 statusline，用户定）：读数和 5h、7d 的存档照记，等讨论用量估算时再定去留

const usage = atom({ plugin: 'anvil', key: 'usage' } as const, EMPTY_USAGE)

/** 会话现在的花费；拿不到读数（无头、SDK 宿主）时为 null */
async function noteReading($: EngineInterface, reading: Reading) {
  // 先记进存档再更新读数：读数一变面板就重画，重画时存档已经是新的
  await recordHistories($, reading).catch(() => undefined)
  await update($, usage, normalizing(usage, current => applyReading(current, reading)))
}

/** 5h、7d 的读数记进 `$.store` 的存档（本机会话共用）；先 get 再 set 不是原子的，丢一两个读数无妨，不加锁 */
async function recordHistories($: EngineInterface, reading: Reading) {
  const at = await $.clock.now()
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const limit = reading.rateLimits.find(one => one.kind === kind)
    const resetsAt = parseResetsAt(limit?.resetsAt)
    if (limit === undefined || resetsAt === null) continue
    const history = parseHistory(await $.store.get(HISTORY_KEYS[kind]))
    await $.store.set(HISTORY_KEYS[kind], recordSample(history, kind, resetsAt, { at, percent: limit.percentUsed }))
  }
}

async function readUsage($: EngineInterface) {
  const reading = await $.session.usage().catch(() => null)
  if (reading) await noteReading($, reading)
}

// ---------------------------------------------------------------- 子 agent 列表（数据来源照 flightdeck）

const agents = atom({ plugin: 'anvil', key: 'agents' } as const, [] as SubAgent[])

async function noteSpawn($: EngineInterface, e: AgentSpawnInput, agentId: string, model: string) {
  const at = await $.clock.now()
  await update($, agents, normalizing(agents, list => spawnAgent(list, { id: agentId, description: e.description, prompt: e.prompt, model, at })))
}

/** 子 agent 的一次请求结束；不在列表里的 id（引擎自己的 fork、工作流里没登记的）不管 */
async function noteAgentStep($: EngineInterface, e: TurnStepInput, agentId: string, result: TurnStepResult) {
  if (!normalized(agents, await read($, agents)).some(agent => agent.id === agentId)) return
  await update($, agents, normalizing(agents, list => stepAgent(list, agentId, { model: e.model, usage: result.usage, stopReason: result.stopReason ?? null })))
}

async function noteAgentCall($: EngineInterface, e: ToolCallInput, agentId: string, ran: ToolCallResult) {
  if (!normalized(agents, await read($, agents)).some(agent => agent.id === agentId)) return
  const isError = ran.deny !== undefined || ran.isError === true
  await update($, agents, normalizing(agents, list => callAgent(list, agentId, { tool: String(e.tool), text: describeInput(e), isError })))
}

async function noteAgentEnd($: EngineInterface, e: TurnCompleteInput, agentId: string) {
  if (!normalized(agents, await read($, agents)).some(agent => agent.id === agentId)) return
  const at = await $.clock.now()
  await update($, agents, normalizing(agents, list => completeAgent(list, agentId, { reason: e.reason, answer: e.answer, at })))
}

// ---------------------------------------------------------------- 自动模式拒绝（spec D8）

const denials = atom({ plugin: 'anvil', key: 'denials' } as const, [] as Denial[])

/** 自动模式的分类器拒绝了一次调用：记下时间、工具、完整内容（遮掉密钥）和来源 */
async function noteDenial($: EngineInterface, e: ClassicEventOf['classic.PermissionDenied']) {
  const at = await $.clock.now()
  const source = denialSource(e.agent_id, e.agent_type, normalized(agents, await read($, agents)))
  const denial: Denial = { id: e.tool_use_id, at, tool: e.tool_name, ...denialContent(e.tool_input), source }
  await update($, denials, normalizing(denials, list => addDenial(list, denial)))
}

// ---------------------------------------------------------------- 我的消息（spec D8）

const messages = atom({ plugin: 'anvil', key: 'messages' } as const, NO_MESSAGES)
const scrolled = atom({ plugin: 'anvil', key: 'scrolled' } as const, null as Scrolled | null)

/** 对话里现存的用户消息；读不到（宿主不给）时为 null，这时不核对 */
async function transcriptTexts($: EngineInterface): Promise<string[] | null> {
  const transcript = await $.session.messages().catch(() => null)
  return transcript ? userTexts(transcript) : null
}

/** 拿对话核对一遍，撤回、回退掉的去掉；没有变化时不写，免得面板白白重画 */
async function syncMessages($: EngineInterface) {
  const texts = await transcriptTexts($)
  if (texts === null) return
  const current = normalized(messages, await read($, messages))
  const next = reconcile(current, texts)
  if (next !== current) await update($, messages, () => next)
}

/** 主输入框发出的消息进了主会话的对话：先核对此前的（回退后重发时旧的已不在），再记下这条 */
async function noteMessage($: EngineInterface, uuid: string, content: SessionAppendMessage['content']) {
  const text = contentText(content)
  await syncMessages($)
  await update($, messages, normalizing(messages, list => addMessage(list, { id: uuid, text })))
}

async function settleOnCompact($: EngineInterface) {
  await update($, messages, normalizing(messages, list => settleMessages(list)))
}

/**
 * 我的消息里按 Enter：让对话滚到这条消息。滚动要在回应用户按键时调用才生效（引擎规定），所以先滚；
 * 滚不过去（多半是消息已撤回）就核对一遍，把它从列表去掉。
 */
async function scrollToMessage($: EngineInterface, id: string) {
  const moved = await $.ui.scroll({ to: { requestId: id }, block: 'start' }).catch((error: unknown) => ({
    deny: error instanceof Error ? error.message : String(error),
  }))
  await update($, scrolled, () => ({ id, deny: moved.deny ?? null }))
  if (moved.deny !== undefined) await syncMessages($)
}

// ---------------------------------------------------------------- 身份栏（D8）

const identity = atom({ plugin: 'anvil', key: 'identity' } as const, EMPTY_IDENTITY)

const NO_TURN_SPEEDS: TurnSpeeds = { current: null, lines: {} }
const turnSpeeds = atom({ plugin: 'anvil', key: 'turnSpeeds' } as const, NO_TURN_SPEEDS)

/** 记着的收尾行最多这么多段，多了丢最早的 */
const TURN_LINES = 500

/** 主会话一次请求的速度：算得出就计入本会话的合计和这一段的读数 */
async function noteSpeed($: EngineInterface, e: TurnStepInput, speed: SpeedTally | null) {
  if (!speed) return
  await update($, identity, normalizing(identity, current => ({ ...current, speed: addTally(current.speed, speed) })))
  await update($, turnSpeeds, normalizing(turnSpeeds, current => {
    const turn = current.current?.turnId === e.turnId ? current.current : null
    return {
      ...current,
      current: turn ? { ...turn, tally: addTally(turn.tally, speed) } : { turnId: e.turnId, tally: speed, firstTokenMs: speed.firstTokenMs },
    }
  }))
}

/**
 * 主会话的收尾那行（对话记录里的 `turn_duration`）记进对话：这一段的读数记到它的 uuid 下，
 * TurnDuration 的 requestId 就是这个 uuid（anvil-k0t.52 伪终端实测），画的时候按它取
 */
async function closeTurnSpeed($: EngineInterface, uuid: string) {
  const [now, list] = await Promise.all([$.clock.now(), read($, agents).then(value => normalized(agents, value))])
  const waitingAgents = list.filter(agent => agent.status === 'running').length
  await update($, turnSpeeds, normalizing(turnSpeeds, current => {
    if (!current.current) return current
    const { tally, firstTokenMs } = current.current
    const kept = Object.entries(current.lines).slice(-(TURN_LINES - 1))
    return { current: null, lines: { ...Object.fromEntries(kept), [uuid]: { tally, firstTokenMs, doneAt: now, waitingAgents } } }
  }))
}

/** 换了对话（`/clear`、`/resume`、`/branch`）：平均从零算，旧的收尾行不再画在屏幕上 */
async function resetSpeeds($: EngineInterface) {
  await update($, identity, normalizing(identity, current => ({ ...current, speed: EMPTY_TALLY })))
  await update($, turnSpeeds, () => NO_TURN_SPEEDS)
}

/** 这一段回复的读数；恢复前的、打断的没有 */
async function turnSpeedOf($: EngineInterface, requestId: string) {
  return normalized(turnSpeeds, await read($, turnSpeeds)).lines[requestId]
}

// ---------------------------------------------------------------- 面板按键：列表展开、详情、滚动（spec D9）

const fold = atom({ plugin: 'anvil', key: 'fold' } as const, CLOSED)

async function pressList($: EngineInterface, id: ListId) {
  await update($, fold, normalizing(fold, current => toggleList(current, id)))
}

/** 子 agent 的序号键、Enter，自动模式拒绝的 Enter：展开或收起这一项的详情 */
async function pressDetail($: EngineInterface, detailId: string) {
  await update($, fold, normalizing(fold, current => toggleDetail(current, detailId)))
}

/** 展开的列表放不下时，滚轮滚的是列表自己（面板本身放得下，不需要引擎滚）；其余照引擎的 */
async function scrollPanel($: EngineInterface, e: UiScrollInput): Promise<boolean> {
  const current = normalized(fold, await read($, fold))
  if (current.expanded === null || e.contentRows > e.bodyRows) return false
  const total = await listLength($, current.expanded)
  await update($, fold, () => scrollList(current, e.by, total))
  return true
}

async function listLength($: EngineInterface, id: ListId): Promise<number> {
  if (id === 'agents') return normalized(agents, await read($, agents)).length
  if (id === 'denials') return normalized(denials, await read($, denials)).length
  return normalized(messages, await read($, messages)).items.length
}

/**
 * Esc 把焦点交回主输入框（引擎的固定键位，不经过 mod）：面板失去焦点后重画时按全收起画，
 * 并把展开状态清掉，下次再进面板也是收起的。
 */
async function foldForDrawing($: EngineInterface, isFocused: boolean) {
  const current = normalized(fold, await read($, fold))
  if (isFocused || isClosed(current)) return current
  // 画的钩子里不能写 `$.state`：画完再清
  $.clock.after(0, () => void update($, fold, () => CLOSED).catch(() => undefined))
  return CLOSED
}

// ---------------------------------------------------------------- 动效（spec D10）：进行中图标、运行中的耗时

/**
 * 正在发生的几件事各自的起止（spec D10「呼吸」）：主会话回复（这一轮的第一次请求到这一轮结束；子 agent 的不算）、
 * 保活的续期请求、翻译。结束后留着结束的时刻：落定、暗下去要用；下一次开始时换掉
 */
type Activity = { reply: Span | null; keep: Span | null; translate: Span | null }

const activity = atom({ plugin: 'anvil', key: 'activity' } as const, { reply: null, keep: null, translate: null } as Activity)

/** 热重载前存下的可能是别的形状（anvil-k0t.46 的 replying），合并后当作什么都没在发生 */
async function readActivity($: EngineInterface): Promise<Activity> {
  return read($, activity).then(value => normalized(activity, value))
}

/** 一件事开始（还没在发生时记下开始的时刻）或结束（在发生时记下结束的时刻） */
async function markActivity($: EngineInterface, name: keyof Activity, isOn: boolean) {
  const current = (await readActivity($))[name]
  const now = await $.clock.now()
  if (isOn && (current === null || current.until !== null)) await update($, activity, normalizing(activity, all => ({ ...all, [name]: { since: now, until: null } })))
  else if (!isOn && current !== null && current.until === null) await update($, activity, normalizing(activity, all => ({ ...all, [name]: { since: current.since, until: now } })))
}

async function setReplying($: EngineInterface, isReplying: boolean) {
  await markActivity($, 'reply', isReplying)
}

/** 出过错的 Client 模块（文件名）：之后画面板、翻译框时不再用它，退回静止 */
const faults = atom({ plugin: 'anvil', key: 'clientFaults' } as const, [] as string[])

/** 引擎报某个 Client 出错：记下模块，引擎接着重画那一处，这次就不用它了 */
async function noteFault($: EngineInterface, e: UiFaultInput) {
  const name = faultedModule(e.module)
  if (name === null) return
  await update($, faults, normalizing(faults, list => (list.includes(name) ? list : [...list, name])))
}

/** 面板里焦点所在元素的 key（ui.focus）；面板失去焦点后不看它 */
const focusKey = atom({ plugin: 'anvil', key: 'focusKey' } as const, null as string | null)

async function noteFocus($: EngineInterface, element: string | null) {
  if ((await read($, focusKey)) !== element) await update($, focusKey, () => element)
}

/** 这次绘制里动效怎么画：相位按绝对时刻算，面板和翻译框不用对零点也同相 */
async function liveFor($: EngineInterface, els: object, surface: RenderSurface, now: number) {
  return liveOf(els, surface, now, normalized(faults, await read($, faults)))
}

// ---------------------------------------------------------------- anvil 面板

const panelHidden = atom({ plugin: 'anvil', key: 'panelHidden' } as const, null as boolean | null)

/** 面板在本会话显示不显示：本会话切换过就按切换的，没切换过按 `/config` */
async function panelShown($: EngineInterface, settings: Settings) {
  return isShown(settings.showPanel, await read($, panelHidden))
}

async function openPanel($: EngineInterface) {
  // 不设 closeOnEscape：Esc 只把按键交回主输入框，面板留着（spec D9）
  return $.ui.open({ id: PANE.id, title: PANE.title, columns: PANE.columns })
}

/**
 * 会话开始时自己打开；终端不够宽时引擎先不放下，等用户下一次提交消息。
 * 不显示时收起：`/config` 关掉面板会重新加载模块、再走这里，已经开着的面板随之收掉
 */
async function startPanel($: EngineInterface, settings: Settings) {
  if (!(await panelShown($, settings))) return void $.ui.close({ id: PANE.id }).catch(() => undefined)
  // 不等它画出来：会话开始的钩子还没返回，画不了
  void openPanel($).catch(() => undefined)
}

/** 用户提交消息时，面板该在却还没放下，就再开一次：这次算用户请求，110 列即可停靠 */
async function reopenPanel($: EngineInterface, settings: Settings, e: PromptSubmitInput) {
  if (e.origin.kind !== 'composer') return
  if (!(await panelShown($, settings))) return
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === PANE.id && pane.isPlaced)) return
  await openPanel($).catch(() => undefined)
}

/** `/anvil panel`：显示着就隐藏（本会话不再自动打开），隐藏着（含 `/config` 关掉的）就打开 */
async function togglePanel($: EngineInterface, settings: Settings) {
  if (await panelShown($, settings)) {
    await update($, panelHidden, () => sessionHiddenFor(false, settings.showPanel))
    await $.ui.close({ id: PANE.id })
    return shownText('面板', false, settings.showPanel)
  }
  await update($, panelHidden, () => sessionHiddenFor(true, settings.showPanel))
  const opened = await openPanel($)
  const text = shownText('面板', true, settings.showPanel)
  return opened.isPlaced ? text : `${text}，但暂时放不下：${opened.reason}`
}

async function notePanelClosed($: EngineInterface, settings: Settings, e: PaneCloseInput) {
  if (hidesPanel(e.origin)) await update($, panelHidden, () => sessionHiddenFor(false, settings.showPanel))
}

async function drawAnvilPanel($: EngineInterface, settings: Settings, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e)
  const [list, denied, mine, folding, now, who] = await Promise.all([
    read($, agents).then(value => normalized(agents, value)),
    read($, denials).then(value => normalized(denials, value)),
    read($, messages).then(value => normalized(messages, value)),
    foldForDrawing($, e.props.isFocused),
    $.clock.now(),
    read($, identity).then(value => normalized(identity, value)),
  ])
  const [cached, keepalive, loop, live, doing, focused] = await Promise.all([
    read($, cacheView).then(value => normalized(cacheView, value)),
    keepaliveNow($, settings),
    read($, keepaliveLoop).then(value => normalized(keepaliveLoop, value)),
    liveFor($, els, e.surface, now),
    readActivity($),
    read($, focusKey),
  ])
  // 用户进了面板要按 Enter 时，列表里不该有已撤回的消息：画完核对一遍，有变化会再画
  if (e.props.isFocused) $.clock.after(0, () => void syncMessages($).catch(() => undefined))
  const columns = e.props.bodyColumns
  const inner = innerWidth(columns)
  // 保活的续期请求在路上："进行中"跟着呼吸亮暗，后面接转动的图标（缓存框第二行）
  const keepRow = (row: GridRow) => {
    if (row.key !== 'keepalive' || !loop.inFlight) return gridRow(els, row, inner)
    const text = (row.lines[0] ?? []).flatMap(segment => toCells(segment.text, segment.color, segment.bold))
    const first = glowText(els, live, { key: 'glow:keepalive', cells: text, span: doing.keep, mode: 'breathe', shine: LIGHT.shine })
    const tail = spinAfter(els, live, { key: 'spin:keepalive' })
    return gridRow(els, row, inner, tail, first)
  }
  return drawPanel(els, {
    columns,
    rows: e.props.scroll.bodyRows,
    bodies: {
      cache: { rows: cacheRows(cached, keepalive, inner).flatMap(keepRow) },
    },
    lists: {
      messages: messageList(els, mine, { inner, focused: e.props.isFocused ? focused : null, onPress: id => void scrollToMessage($, id) }),
      denials: denialList(els, denied, { detail: folding.detail, inner, onPress: id => void pressDetail($, id) }),
      agents: agentList(els, list, { detail: folding.detail, now, inner, live, focused: e.props.isFocused ? focused : null, onPress: id => void pressDetail($, id) }),
    },
    fold: folding,
    identity: identityRows(els, who, columns, { reply: doing.reply, live }),
    motion: { live, reply: doing.reply },
    onToggle: id => void pressList($, id),
  })
}

// ---------------------------------------------------------------- 翻译输入框（D5）与翻译后端（D6）

const translateBox = atom({ plugin: 'anvil', key: 'translate' } as const, EMPTY_BOX)
const translateHidden = atom({ plugin: 'anvil', key: 'translateHidden' } as const, null as boolean | null)

/** 翻译框在本会话显示不显示：本会话切换过就按切换的，没切换过按 `/config` */
async function translateShown($: EngineInterface, settings: Settings) {
  return isShown(settings.showTranslate, await read($, translateHidden))
}

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

/**
 * 翻译框里按 Enter：翻译、追加。引擎已经清空框、把焦点交回主输入框，成功时照它的做法，不抢回焦点；
 * 失败时把中文画回框里、焦点交给它，显示原因，再按 Enter 重试
 */
async function submitChinese($: EngineInterface, settings: Settings, band: string, value: string) {
  if (!shouldTranslate(normalized(translateBox, await read($, translateBox)), value)) return
  await update($, translateBox, normalizing(translateBox, box => startTranslating(box, value)))
  await markActivity($, 'translate', true).catch(() => undefined)
  const translation = await translateText($, settings, value).finally(() => markActivity($, 'translate', false).catch(() => undefined))
  const refusal = 'error' in translation ? translation.error : await appendToPrompt($, translation.text)
  if (refusal === null && 'text' in translation) {
    await update($, translateBox, normalizing(translateBox, box => translated(box, countWords(translation.text))))
    return
  }
  const next = await update($, translateBox, normalizing(translateBox, box => failed(box, refusal ?? '')))
  // plugin test 里没有 ui.focus 的实现，会拒绝；焦点只能在交互会话里验证
  await $.ui.focus({ requestId: band, key: inputKey(next) }).catch(() => undefined)
}

/** 翻译框里改字：记下框空没空，开始写下一句时去掉"已追加" */
async function typeChinese($: EngineInterface, value: string) {
  const next = typed(normalized(translateBox, await read($, translateBox)), value)
  if (next !== null) await update($, translateBox, () => next)
}

/** 画翻译框；隐藏了、有问卷占着那一栏时返回 null，让出来 */
async function drawTranslate($: EngineInterface, settings: Settings, e: RenderInput<'AbovePrompt'>) {
  // 先排除 mobile，resolve 出来的元素才有 Input
  if (e.surface === 'mobile' || e.props.hasSurvey || !(await translateShown($, settings))) return null
  const els = $.ui.resolve(e)
  const [box, now, doing] = await Promise.all([read($, translateBox).then(value => normalized(translateBox, value)), $.clock.now(), readActivity($)])
  return drawTranslateBox(els, {
    columns: e.props.bodyColumns,
    box,
    live: await liveFor($, els, e.surface, now),
    span: doing.translate,
    onSubmit: value => void submitChinese($, settings, e.requestId, value),
    onInput: value => void typeChinese($, value),
  })
}

/** `/anvil translate`：显示着就隐藏，隐藏着（含 `/config` 关掉的）就显示 */
async function toggleTranslate($: EngineInterface, settings: Settings) {
  const shown = !(await translateShown($, settings))
  await update($, translateHidden, () => sessionHiddenFor(shown, settings.showTranslate))
  return shownText('翻译框', shown, settings.showTranslate)
}

// ---------------------------------------------------------------- /anvil 命令

// 各功能交出的 /anvil 子命令说明，按列出的顺序排
const SUBCOMMANDS: readonly Subcommand[] = [PANEL_SUBCOMMAND, TRANSLATE_SUBCOMMAND, KEEPALIVE_SUBCOMMAND]

/** `/anvil` 不带参数时列出的各子命令在本会话现在的状态，和 SUBCOMMANDS 同序 */
async function subcommandStates($: EngineInterface, settings: Settings): Promise<Listed[]> {
  const [panel, translate, keepalive] = await Promise.all([panelShown($, settings), translateShown($, settings), keepaliveNow($, settings)])
  const states = [panel ? '显示' : '隐藏', translate ? '显示' : '隐藏', keepalive.text]
  return SUBCOMMANDS.map((subcommand, index) => ({ ...subcommand, state: states[index] ?? '' }))
}

async function registerAnvil($: EngineInterface) {
  await $.command.register({ name: 'anvil', ...describe(SUBCOMMANDS) })
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
    // 热重载换掉模块内存、撤掉定时器：缓存状态和保活循环从 `$.state` 接上，按接上的状态重新定时、定好缓存框的重画
    await startCache($, cache)
    await startLoop($, loop)
    await cacheChanged($, cache, loop, redraw, settings)
    await readUsage($)
    await startPanel($, settings)
    await registerAnvil($)
    return next(e)
  })

  // `/clear`、恢复会话不触发 session.start，只走这里
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await resumeCache($, cache, e)
    // `/clear`、会话内恢复别的会话（`/resume`、`/branch`）都换了对话：上一段空闲的停下不再算，
    // 按起步的缓存状态重新定时（冷了不发）
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      startStretch(loop)
      await resetSpeeds($).catch(() => undefined)
    }
    await cacheChanged($, cache, loop, redraw, settings)
    // `$.state` 换了对话就清空：用量重新读，不等第一条消息
    await readUsage($)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const agentId = e.agentId
      const result = yield* next(e)
      await noteAgentStep($, e, agentId, result).catch(() => undefined)
      return result
    }
    await stepStarted($, cache)
    await setReplying($, true).catch(() => undefined)
    // 用户回来了：这一段空闲结束，一轮结束时再定时（cache-tax 也是一轮结束才定时）
    startStretch(loop)
    await publishLoop($, loop)
    await scheduleRedraw($, cache, redraw)
    // token/s 从首字算起（D8）：首字是响应的第一块（含 engine 块，.51 实测），结束是 stop 那块；
    // 首字等待从请求开始算；整段一起到时生成用时退回整次用时
    const startAt = await $.clock.now()
    let firstAt: number | null = null
    let stopAt: number | null = null
    let output: number | undefined
    const stream = next(e)
    for await (const chunk of stream) {
      if (chunk.kind === 'stop') {
        stopAt = await $.clock.now()
        output = chunk.usage?.output_tokens
      } else if (firstAt === null) {
        firstAt = await $.clock.now()
      }
      yield chunk
    }
    const result = await stream.result
    if (result.usage) await stepAnswered($, cache, result.usage)
    await noteSpeed($, e, requestSpeed(output ?? result.usage?.output_tokens, startAt, firstAt, stopAt)).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await setReplying($, false).catch(() => undefined)
      await turnCompleted($, cache, e)
      await cacheChanged($, cache, loop, redraw, settings)
      // 本会话花费在一轮结束时重新读
      await readUsage($)
      // 按 Esc 打断时引擎可能把刚发的消息撤回到主输入框
      await syncMessages($).catch(() => undefined)
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

  on('classic.PermissionDenied', async ($, e, next) => {
    const result = await next(e)
    await noteDenial($, e).catch(() => undefined)
    return result
  })

  // 我的消息：主输入框发出、进了主会话对话的消息
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    if (isMyMessage(e) && stored.uuid !== undefined) await noteMessage($, stored.uuid, stored.message.content).catch(() => undefined)
    return stored
  })

  // 主会话一段回复的收尾那行：先记下这一段的读数再交下去，画它的时候已经有了
  on('session.append', { door: 'notice' }, async ($, e, next) => {
    if (!e.agentId && e.message.type === 'system' && e.message.name === 'turn_duration') await closeTurnSpeed($, e.uuid).catch(() => undefined)
    return next(e)
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
      await settleOnCompact($).catch(() => undefined)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // 先补开面板，再过守卫：用户按了 Enter 就算用户请求，守卫拦下这条时面板照样打开（缓存框正好说明为什么拦）
    await reopenPanel($, settings, e).catch(() => undefined)
    if (settings.guard) {
      const drop = await guardSubmission($, cache, e, settings.threshold)
      if (drop !== null) return { drop }
    }
    return next(e)
  })

  on('ui.close', { id: 'anvil' }, async ($, e, next) => {
    await notePanelClosed($, settings, e).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'anvil' }, async ($, e) => drawAnvilPanel($, settings, e))

  // 焦点在面板里移动：记下落在哪个元素上，压在子 agent 那一行上的 Client 跟着反白
  on('ui.focus', { component: 'Pane', requestId: 'anvil' }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny === undefined) await noteFocus($, e.element ?? null).catch(() => undefined)
    return moved
  })

  // 面板、翻译框里的 Client 出错：记下后引擎重画那一处，退回静止
  on('ui.fault', async ($, e, next) => {
    await noteFault($, e).catch(() => undefined)
    return next(e)
  })

  // 原生收尾那行后面接这一段的读数；没有读数时照原样
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const turn = e.surface === 'terminal' ? await turnSpeedOf($, e.requestId) : undefined
    if (!turn) return next(e)
    return turnDurationRow($.ui.resolve(e), await next(e), e.props, turn)
  })

  // 翻译框常驻在主输入框上方
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawTranslate($, settings, e)) ?? next(e))

  on('ui.scroll', { component: 'Pane', requestId: 'anvil' }, async ($, e, next) => {
    // 改了展开状态，引擎自己会重画
    if (await scrollPanel($, e).catch(() => false)) return {}
    return next(e)
  })

  // 功能自己的子命令在这里接入（带 args 匹配器），兜底的放最后
  on('command.run', { command: 'anvil', args: /^\s*panel\s*$/ }, async $ => ({ text: await togglePanel($, settings) }))
  on('command.run', { command: 'anvil', args: /^\s*translate\s*$/ }, async $ => ({ text: await toggleTranslate($, settings) }))
  on('command.run', { command: 'anvil', args: /^\s*keepalive\s*$/ }, async $ => ({ text: await toggleKeepalive($, cache, loop, settings) }))

  // 兜底回答功能没接走的 /anvil
  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(await subcommandStates($, settings), e.args) }))
}