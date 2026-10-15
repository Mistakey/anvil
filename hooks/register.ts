// anvil 的 hooks 入口：所有 on(...) 和用到 `$` 的辅助函数都在这里，结构说明见下面「模块结构」。
// 模块结构照 flightdeck（https://github.com/scasella/claude-flightdeck）的 register.tsx / core.ts：
// MIT License, Copyright (c) 2026 Stephen Casella。缓存状态的估算和保活循环的接线照 cache-tax
// （https://github.com/karanb192/cache-tax，HEAD 06cac47）改写：MIT License, Copyright (c) 2026 Karan Bansal。
// 两份许可原文见 THIRD_PARTY_NOTICES.md。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, TurnCompleteInput, TurnStepInput, TurnUsage } from 'claude-code'

import { EMPTY_PLACE, GIT, NUMSTAT, REV_PARSE, STATUS, bandLine, baseName, drawBand, gitView, operationOf, parseNumstat, parseRepo, parseStatus } from './band'
import type { RebaseFiles } from './band'
import * as cacheState from './cache'
import type { Cache, ResumeFields, Submission } from './cache'
import { answer, describe } from './command'
import type { Listed, Subcommand } from './command'
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
  savedExpiry,
  startStretch,
  statuslineFile,
  stopFor,
  thrownStop,
} from './keepalive'
import type { Loop } from './keepalive'
import { readSettings } from './settings'
import { normalized, normalizing } from './shape'
import { addTally, requestSpeed, turnDurationRow } from './speed'
import { EMPTY_USAGE, HISTORY_KEYS, applyReading, parseHistory, parseResetsAt, recordSample, storedLimits } from './usage'
import type { Histories, Reading } from './usage'
import type { BandPart, GitView, KeepaliveStop, Settings, SpeedTally, TurnSpeeds } from '../types'

// 模块结构（照 flightdeck 的 register.tsx / core.ts），引擎扫描源码的规则见 AGENTS.md Pitfalls「模块结构」：
// - 所有 on(...) 都写在下面的 register 里；用到 `$` 的辅助函数写在本文件顶层（`$` 不能跨文件传）。
//   功能文件（band.tsx、keepalive.ts 等）只放不碰 `$` 的纯逻辑和界面组件，由这里调用。
// - 几个功能都要的事件（session.start 等）只注册一次、不带匹配器：处理函数里按写下的顺序依次调用各功能，
//   先后顺序就是处理函数里的行序。新功能往这类事件里加一行调用，放在它依赖的功能之后、`/anvil` 命令之前。
// - 只属于一个功能的事件用真匹配器注册（带 args 的 command.run、按 component 的 ui.render 等），
//   不用 `{}` 空匹配器。新功能的子命令说明加进 SUBCOMMANDS（补全菜单的参数提示也由它列出）、现在的状态加进 subcommandStates，
//   执行写成带 args 匹配器的 command.run（只认子命令本身，敲一次切换一次），注册在兜底的 command.run 之前。
// - 热重载不清 `$.state`，旧代码按旧形状写下的值还在：对象、列表形状的 atom 读写时合并到现在的形状上
//   （`normalized(x, await read($, x))`、`update($, x, normalizing(x, …))`，形状写在 shape.ts）；新加或改了形状的 atom 同样处理。
// - 显示分两处（用户 2026-10-14/15 定）：主输入框上方的 band（AbovePrompt）画目录、git、5h、7d、花费（band.tsx）；
//   主输入框下方是用户自己的 statusline 脚本（不归本仓库），anvil 只往 `~/.claude/anvil/sessions/` 写保活状态给它读。

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

/** 把缓存状态的读数写进 `$.state`，保活状态和测试从这里读；原样另存一份，热重载后接上 */
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
  else cacheState.seedFromResume(cache, e, await $.clock.now(), await resumedExpiry($))
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

async function publishLoop($: EngineInterface, loop: Loop, settings: Settings) {
  await $.state.set(LOOP_MEMORY, loopMemory(loop))
  await update($, keepaliveLoop, () => loopView(loop))
  await writeStatusline($, settings).catch(() => undefined)
}

/** 会话开始（含热重载）：接上上一次加载存下的续期次数、停下和重新开启的时刻；旧模块的定时器已被引擎撤掉，这次重新定时 */
async function startLoop($: EngineInterface, loop: Loop) {
  restoreLoop(loop, (await $.state.get(LOOP_MEMORY)).value)
}

/** 按缓存状态重新定时（cache-tax 的 arm）：没开、已停下、冷了都不定时；这段空闲到上限就停下 */
async function armKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  disarm(loop)
  if (loop.stopped || !isEnabled(settings, await read($, keepaliveOverride), cache.context)) return publishLoop($, loop, settings)
  const delay = nextDelay(cache, loop, await $.clock.now())
  if (delay === 'limit') return stopKeepalive($, loop, settings, LIMIT_STOP)
  if (delay !== null) loop.pending = $.clock.after(delay, () => void pingKeepalive($, cache, loop, settings).catch(() => undefined))
  await publishLoop($, loop, settings)
}

async function stopKeepalive($: EngineInterface, loop: Loop, settings: Settings, stop: KeepaliveStop) {
  disarm(loop)
  loop.stopped = stop
  await publishLoop($, loop, settings)
}

/** 定时器到点：发一次 fork，读数达标就续期、再定时，否则停下（cache-tax 的 ping） */
async function pingKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  loop.pending = null
  if (loop.stopped || loop.inFlight) return
  if (!isEnabled(settings, await read($, keepaliveOverride), cache.context)) return publishLoop($, loop, settings)
  const now = await $.clock.now()
  const action = dueAction(cache, loop, now)
  if (action === 'limit') return stopKeepalive($, loop, settings, LIMIT_STOP)
  if (action === 'rearm') return armKeepalive($, cache, loop, settings)

  const stretch = cache.lastRequestAt
  loop.inFlight = true
  await publishLoop($, loop, settings)
  let stop: KeepaliveStop | null
  try {
    stop = stopFor(await $.model.fork({ prompt: PING_PROMPT }))
  } catch (error) {
    stop = thrownStop(error)
  }
  loop.inFlight = false
  // 请求路上用户回来发了消息：这一段空闲已经结束，结果不再算到新的一段上（cache-tax 没有这层）
  if (cache.lastRequestAt !== stretch) return publishLoop($, loop, settings)
  if (stop) return stopKeepalive($, loop, settings, stop)
  renew(cache, now)
  loop.renewals += 1
  await publishCache($, cache)
  await armKeepalive($, cache, loop, settings)
}

/**
 * `/anvil keepalive`：运行中（已启用、没停下）就关掉，没开或已停下就开启，之后不再看自动开启和阈值（D3）。
 * 开启时这一段空闲的停下也清掉、12 小时上限从现在重新算，按缓存状态重新定时；关闭时 armKeepalive 只撤掉定时器。
 */
async function toggleKeepalive($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  const isRunning = isEnabled(settings, await read($, keepaliveOverride), cache.context) && loop.stopped === null
  const isOn = !isRunning
  await update($, keepaliveOverride, () => isOn)
  if (isOn) restart(loop, await $.clock.now())
  await armKeepalive($, cache, loop, settings)
  return isOn ? 'Cache keepalive on (this session)' : 'Cache keepalive off (this session)'
}

/** 保活状态的输入：设置、本会话的切换、上下文、循环的读数 */
async function keepaliveInput($: EngineInterface, settings: Settings) {
  const [cached, override, loop] = await Promise.all([read($, cacheView).then(value => normalized(cacheView, value)), read($, keepaliveOverride), read($, keepaliveLoop).then(value => normalized(keepaliveLoop, value))])
  return { settings, override, context: cached.context, loop }
}

/** `/anvil` 列表里的保活状态 */
async function keepaliveNow($: EngineInterface, settings: Settings) {
  return keepaliveStatus(await keepaliveInput($, settings))
}

/** 缓存状态变了：保活按新的状态重新定时（同时把会不会续写给 statusline） */
async function cacheChanged($: EngineInterface, cache: Cache, loop: Loop, settings: Settings) {
  await armKeepalive($, cache, loop, settings)
}

// ---------------------------------------------------------------- 写给 statusline 的保活状态

/** 上一次写下的文件和内容（不含时刻）：没变就不写 */
let statuslineWritten = ''

/** 会话开始时、写状态文件之前读到的那份：新进程里恢复会话时 session.start 会先把文件写掉，恢复时用这份 */
let savedAtStart: { path: string; expiresAt: number | null } | null = null

/** 这个会话的状态文件；拿不到配置目录或会话 id 时为 null */
async function statuslinePath($: EngineInterface): Promise<string | null> {
  const [dir, id] = await Promise.all([configDir($), $.session.id()])
  return dir === null || id === '' ? null : `${dir}/anvil/sessions/${id}.json`
}

async function readSavedExpiry($: EngineInterface, path: string): Promise<number | null> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? savedExpiry(text) : null
}

/** session.start 一开始：先记下上一次写下的过期时刻 */
async function rememberSaved($: EngineInterface) {
  const path = await statuslinePath($)
  savedAtStart = path === null ? null : { path, expiresAt: await readSavedExpiry($, path) }
}

/** 恢复会话：这个会话上一次写下的过期时刻（会话开始时记下的那份，或会话内 `/resume` 到的别的会话的文件） */
async function resumedExpiry($: EngineInterface): Promise<number | null> {
  const path = await statuslinePath($)
  if (path === null) return null
  return savedAtStart?.path === path ? savedAtStart.expiresAt : readSavedExpiry($, path)
}

/** `~/.claude`；设了 CLAUDE_CONFIG_DIR 时按它 */
async function configDir($: EngineInterface): Promise<string | null> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude` : null
}

/**
 * 把这个会话会不会自动续期、续期出没出错写进 `~/.claude/anvil/sessions/<session_id>.json`：
 * statusline 按 stdin 的 session_id 读（用户 2026-10-15 定）。内容没变就不写
 */
async function writeStatusline($: EngineInterface, settings: Settings) {
  const [path, input, cached, now] = await Promise.all([statuslinePath($), keepaliveInput($, settings), read($, cacheView), $.clock.now()])
  if (path === null) return
  const file = statuslineFile(input, normalized(cacheView, cached).expiresAt, now)
  const key = `${path}\n${file.renews}\n${file.error}\n${file.expiresAt}`
  if (key === statuslineWritten) return
  await $.fs.write(path, JSON.stringify(file))
  statuslineWritten = key
}

// ---------------------------------------------------------------- 输入框上方那一行：用量

const usage = atom({ plugin: 'anvil', key: 'usage' } as const, EMPTY_USAGE)

async function noteReading($: EngineInterface, reading: Reading) {
  // 先记进存档再更新读数：读数一变那一行就重画，重画时存档已经是新的
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

/** 本会话还没有 5h、7d 的读数时，先画存档里最近的 */
async function seedFromHistory($: EngineInterface) {
  if (normalized(usage, await read($, usage)).rateLimits.length > 0) return
  const histories: Histories = {}
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const history = parseHistory(await $.store.get(HISTORY_KEYS[kind]))
    if (history) histories[kind] = history
  }
  const stored = storedLimits(histories, await $.clock.now())
  if (stored.length > 0) await update($, usage, normalizing(usage, current => (current.rateLimits.length > 0 ? current : { ...current, rateLimits: stored })))
}

/** 读一次；读数里有 5h、7d 时返回 true */
async function readUsage($: EngineInterface): Promise<boolean> {
  const reading = await $.session.usage().catch(() => null)
  if (reading) await noteReading($, reading)
  return reading !== null && reading.rateLimits.length > 0
}

/** 开局时引擎的 5h、7d 还空着，约 3 秒后才有（伪终端实测）：先画存档，再隔一阵读一次，最多读 USAGE_RETRIES 次 */
const USAGE_RETRY_MS = 2000
const USAGE_RETRIES = 10

async function startUsage($: EngineInterface) {
  await seedFromHistory($).catch(() => undefined)
  if (await readUsage($)) return
  retryUsage($, USAGE_RETRIES)
}

function retryUsage($: EngineInterface, left: number) {
  if (left <= 0) return
  $.clock.after(USAGE_RETRY_MS, () => {
    void readUsage($).then(
      found => (found ? undefined : retryUsage($, left - 1)),
      () => undefined,
    )
  })
}

// ---------------------------------------------------------------- 输入框上方那一行：目录与 git

const place = atom({ plugin: 'anvil', key: 'place' } as const, EMPTY_PLACE)

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

async function refreshPlace($: EngineInterface, refresh: GitRefresh) {
  if (refresh.isRunning) {
    refresh.isWanted = true
    return
  }
  refresh.isRunning = true
  try {
    do {
      refresh.isWanted = false
      const [cwd, view] = await Promise.all([$.session.cwd(), readGit($)])
      await update($, place, () => ({ dir: baseName(cwd), git: view }))
    } while (refresh.isWanted)
  } finally {
    refresh.isRunning = false
  }
}

/** 会改文件或运行命令的工具：调用完 git 状态可能变了 */
const CHANGES_FILES = new Set(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** 画那一行；有问卷占着那一栏、手机上不画、设置里一段都没选时，交给引擎 */
async function drawAbovePrompt($: EngineInterface, e: RenderInput<'AbovePrompt'>, parts: readonly BandPart[]) {
  if (e.surface === 'mobile' || e.props.hasSurvey || parts.length === 0) return null
  const [where, used, now] = await Promise.all([read($, place).then(value => normalized(place, value)), read($, usage).then(value => normalized(usage, value)), $.clock.now()])
  const columns = e.props.bodyColumns
  return drawBand($.ui.resolve(e), bandLine(where, used, now, columns, parts), columns)
}

// ---------------------------------------------------------------- 每段回复末尾的速度

const NO_TURN_SPEEDS: TurnSpeeds = { current: null, lines: {} }
const turnSpeeds = atom({ plugin: 'anvil', key: 'turnSpeeds' } as const, NO_TURN_SPEEDS)

/** 还在跑的子 agent：原生收尾那行这时换成"Waiting for N background agents to finish"，读数按它算起点 */
const runningAgents = atom({ plugin: 'anvil', key: 'runningAgents' } as const, [] as string[])

/** 记着的收尾行最多这么多段，多了丢最早的 */
const TURN_LINES = 500

/** 主会话一次请求的速度：算得出就计入这一段的读数 */
async function noteSpeed($: EngineInterface, e: TurnStepInput, speed: SpeedTally | null) {
  if (!speed) return
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
  const [now, running] = await Promise.all([$.clock.now(), read($, runningAgents).then(value => normalized(runningAgents, value))])
  await update($, turnSpeeds, normalizing(turnSpeeds, current => {
    if (!current.current) return current
    const { tally, firstTokenMs } = current.current
    const kept = Object.entries(current.lines).slice(-(TURN_LINES - 1))
    return { current: null, lines: { ...Object.fromEntries(kept), [uuid]: { tally, firstTokenMs, doneAt: now, waitingAgents: running.length } } }
  }))
}

/** 换了对话（`/clear`、`/resume`、`/branch`）：旧的收尾行不再画在屏幕上 */
async function resetSpeeds($: EngineInterface) {
  await update($, turnSpeeds, () => NO_TURN_SPEEDS)
}

/** 这一段回复的读数；恢复前的、打断的没有 */
async function turnSpeedOf($: EngineInterface, requestId: string) {
  return normalized(turnSpeeds, await read($, turnSpeeds)).lines[requestId]
}

async function noteAgent($: EngineInterface, agentId: string, isRunning: boolean) {
  await update($, runningAgents, normalizing(runningAgents, list => (isRunning ? (list.includes(agentId) ? list : [...list, agentId]) : list.filter(id => id !== agentId))))
}

// ---------------------------------------------------------------- /anvil 命令

// 各功能交出的 /anvil 子命令说明，按列出的顺序排
const SUBCOMMANDS: readonly Subcommand[] = [KEEPALIVE_SUBCOMMAND]

/** `/anvil` 不带参数时列出的各子命令在本会话现在的状态，和 SUBCOMMANDS 同序 */
async function subcommandStates($: EngineInterface, settings: Settings): Promise<Listed[]> {
  const states = [(await keepaliveNow($, settings)).text]
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
  const gitRefresh: GitRefresh = { isRunning: false, isWanted: false }

  on('session.start', async ($, e, next) => {
    await rememberSaved($).catch(() => undefined)
    await publishSettings($, settings)
    // 功能在这里按顺序接入
    // 热重载换掉模块内存、撤掉定时器：缓存状态和保活循环从 `$.state` 接上，按接上的状态重新定时
    await startCache($, cache)
    await startLoop($, loop)
    await cacheChanged($, cache, loop, settings)
    await startUsage($)
    await refreshPlace($, gitRefresh).catch(() => undefined)
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
    await cacheChanged($, cache, loop, settings)
    // `$.state` 换了对话就清空：用量和 git 重新读，不等第一条消息
    await startUsage($)
    await refreshPlace($, gitRefresh).catch(() => undefined)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    await stepStarted($, cache)
    // 用户回来了：这一段空闲结束，一轮结束时再定时（cache-tax 也是一轮结束才定时）
    startStretch(loop)
    await publishLoop($, loop, settings)
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
      await turnCompleted($, cache, e)
      await cacheChanged($, cache, loop, settings)
      // 本会话花费在一轮结束时重新读
      await readUsage($).catch(() => undefined)
      await refreshPlace($, gitRefresh).catch(() => undefined)
    } else {
      await noteAgent($, e.agentId, false).catch(() => undefined)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId) await noteAgent($, started.agentId, true).catch(() => undefined)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (CHANGES_FILES.has(String(e.tool))) void refreshPlace($, gitRefresh).catch(() => undefined)
    return ran
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
      await cacheChanged($, cache, loop, settings)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // 用户可能在别处运行过 git；不等它读完
    void refreshPlace($, gitRefresh).catch(() => undefined)
    if (settings.guard) {
      const drop = await guardSubmission($, cache, e, settings.threshold)
      if (drop !== null) return { drop }
    }
    return next(e)
  })

  // 原生收尾那行后面接这一段的读数；没有读数时照原样
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const turn = e.surface === 'terminal' ? await turnSpeedOf($, e.requestId) : undefined
    if (!turn) return next(e)
    return turnDurationRow($.ui.resolve(e), await next(e), e.props, turn)
  })

  // 主输入框上方：目录名 · git · 5h · 7d · 花费
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawAbovePrompt($, e, settings.band)) ?? next(e))

  // 功能自己的子命令在这里接入（带 args 匹配器），兜底的放最后
  on('command.run', { command: 'anvil', args: /^\s*keepalive\s*$/ }, async $ => ({ text: await toggleKeepalive($, cache, loop, settings) }))

  // 兜底回答功能没接走的 /anvil
  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(await subcommandStates($, settings), e.args) }))
}
