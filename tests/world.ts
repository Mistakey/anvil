import type {
  AgentSpawnInput,
  CommandRunInput,
  CommandSpec,
  FsEntry,
  HookStream,
  ModelForkResult,
  On,
  ProcessRunResult,
  PromptSubmitInput,
  SessionMessage,
  SessionStartInput,
  SessionUsage,
  TurnCompleteInput,
  TurnStepInput,
  TurnUsage,
} from 'claude-code'

export const SESSION: SessionStartInput = { cwd: '/work', surface: null, isInteractive: true }

export type WorldOptions = {
  /** `$.session.model()` 的回答 */
  model?: string
  /** 引擎的实时上下文（`$.session.usage().context.tokens`），测试中途可改 */
  live?: { tokens?: number }
  /** 主输入框里的草稿，测试中途可改；`$.prompt.fill` 写进这里 */
  box?: { text: string }
  /** `refuse` 时主输入框不收 `$.prompt.fill`（引擎自己的拒绝原因测试里造不出，测试的钩子给的会被剥掉） */
  fill?: { refuse: boolean }
  /** 下一次请求的回复带的 usage，测试中途可改；null 表示没有回复 */
  reply?: { usage: TurnUsage | null }
  /** `$.session.usage()` 的整份读数（用量框用），测试中途可改；给了它就不看 `live` */
  reading?: { current: SessionUsage }
  /** 下一次请求停在哪（`turn.step` 结果的 stopReason），测试中途可改；默认 end_turn */
  stop?: { reason: string }
  /** `$.session.messages()` 读到的主会话对话，测试中途可改；不给时插件读不到对话 */
  transcript?: { messages: SessionMessage[] }
  /**
   * `$.model.fork`（缓存保活）依次给出的回答，测试中途可往里加；用完后答 nothing-to-fork，
   * 保活随即停下，不碰保活的测试因此不受它影响。`throw` 表示这次调用直接抛错。
   */
  forks?: ForkAnswer[]
  /**
   * 插件写进 `$.state` 的这些键（写作 `plugin.key`）一律换成给的值，直到测试从返回的 `rewrite` 里删掉：
   * 造出"上一次加载留下的 `$.state`"，再让插件收到一次 session.start，就是模块内存和 `$.state` 不一致的热重载。
   * 测试的钩子给 `state.get` 的值会被剥掉，造不出读到的值，只能改写插件写下的值。
   */
  rewrite?: Record<string, unknown>
  /** git 和 git 目录按它作答，测试中途可改；不给时不在 git 里 */
  repo?: { current: Repo }
  /** `$.env.get` 读到的环境变量；不给的都是没设 */
  env?: Record<string, string>
}

/** 一个仓库在某一刻的样子：git 命令的输出，和 git 目录里的文件（键是相对 git 目录的路径） */
export type Repo = {
  cwd: string
  /** rev-parse 的四行；null 表示不在 git 里（exit 128） */
  revParse: string | null
  status: string
  numstat: string | null
  files?: Record<string, string>
}

export const NO_REPO: Repo = { cwd: '/work', revParse: null, status: '', numstat: null }

const ran = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const notRepo: ProcessRunResult = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false }

/** 测试会话的 id：写给 statusline 的文件按它命名 */
export const SESSION_ID = 'test-session'

/** 一次 fork 的回答：读写数（回复正常），整份结果，或抛错 */
export type ForkAnswer = { read: number; write: number } | ModelForkResult | { throw: string }

/** 读到整段缓存、只写了自己那一条：续上了 */
export const WARM: ForkAnswer = { read: 150000, write: 40 }

// 插件之下的世界：替引擎回答插件用到的调用，并记下插件注册的命令、写进 `$.state` 的值、
// 进入会话的消息、放回主输入框的文本、运行的 git 命令和写下的文件。git、文件、环境变量都不碰本机
const slashed = (path: string) => path.replace(/\\/g, '/')

/**
 * 不碰本机：会话 id、环境变量、写文件、跑命令、`$.store` 都由测试作答（没有钩子时引擎可能真的去做）。
 * 不用 world 的测试自己调它；world 自己有一套能核对的
 */
export function offline(on: On) {
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.cwd', () => ({ value: NO_REPO.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: notRepo }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

export function world(on: On, options: WorldOptions = {}) {
  const commands: string[] = []
  const registered: CommandSpec[] = []
  const state = new Map<string, unknown>()
  const entered: string[] = []
  const fills: string[] = []
  const box = options.box ?? { text: '' }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // 插件的 `$.store`（用量预测的读数存档）；测试拿到的 `$` 没有 store，从返回的 store 看插件存了什么
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: options.reading?.current ?? { startedAt: 0, context: { window: 1000000, tokens: options.live?.tokens }, rateLimits: [] },
  }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    registered.push(e)
    return { value: { command: e.name } }
  })
  // 测试拿到的 `$` 没有 state 这个名词，只能在插件之下看它写了什么，再交给测试工具自带的 state
  const rewrite = new Map(Object.entries(options.rewrite ?? {}))
  on('state.set', ($, e, next) => {
    const name = `${e.plugin}.${e.key}`
    const written = rewrite.has(name) ? { ...e, value: rewrite.get(name) as never } : e
    state.set(name, written.value)
    return next(written)
  })
  on('classic.SessionStart', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  if (options.transcript) {
    const transcript = options.transcript
    on('session.messages', () => ({ value: transcript.messages }))
  }
  on('turn.step', async function* ($, e) {
    const stopReason = (options.stop?.reason ?? 'end_turn') as 'end_turn'
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason, usage: options.reply ? options.reply.usage : usage() }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('prompt.submit', ($, e) => {
    entered.push(e.text)
    return { text: e.text }
  })
  // 子 agent：按启动顺序给 ag1、ag2……，模型照 Agent 工具给的，没给就是 Sonnet
  let agents = 0
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: `ag${++agents}` }))
  on('tool.call', () => ({ result: 'ok' as never }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  const fillModes: { text: string; mode: string }[] = []
  on('prompt.fill', ($, e) => {
    if (options.fill?.refuse) return { isFilled: false }
    fills.push(e.text)
    fillModes.push({ text: e.text, mode: e.mode })
    box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return { isFilled: true }
  })
  const forks: string[] = []
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    const answer = options.forks?.shift()
    if (answer === undefined) return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
    if ('throw' in answer) throw new Error(answer.throw)
    if ('isAnswered' in answer) return { value: answer }
    const value: ModelForkResult = {
      isAnswered: true,
      text: 'warm',
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: answer.read, cache_creation_input_tokens: answer.write },
    }
    return { value }
  })
  on('session.id', () => ({ value: SESSION_ID }))
  on('env.get', ($, e) => ({ value: options.env?.[e.name] }))
  const written = new Map<string, string>()
  const writes: string[] = []
  on('fs.write', ($, e) => {
    written.set(slashed(e.path), e.text)
    writes.push(slashed(e.path))
    return { value: undefined }
  })
  // git：引擎把插件给的路径按本机写法规范化（Windows 上是反斜杠），这里统一回正斜杠，取相对 git 目录的部分
  const repo = options.repo ?? { current: NO_REPO }
  const gitRuns: string[][] = []
  const gitDir = () => (repo.current.revParse ?? '').split(/\r?\n/)[1] ?? ''
  const inGitDir = (path: string) => slashed(path).slice(gitDir().length + 1)
  on('session.cwd', () => ({ value: repo.current.cwd }))
  on('process.run', ($, e) => {
    const [, , command] = e.argv
    gitRuns.push([...e.argv])
    const now = repo.current
    if (command === 'rev-parse') return { value: now.revParse === null ? notRepo : ran(now.revParse) }
    if (now.revParse === null) return { value: notRepo }
    if (command === 'status') return { value: ran(now.status) }
    if (command === 'diff') return { value: now.numstat === null ? notRepo : ran(now.numstat) }
    return { value: notRepo }
  })
  on('fs.list', ($, e) => {
    const names = slashed(e.path) === gitDir() ? new Set(Object.keys(repo.current.files ?? {}).map(path => path.split('/')[0] ?? '')) : new Set<string>()
    const entries: FsEntry[] = [...names].map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', ($, e) => {
    // 插件自己写过的文件（状态文件）读得回来
    const own = written.get(slashed(e.path))
    if (own !== undefined) return { value: own }
    const text = repo.current.files?.[inGitDir(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: (repo.current.files ?? {})[inGitDir(e.path)] !== undefined }))
  return { commands, registered, state, entered, fills, fillModes, box, forks, store, rewrite, written, writes, gitRuns }
}

export const anvil = (args: string): CommandRunInput => ({
  command: 'anvil',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
})

// ---------------------------------------------------------------- 主会话的请求和消息

export const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 1000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 500, model: 'claude-opus-5-5', ...over,
})

let steps = 0
/** 一次请求：`agentId` 有值时是子 agent 的 */
export const stepInput = (over: Partial<TurnStepInput> = {}): TurnStepInput => ({
  turnId: `t${++steps}`, index: 0, model: 'claude-opus-5-5', messageCount: 3, ...over,
})

// TurnCompleteInput 按 reason 分支；测试只用回答了的那一支
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
export const turnInput = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: `t${++steps}`, reason: 'answer', usage: usage(), ...over,
})

let spawns = 0
/** Agent 工具启动一个子 agent */
export const spawnInput = (description: string, over: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  prompt: `${description}：详细说明`,
  description,
  subagentType: 'general-purpose',
  tool_use_id: `tu${++spawns}`,
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...over,
})

export const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

/** 读完一次请求的流，拿到它的结果 */
export async function drain<C, R>(stream: HookStream<C, R>): Promise<R> {
  for await (const chunk of stream) void chunk
  return stream.result
}

// ---------------------------------------------------------------- 画面

/** 画出来的一个元素里所有的字，按文档顺序 */
export function flat(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flat).join('')
  if (node !== null && typeof node === 'object') {
    const { children, props } = node as { children?: unknown; props?: { children?: unknown } }
    return flat(children ?? props?.children ?? [])
  }
  return ''
}
