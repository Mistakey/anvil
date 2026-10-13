import type {
  AgentSpawnInput,
  CommandRunInput,
  HookStream,
  ModelForkResult,
  On,
  PaneOpenArgs,
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
}

/** 一次 fork 的回答：读写数（回复正常），整份结果，或抛错 */
export type ForkAnswer = { read: number; write: number } | ModelForkResult | { throw: string }

/** 读到整段缓存、只写了自己那一条：续上了 */
export const WARM: ForkAnswer = { read: 150000, write: 40 }

// 插件之下的世界：替引擎回答插件用到的调用，并记下插件注册的命令、写进 `$.state` 的值、
// 进入会话的消息和放回主输入框的文本
export function world(on: On, options: WorldOptions = {}) {
  const commands: string[] = []
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
    return { value: { command: e.name } }
  })
  // 测试拿到的 `$` 没有 state 这个名词，只能在插件之下看它写了什么，再交给测试工具自带的 state
  on('state.set', ($, e, next) => {
    state.set(`${e.plugin}.${e.key}`, e.value)
    return next(e)
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
  return { commands, state, entered, fills, fillModes, box, forks, store }
}

/**
 * 替引擎管面板：记下每次 `$.ui.open` 和 `$.ui.close`。
 * `placed` 是引擎这时肯不肯把面板放下（终端够不够宽），测试中途可以改。
 */
export function panes(on: On) {
  const opens: PaneOpenArgs[] = []
  const closes: string[] = []
  const shown = new Map<string, boolean>()
  const screen = { placed: true }
  on('ui.open', ($, e) => {
    opens.push(e)
    shown.set(e.id, screen.placed)
    return { value: screen.placed ? { isPlaced: true } : { isPlaced: false, reason: '终端 120 列，不到 144 列' } }
  })
  on('ui.close', ($, e) => {
    closes.push(e.id)
    shown.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...shown].map(([id, isPlaced]) => ({ id, title: id, isShown: isPlaced, isFocused: false, isPlaced })),
  }))
  return { opens, closes, screen }
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

// ---------------------------------------------------------------- 面板

/** 面板的一次绘制：是否有焦点、能放几行 */
export const pane = (isFocused: boolean, bodyRows = 48) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: {
    title: 'anvil',
    isFocused,
    bodyColumns: 70,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

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
