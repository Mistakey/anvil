import type {
  AgentSpawnInput,
  CommandRunInput,
  HookStream,
  On,
  PaneOpenArgs,
  PromptSubmitInput,
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
  /** 下一次请求的回复带的 usage，测试中途可改；null 表示没有回复 */
  reply?: { usage: TurnUsage | null }
  /** `$.session.usage()` 的整份读数（用量框用），测试中途可改；给了它就不看 `live` */
  reading?: { current: SessionUsage }
  /** 下一次请求停在哪（`turn.step` 结果的 stopReason），测试中途可改；默认 end_turn */
  stop?: { reason: string }
}

// 插件之下的世界：替引擎回答插件用到的调用，并记下插件注册的命令、写进 `$.state` 的值、
// 进入会话的消息和放回主输入框的文本
export function world(on: On, options: WorldOptions = {}) {
  const commands: string[] = []
  const state = new Map<string, unknown>()
  const entered: string[] = []
  const fills: string[] = []
  const box = options.box ?? { text: '' }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return { isFilled: true }
  })
  return { commands, state, entered, fills, box }
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
