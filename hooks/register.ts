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

import { COMMAND, answer } from './command'
import { EMPTY_IDENTITY, GIT, NUMSTAT, REV_PARSE, STATUS, baseName, gitView, identityRows, operationOf, parseNumstat, parseRepo, parseStatus, tokensPerSecond } from './identity'
import type { RebaseFiles } from './identity'
import type { Subcommand } from './command'
import { describeInput } from './describe'
import { CLOSED, isClosed, scrollList, toggleDetail, toggleList } from './list'
import { PANE, PANEL_SUBCOMMAND, drawPanel, gridRow, hidesPanel, innerWidth } from './panel'
import { readSettings } from './settings'
import { EMPTY_USAGE, applyReading, compacted as addCompaction, completeTurn, startTurn, usageRows } from './usage'
import type { Reading } from './usage'
import type { GitView, ListId, Settings, SubAgent } from '../types'

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
//   "更早的"那行、展开和收成一行由 panel.tsx 按共同规则做（list.ts）。身份栏的两行交 identity，接在区块之后。

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

/** 会话开始时还没有请求：模型先取会话的，effort 等第一次请求 */
async function startIdentity($: EngineInterface, refresh: GitRefresh) {
  const model = await $.session.model().catch(() => null)
  await update($, identity, current => ({ ...current, model: current.model ?? model }))
  await refreshGit($, refresh)
}

/** 会改文件或运行命令的工具：调用完 git 状态可能变了 */
const CHANGES_FILES = new Set(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** 主会话一次请求的模型、effort 和输出速度；算不出速度时留着上一次的 */
async function noteSpeed($: EngineInterface, e: TurnStepInput, speed: number | null) {
  await update($, identity, current => ({
    ...current,
    model: e.model,
    effort: e.effort ?? null,
    tokensPerSecond: speed ?? current.tokensPerSecond,
  }))
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

async function drawAnvilPanel($: EngineInterface, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e)
  const [current, list, folding, now, who] = await Promise.all([
    read($, usage),
    read($, agents),
    foldForDrawing($, e.props.isFocused),
    $.clock.now(),
    read($, identity),
  ])
  const inner = innerWidth(e.props.bodyColumns)
  return drawPanel(els, {
    columns: e.props.bodyColumns,
    rows: e.props.scroll.bodyRows,
    bodies: { usage: { rows: usageRows(current, now, inner).map(row => gridRow(els, row, inner)) } },
    lists: { agents: agentList(els, list, { detail: folding.detail, now, inner, onPress: id => void pressAgent($, id) }) },
    fold: folding,
    identity: identityRows(els, who, e.props.bodyColumns),
    onToggle: id => void pressList($, id),
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
  const gitRefresh: GitRefresh = { isRunning: false, isWanted: false }

  on('session.start', async ($, e, next) => {
    await publishSettings($, settings)
    // 功能在这里按顺序接入
    await startCache($, cache)
    await startUsage($)
    await startIdentity($, gitRefresh).catch(() => undefined)
    await startPanel($)
    await registerAnvil($)
    return next(e)
  })

  // `/clear`、恢复会话不触发 session.start，只走这里
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await resumeCache($, cache, e)
    await refreshGit($, gitRefresh).catch(() => undefined)
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
    // tok/s 从首字算起（D11 实测）：首字是第一块不是 engine 的，结束是 stop 那块
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
    await noteSpeed($, e, tokensPerSecond(output ?? result.usage?.output_tokens, firstAt, stopAt)).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await turnCompleted($, cache, e)
      await completeUsageTurn($)
      await refreshGit($, gitRefresh).catch(() => undefined)
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

  on('ui.render', { component: 'Pane', requestId: 'anvil' }, async ($, e) => drawAnvilPanel($, e))

  on('ui.scroll', { component: 'Pane', requestId: 'anvil' }, async ($, e, next) => {
    // 改了展开状态，引擎自己会重画
    if (await scrollPanel($, e).catch(() => false)) return {}
    return next(e)
  })

  // 功能自己的子命令在这里接入（带 args 匹配器），兜底的放最后
  on('command.run', { command: 'anvil', args: /^\s*panel\s+hide\s*$/ }, async $ => ({ text: await hidePanel($) }))
  on('command.run', { command: 'anvil', args: /^\s*panel\s+show\s*$/ }, async $ => ({ text: await showPanel($) }))

  // 兜底回答功能没接走的 /anvil
  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(SUBCOMMANDS, e.args) }))
}