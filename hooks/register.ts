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
import { EMPTY_IDENTITY, GIT, NUMSTAT, REV_PARSE, STATUS, baseName, gitView, identityRows, operationOf, parseNumstat, parseRepo, parseStatus, tokensPerSecond } from './identity'
import type { RebaseFiles } from './identity'
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
import { PANE, PANEL_SUBCOMMAND, drawPanel, gridRow, hidesPanel, innerWidth, spacedGridRows } from './panel'
import { readSettings } from './settings'
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
import { EMPTY_USAGE, HISTORY_KEYS, applyReading, parseHistory, parseResetsAt, recordSample, usageRows } from './usage'
import type { GridRow, Histories, Reading } from './usage'
import type { Denial, GitView, Identity, KeepaliveStop, ListId, Scrolled, Settings, SubAgent } from '../types'

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
//   "更早的"那行、展开和收成一行由 panel.tsx 按共同规则做（list.ts）。身份栏的三行交 identity，接在区块之后。
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
  const [cached, override, loop] = await Promise.all([read($, cacheView), read($, keepaliveOverride), read($, keepaliveLoop)])
  return keepaliveStatus({ settings, override, context: cached.context, loop })
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
async function noteReading($: EngineInterface, reading: Reading) {
  // 先记进存档再更新读数：读数一变面板就重画，重画时存档已经是新的
  await recordHistories($, reading).catch(() => undefined)
  await update($, usage, current => applyReading(current, reading))
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

/** 面板重画时读存档，预测的速度现算；读不到（plugin test 没接 store）就当没有存档 */
async function readHistories($: EngineInterface): Promise<Histories> {
  const histories: Histories = {}
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const history = parseHistory(await $.store.get(HISTORY_KEYS[kind]).catch(() => undefined))
    if (history !== null) histories[kind] = history
  }
  return histories
}

async function readUsage($: EngineInterface) {
  const reading = await $.session.usage().catch(() => null)
  if (reading) await noteReading($, reading)
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

// ---------------------------------------------------------------- 自动模式拒绝（spec D8）

const denials = atom({ plugin: 'anvil', key: 'denials' } as const, [] as Denial[])

/** 自动模式的分类器拒绝了一次调用：记下时间、工具、完整内容（遮掉密钥）和来源 */
async function noteDenial($: EngineInterface, e: ClassicEventOf['classic.PermissionDenied']) {
  const at = await $.clock.now()
  const source = denialSource(e.agent_id, e.agent_type, await read($, agents))
  const denial: Denial = { id: e.tool_use_id, at, tool: e.tool_name, ...denialContent(e.tool_input), source }
  await update($, denials, list => addDenial(list, denial))
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
  const current = await read($, messages)
  const next = reconcile(current, texts)
  if (next !== current) await update($, messages, () => next)
}

/** 主输入框发出的消息进了主会话的对话：先核对此前的（回退后重发时旧的已不在），再记下这条 */
async function noteMessage($: EngineInterface, uuid: string, content: SessionAppendMessage['content']) {
  const text = contentText(content)
  await syncMessages($)
  await update($, messages, list => addMessage(list, { id: uuid, text }))
}

async function settleOnCompact($: EngineInterface) {
  await update($, messages, list => settleMessages(list))
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

/** 正在读 git 时又要读：读完再读一次，不并发 */
type GitRefresh = { isRunning: boolean; isWanted: boolean }

/** 运行一条 git 命令；不在 git 里、git 不在、超时都当没有输出 */
async function git($: EngineInterface, args: readonly string[]): Promise<string | null> {
  const ran = await $.process.run([...GIT, ...args], { timeoutMs: 5000 }).catch(() => null)
  return ran !== null && ran.exitCode === 0 ? ran.stdout : null
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text.trim() : undefined
}

/** rebase 停下时的进度和原分支 */
async function readRebase($: EngineInterface, gitDir: string, names: ReadonlySet<string>): Promise<RebaseFiles | null> {
  if (names.has('rebase-merge')) {
    const dir = `${gitDir}/rebase-merge`
    const [step, total, headName] = await Promise.all([readText($, `${dir}/msgnum`), readText($, `${dir}/end`), readText($, `${dir}/head-name`)])
    return { dir: 'rebase-merge', step, total, headName, isAm: false }
  }
  if (names.has('rebase-apply')) {
    const dir = `${gitDir}/rebase-apply`
    const [step, total, headName, isAm] = await Promise.all([
      readText($, `${dir}/next`),
      readText($, `${dir}/last`),
      readText($, `${dir}/head-name`),
      $.fs.exists(`${dir}/applying`).catch(() => false),
    ])
    return { dir: 'rebase-apply', step, total, headName, isAm }
  }
  return null
}

/** 不在 git 里时为 null */
async function readGit($: EngineInterface): Promise<GitView | null> {
  const repo = await git($, REV_PARSE)
  const paths = repo === null ? null : parseRepo(repo)
  if (!paths) return null
  const [status, numstat, entries] = await Promise.all([git($, STATUS), git($, NUMSTAT), $.fs.list(paths.gitDir).catch(() => [])])
  const names = new Set(entries.map(entry => entry.name))
  const rebase = await readRebase($, paths.gitDir, names)
  return gitView(paths, parseStatus(status ?? ''), numstat === null ? null : parseNumstat(numstat), operationOf(names, rebase), rebase)
}

async function refreshGit($: EngineInterface, refresh: GitRefresh) {
  if (refresh.isRunning) {
    refresh.isWanted = true
    return
  }
  refresh.isRunning = true
  try {
    do {
      refresh.isWanted = false
      const [cwd, view] = await Promise.all([$.session.cwd(), readGit($)])
      await update($, identity, current => ({ ...current, dir: baseName(cwd), git: view }))
    } while (refresh.isWanted)
  } finally {
    refresh.isRunning = false
  }
}

/**
 * 会话开始时还没有请求：模型取会话的，effort 先不写。mod 在第一次请求前拿不到实际的 effort
 * （`--effort`、模型默认值都看不到），第一次主会话请求后以请求带的为准（noteSpeed）
 */
async function startIdentity($: EngineInterface, refresh: GitRefresh) {
  const model = await $.session.model().catch(() => null)
  await update($, identity, current => ({ ...current, model: current.model ?? model }))
  await refreshGit($, refresh)
}

/** 会改文件或运行命令的工具：调用完 git 状态可能变了 */
const CHANGES_FILES = new Set(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** 一次请求的速度：输出速度、首字等待、整次用时；算不出的项为 null */
type Speed = Pick<Identity, 'tokensPerSecond' | 'firstTokenMs' | 'requestMs'>

/** 主会话一次请求的模型、effort 和速度；算不出的项留着上一次的 */
async function noteSpeed($: EngineInterface, e: TurnStepInput, speed: Speed) {
  await update($, identity, current => ({
    ...current,
    model: e.model,
    effort: e.effort ?? null,
    tokensPerSecond: speed.tokensPerSecond ?? current.tokensPerSecond,
    firstTokenMs: speed.firstTokenMs ?? current.firstTokenMs,
    requestMs: speed.requestMs ?? current.requestMs,
  }))
}

// ---------------------------------------------------------------- 面板按键：列表展开、详情、滚动（spec D9）

const fold = atom({ plugin: 'anvil', key: 'fold' } as const, CLOSED)

async function pressList($: EngineInterface, id: ListId) {
  await update($, fold, current => toggleList(current, id))
}

/** 子 agent 的序号键、Enter，自动模式拒绝的 Enter：展开或收起这一项的详情 */
async function pressDetail($: EngineInterface, detailId: string) {
  await update($, fold, current => toggleDetail(current, detailId))
}

/** 展开的列表放不下时，滚轮滚的是列表自己（面板本身放得下，不需要引擎滚）；其余照引擎的 */
async function scrollPanel($: EngineInterface, e: UiScrollInput): Promise<boolean> {
  const current = await read($, fold)
  if (current.expanded === null || e.contentRows > e.bodyRows) return false
  const total = await listLength($, current.expanded)
  await update($, fold, () => scrollList(current, e.by, total))
  return true
}

async function listLength($: EngineInterface, id: ListId): Promise<number> {
  if (id === 'agents') return (await read($, agents)).length
  if (id === 'denials') return (await read($, denials)).length
  return (await read($, messages)).items.length
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

// ---------------------------------------------------------------- 动效（spec D10）：进行中图标、运行中的耗时

/**
 * 正在发生的几件事各自的起止（spec D10「流光」）：主会话回复（这一轮的第一次请求到这一轮结束；子 agent 的不算）、
 * 保活的续期请求、翻译。结束后留着结束的时刻：落定、暗下去要用；下一次开始时换掉
 */
type Activity = { reply: Span | null; keep: Span | null; translate: Span | null }

const activity = atom({ plugin: 'anvil', key: 'activity' } as const, { reply: null, keep: null, translate: null } as Activity)

/** 热重载前存下的可能是别的形状（anvil-k0t.46 的 replying），当作什么都没在发生 */
async function readActivity($: EngineInterface): Promise<Activity> {
  const value: unknown = await read($, activity)
  const span = (one: unknown): Span | null =>
    typeof one === 'object' && one !== null && typeof (one as Span).since === 'number' ? { since: (one as Span).since, until: typeof (one as Span).until === 'number' ? (one as Span).until : null } : null
  const all = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof Activity, unknown>>
  return { reply: span(all.reply), keep: span(all.keep), translate: span(all.translate) }
}

/** 一件事开始（还没在发生时记下开始的时刻）或结束（在发生时记下结束的时刻） */
async function markActivity($: EngineInterface, name: keyof Activity, isOn: boolean) {
  const current = (await readActivity($))[name]
  const now = await $.clock.now()
  if (isOn && (current === null || current.until !== null)) await update($, activity, all => ({ ...all, [name]: { since: now, until: null } }))
  else if (!isOn && current !== null && current.until === null) await update($, activity, all => ({ ...all, [name]: { since: current.since, until: now } }))
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
  await update($, faults, list => (list.includes(name) ? list : [...list, name]))
}

/** 面板里焦点所在元素的 key（ui.focus）；面板失去焦点后不看它 */
const focusKey = atom({ plugin: 'anvil', key: 'focusKey' } as const, null as string | null)

async function noteFocus($: EngineInterface, element: string | null) {
  if ((await read($, focusKey)) !== element) await update($, focusKey, () => element)
}

/**
 * 这次绘制里动效怎么画。相位的零点（epoch）：主会话回复优先，其次保活续期、翻译、最早还在运行的子 agent；
 * 面板和翻译框用同一个，几处的光同相
 */
async function liveFor($: EngineInterface, els: object, surface: RenderSurface, now: number) {
  const [doing, list, faulted] = await Promise.all([readActivity($), read($, agents), read($, faults)])
  const running = list.filter(agent => agent.status === 'running').map(agent => agent.spawnedAt)
  const lead = [doing.reply, doing.keep, doing.translate].find(span => isLive(span, now)) ?? null
  const epoch = lead?.since ?? (running.length > 0 ? Math.min(...running) : 0)
  return liveOf(els, surface, now, faulted, epoch)
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

/** `/anvil panel`：显示着就隐藏（本会话不再自动打开），隐藏着就重新打开 */
async function togglePanel($: EngineInterface) {
  if (!(await read($, panelHidden))) {
    await update($, panelHidden, () => true)
    await $.ui.close({ id: PANE.id })
    return '面板已隐藏（本会话）'
  }
  await update($, panelHidden, () => false)
  const opened = await openPanel($)
  return opened.isPlaced ? '面板已显示' : `面板已显示，但暂时放不下：${opened.reason}`
}

async function notePanelClosed($: EngineInterface, e: PaneCloseInput) {
  if (hidesPanel(e.origin)) await update($, panelHidden, () => true)
}

async function drawAnvilPanel($: EngineInterface, settings: Settings, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e)
  const [current, list, denied, mine, folding, now, who] = await Promise.all([
    read($, usage),
    read($, agents),
    read($, denials),
    read($, messages),
    foldForDrawing($, e.props.isFocused),
    $.clock.now(),
    read($, identity),
  ])
  const [cached, keepalive, loop, live, doing, focused, histories] = await Promise.all([
    read($, cacheView),
    keepaliveNow($, settings),
    read($, keepaliveLoop),
    liveFor($, els, e.surface, now),
    readActivity($),
    read($, focusKey),
    readHistories($),
  ])
  // 用户进了面板要按 Enter 时，列表里不该有已撤回的消息：画完核对一遍，有变化会再画
  if (e.props.isFocused) $.clock.after(0, () => void syncMessages($).catch(() => undefined))
  const columns = e.props.bodyColumns
  const inner = innerWidth(columns)
  const usageBody = spacedGridRows(els, usageRows(current, now, inner, histories), inner)
  // 保活的续期请求在路上："进行中"上滚过微光，后面接转动的图标（缓存框第三行：面板第 3 行，值从第 10 列起）
  const keepRow = (row: GridRow) => {
    if (row.key !== 'keepalive' || !loop.inFlight) return gridRow(els, row, inner)
    const place = { row: 3, x: 2 + GRID.label + GRID.gap, width: columns }
    const text = (row.lines[0] ?? []).flatMap(segment => toCells(segment.text, segment.color, segment.bold))
    const first = glowText(els, live, { key: 'glow:keepalive', cells: text, place, span: doing.keep, mode: 'shimmer', shine: LIGHT.shine })
    const tail = spinAfter(els, live, { key: 'spin:keepalive', place: { ...place, x: place.x + text.length + 1 } })
    return gridRow(els, row, inner, tail, first)
  }
  return drawPanel(els, {
    columns,
    rows: e.props.scroll.bodyRows,
    bodies: {
      usage: { rows: usageBody },
      cache: { rows: cacheRows(cached, keepalive, now, inner).flatMap(keepRow) },
    },
    lists: {
      messages: messageList(els, mine, { inner, onPress: id => void scrollToMessage($, id) }),
      denials: denialList(els, denied, { detail: folding.detail, inner, onPress: id => void pressDetail($, id) }),
      // 子 agent 的行大约从第几行起：缓存框 5 行、细槽、用量框、细槽、上边框
      agents: agentList(els, list, { detail: folding.detail, now, inner, live, top: 5 + 1 + usageBody.length + 2 + 1 + 1, focused: e.props.isFocused ? focused : null, onPress: id => void pressDetail($, id) }),
    },
    fold: folding,
    identity: identityRows(els, who, columns, { reply: doing.reply, live, rows: e.props.scroll.bodyRows }),
    motion: { live, reply: doing.reply },
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

/**
 * 翻译框里按 Enter：翻译、追加。引擎已经清空框、把焦点交回主输入框，成功时照它的做法，不抢回焦点；
 * 失败时把中文画回框里、焦点交给它，显示原因，再按 Enter 重试
 */
async function submitChinese($: EngineInterface, settings: Settings, band: string, value: string) {
  if (!shouldTranslate(await read($, translateBox), value)) return
  await update($, translateBox, box => startTranslating(box, value))
  await markActivity($, 'translate', true).catch(() => undefined)
  const translation = await translateText($, settings, value).finally(() => markActivity($, 'translate', false).catch(() => undefined))
  const refusal = 'error' in translation ? translation.error : await appendToPrompt($, translation.text)
  if (refusal === null && 'text' in translation) {
    await update($, translateBox, box => translated(box, countWords(translation.text)))
    return
  }
  const next = await update($, translateBox, box => failed(box, refusal ?? ''))
  // plugin test 里没有 ui.focus 的实现，会拒绝；焦点只能在交互会话里验证
  await $.ui.focus({ requestId: band, key: inputKey(next) }).catch(() => undefined)
}

/** 翻译框里改字：记下框空没空，开始写下一句时去掉"已追加" */
async function typeChinese($: EngineInterface, value: string) {
  const next = typed(await read($, translateBox), value)
  if (next !== null) await update($, translateBox, () => next)
}

/** 画翻译框；隐藏了、有问卷占着那一栏时返回 null，让出来 */
async function drawTranslate($: EngineInterface, settings: Settings, e: RenderInput<'AbovePrompt'>) {
  // 先排除 mobile，resolve 出来的元素才有 Input
  if (e.surface === 'mobile' || e.props.hasSurvey || (await read($, translateHidden))) return null
  const els = $.ui.resolve(e)
  const [box, now, doing] = await Promise.all([read($, translateBox), $.clock.now(), readActivity($)])
  return drawTranslateBox(els, {
    columns: e.props.bodyColumns,
    box,
    live: await liveFor($, els, e.surface, now),
    span: doing.translate,
    onSubmit: value => void submitChinese($, settings, e.requestId, value),
    onInput: value => void typeChinese($, value),
  })
}

/** `/anvil translate`：显示着就隐藏，隐藏着就恢复 */
async function toggleTranslate($: EngineInterface) {
  const isHidden = !(await read($, translateHidden))
  await update($, translateHidden, () => isHidden)
  return isHidden ? '翻译框已隐藏（本会话）' : '翻译框已显示'
}

// ---------------------------------------------------------------- /anvil 命令

// 各功能交出的 /anvil 子命令说明，按列出的顺序排
const SUBCOMMANDS: readonly Subcommand[] = [PANEL_SUBCOMMAND, TRANSLATE_SUBCOMMAND, KEEPALIVE_SUBCOMMAND]

/** `/anvil` 不带参数时列出的各子命令在本会话现在的状态，和 SUBCOMMANDS 同序 */
async function subcommandStates($: EngineInterface, settings: Settings): Promise<Listed[]> {
  const [panel, translate, keepalive] = await Promise.all([read($, panelHidden), read($, translateHidden), keepaliveNow($, settings)])
  const states = [panel ? '隐藏' : '显示', translate ? '隐藏' : '显示', keepalive.text]
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
  const gitRefresh: GitRefresh = { isRunning: false, isWanted: false }

  on('session.start', async ($, e, next) => {
    await publishSettings($, settings)
    // 功能在这里按顺序接入
    // 热重载换掉模块内存、撤掉定时器：缓存状态和保活循环从 `$.state` 接上，按接上的状态重新定时、定好缓存框的重画
    await startCache($, cache)
    await startLoop($, loop)
    await cacheChanged($, cache, loop, redraw, settings)
    await readUsage($)
    await startIdentity($, gitRefresh).catch(() => undefined)
    await startPanel($)
    await registerAnvil($)
    return next(e)
  })

  // `/clear`、恢复会话不触发 session.start，只走这里
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await resumeCache($, cache, e)
    // `/clear`、会话内恢复别的会话（`/resume`、`/branch`）都换了对话：上一段空闲的停下不再算，
    // 按起步的缓存状态重新定时（冷了不发）
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') startStretch(loop)
    await cacheChanged($, cache, loop, redraw, settings)
    await refreshGit($, gitRefresh).catch(() => undefined)
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
    // token/s 从首字算起（D11 实测）：首字是第一块不是 engine 的，结束是 stop 那块；
    // 首字等待和整次用时从请求开始算
    const startAt = await $.clock.now()
    let firstAt: number | null = null
    let stopAt: number | null = null
    let output: number | undefined
    const stream = next(e)
    for await (const chunk of stream) {
      if (chunk.kind === 'stop') {
        stopAt = await $.clock.now()
        output = chunk.usage?.output_tokens
      } else if (firstAt === null && chunk.kind !== 'engine') {
        firstAt = await $.clock.now()
      }
      yield chunk
    }
    const result = await stream.result
    if (result.usage) await stepAnswered($, cache, result.usage)
    await noteSpeed($, e, {
      tokensPerSecond: tokensPerSecond(output ?? result.usage?.output_tokens, firstAt, stopAt),
      firstTokenMs: firstAt === null ? null : firstAt - startAt,
      requestMs: stopAt === null ? null : stopAt - startAt,
    }).catch(() => undefined)
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
      await refreshGit($, gitRefresh).catch(() => undefined)
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
    // 不等它读完，工具结果先交回去；子 agent 改的文件也算
    if (CHANGES_FILES.has(String(e.tool))) void refreshGit($, gitRefresh).catch(() => undefined)
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
    await reopenPanel($, e).catch(() => undefined)
    // 用户可能在别处运行过 git；不等它读完
    void refreshGit($, gitRefresh).catch(() => undefined)
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

  // 翻译框常驻在主输入框上方
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawTranslate($, settings, e)) ?? next(e))

  on('ui.scroll', { component: 'Pane', requestId: 'anvil' }, async ($, e, next) => {
    // 改了展开状态，引擎自己会重画
    if (await scrollPanel($, e).catch(() => false)) return {}
    return next(e)
  })

  // 功能自己的子命令在这里接入（带 args 匹配器），兜底的放最后
  on('command.run', { command: 'anvil', args: /^\s*panel\s*$/ }, async $ => ({ text: await togglePanel($) }))
  on('command.run', { command: 'anvil', args: /^\s*translate\s*$/ }, async $ => ({ text: await toggleTranslate($) }))
  on('command.run', { command: 'anvil', args: /^\s*keepalive\s*$/ }, async $ => ({ text: await toggleKeepalive($, cache, loop, settings) }))

  // 兜底回答功能没接走的 /anvil
  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(await subcommandStates($, settings), e.args) }))
}