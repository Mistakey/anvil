// anvil 的类型契约：`$.state` 里的值，以及它们用到的类型

export type TranslateBackend = 'haiku' | 'sonnet' | 'api'

/** `/config` 里 anvil 的六项设置（spec D9），默认值写在插件清单的 `userConfig` 里 */
export type Settings = {
  /** 保活与守卫共用的上下文阈值，单位 token */
  threshold: number
  /** 上下文达到阈值的会话自动开启缓存保活 */
  autoKeepalive: boolean
  /** 冷发送守卫 */
  guard: boolean
  /** haiku、sonnet 用订阅内的模型；api 用自有的 OpenAI 兼容接口 */
  translateBackend: TranslateBackend
  /** 自有 API 的接口地址；key 读环境变量 ANVIL_TRANSLATE_API_KEY，不进设置 */
  translateApiUrl: string
  /** 自有 API 的模型名 */
  translateApiModel: string
}

/** 一个额度窗口的读数，取自引擎的 `rateLimits` */
export type RateLimit = {
  /** `five_hour`、`seven_day` 等 */
  kind: string
  /** 0 到 100 */
  percentUsed: number
  /** 重置时刻，ISO 8601 */
  resetsAt?: string
}

/** 用量框的读数（spec D8） */
export type Usage = {
  /** 上下文窗口；还没有读数时为 null */
  context: { tokens?: number; window: number; percent?: number } | null
  rateLimits: RateLimit[]
  /** 本会话花费，`/cost` 同源 */
  costUsd: number | null
  /** 主会话已压缩次数 */
  compactions: number
  /** 主会话这一轮开始时的会话花费，一轮结束时用来算上一条消息的花费 */
  costAtTurnStart: number | null
  /** 上一条消息的花费 */
  lastMessageCostUsd: number | null
}

/** 主会话的缓存状态（spec D1、D2），供缓存框显示；时刻都是 `$.clock.now()` 的毫秒 */
export type CacheView = {
  /** 估算的过期时刻：最后一次主会话请求 + 1 小时；本会话还没有请求时为 null */
  expiresAt: number | null
  /** 压缩之后、下一次响应之前：这段时间不判过期，上下文未知 */
  compacted: boolean
  /** 上下文输入侧，单位 token；守卫拿它和阈值比 */
  context: number
  /** 过期后下一条消息要重建的量：上下文输入侧 + 上一条回复的输出，金额按 1 小时写入牌价，模型不认识时为 null */
  rebuild: { tokens: number; usd: number | null }
  /** 缓存命中率 0–1：上一条消息、本会话（只算主会话）；还没有读数时为 null */
  hitRate: { last: number | null; session: number | null }
  /** 本会话整段重建缓存的次数和金额 */
  coldWrites: { count: number; usd: number }
}

/**
 * 缓存保活自己停下的原因（spec D3）：一段空闲续满 12 小时（limit，灰）、读数不达标（reading，红）、
 * 请求出错（error，红）。停下只结束这一段空闲，下一次主会话请求后清掉。
 */
export type KeepaliveStop = { kind: 'limit' | 'reading' | 'error'; reason: string }

/** 保活循环的读数，缓存框据此和设置、上下文一起定出保活状态 */
export type KeepaliveView = {
  /** 这一段空闲里停下了；null 表示没停 */
  stopped: KeepaliveStop | null
  /** 这一段空闲里已经续期过，或续期请求正在路上 */
  renewing: boolean
}

/** 子 agent 的四种状态（spec D8）：运行中、已完成、出错、输出被截断 */
export type AgentStatus = 'running' | 'done' | 'failed' | 'truncated'

/** 子 agent 的一次工具调用，详情里的"最近调用" */
export type AgentCall = {
  tool: string
  /** 命令、路径或模式的摘要，密钥已遮掉 */
  text: string
  isError: boolean
}

/** 子 agent 列表的一项，数据来源照 flightdeck：`agent.spawn` 和带 agentId 的 `turn.step`、`tool.call`、`turn.complete` */
export type SubAgent = {
  /** 引擎给的 agentId */
  id: string
  /** 序号：本会话第几个子 agent，从 1 起 */
  seq: number
  /** Agent 工具的 description，列表里的"任务" */
  description: string
  /** Agent 工具的 prompt，详情里的"任务" */
  prompt: string
  /** 模型 id */
  model: string
  status: AgentStatus
  spawnedAt: number
  /** 结束时刻；运行中为 null */
  endedAt: number | null
  /** 请求次数，详情里的"执行 N 步" */
  steps: number
  /** 最近一次请求的输入侧（含缓存读写），详情里的"上下文" */
  context: number
  /** 各次请求的输出之和 */
  output: number
  /** 最近一次请求的 stopReason；结束时是 max_tokens 就算输出被截断 */
  lastStop: string | null
  /** 最近三次工具调用，旧的在前 */
  calls: AgentCall[]
  /** `turn.complete` 的 answer */
  answer: string
}

/** 自动模式拒绝的来源：主会话，或子 agent 及它的第几步 */
export type DenialSource =
  | { kind: 'main' }
  | {
      kind: 'agent'
      /** 子 agent 列表里的序号；不在列表里（引擎自己的 fork 等）时为 null */
      seq: number | null
      /** Agent 工具的 description；不在列表里时是引擎给的 agent_type，没有就是空 */
      description: string
      /** 拒绝发生在这个子 agent 的第几次请求；还没记到请求时为 null */
      step: number | null
    }

/** 自动模式拒绝列表的一项（spec D8），取自 `classic.PermissionDenied` */
export type Denial = {
  /** tool_use_id */
  id: string
  /** `$.clock.now()` 的毫秒 */
  at: number
  tool: string
  /** 完整内容是什么：命令、路径、网址，其余是工具参数 */
  kind: 'command' | 'path' | 'url' | 'input'
  /** 完整内容，密钥已遮掉 */
  text: string
  source: DenialSource
}

/** 我的消息的一项：主输入框发出、还在对话里的一条用户消息 */
export type MyMessage = {
  /** 对话里这条消息的 id（`session.append` 的 uuid），也是它那一行 UserMessage 的 requestId，滚动按它找 */
  id: string
  /** 消息的文字 */
  text: string
}

/** 我的消息列表（spec D8） */
export type MyMessages = {
  /** 旧的在前 */
  items: MyMessage[]
  /** 存满后丢掉的条数：序号从 dropped + 1 起 */
  dropped: number
  /**
   * 前几条在上一次压缩之前：压缩后对话里只剩摘要，读不到它们，不再拿对话核对，原样保留；
   * 之后的每条都要还在对话里，撤回、回退掉的从列表去掉。
   */
  settled: number
}

/** 最近一次让对话滚到我的消息里某一条的请求 */
export type Scrolled = {
  /** 消息 id */
  id: string
  /** 引擎拒绝的原因；滚过去了为 null */
  deny: string | null
}

/** 面板上的三个列表 */
export type ListId = 'messages' | 'denials' | 'agents'

/** 面板的展开状态（spec D8、D9）；Esc 把焦点交回主输入框时回到全收起 */
export type PanelFold = {
  /** 展开的列表，其余收成一行；null 时都按上限显示 */
  expanded: ListId | null
  /** 展开详情的那一项：子 agent 的 id，或自动模式拒绝的 `denial:` 加 tool_use_id；同时只展开一项 */
  detail: string | null
  /** 展开的列表往上滚过的条数：0 时最新的一条在最下面 */
  scrolled: number
}

/** git 停在一半的命令（spec D8）：rebase、am 带进度 */
export type GitOperation = {
  /** merge、rebase、am、cherry-pick、revert、bisect */
  name: string
  /** 停在第几步、共几步；只有 rebase、am 有 */
  step?: number
  total?: number
}

/** 身份栏第一行的 git 读数（spec D8），由 anvil 自己运行 git 取得 */
export type GitView = {
  /** 主仓库的目录名 */
  repo: string
  /** 在 linked worktree 中时，worktree 的目录名；否则 null */
  worktree: string | null
  /** 会话目录在仓库里的相对路径，如 `hooks`；在仓库根上为空串 */
  sub: string
  /** 分支名；分离 HEAD 时为 null，看 commit */
  branch: string | null
  /** 分离 HEAD 时的提交号（7 位）；还没有提交时为 null */
  commit: string | null
  /** 当前分支没有上游；分离 HEAD 和 rebase 中不判断，为 false */
  noUpstream: boolean
  ahead: number
  behind: number
  conflicts: number
  staged: number
  modified: number
  untracked: number
  stashes: number
  /** 未提交改动的行数：工作区和暂存区相对 HEAD；取不到时为 null */
  lines: { added: number; deleted: number } | null
  operation: GitOperation | null
}

/** 身份栏（spec D8）：面板最底的两行 */
export type Identity = {
  /** 不在 git 里时取会话目录名 */
  dir: string
  /** 不在 git 里，或还没读到时为 null */
  git: GitView | null
  /** 主会话最近一次请求的模型 id；还没有请求时取会话的模型 */
  model: string | null
  /** 主会话最近一次请求的 effort；还没有请求时取会话设置里的，模型不支持或设置里没有时为 null */
  effort: string | number | null
  /** 主会话最近一次请求的输出速度：输出 token 数 ÷ 首字到结束的秒数 */
  tokensPerSecond: number | null
}

/** 翻译框的四种显示状态（spec D5）：示例和按键提示、正在翻译、已追加 N 个词、失败原因 */
export type TranslatePhase = 'idle' | 'working' | 'done' | 'failed'

/** 翻译框的状态 */
export type TranslateBox = {
  phase: TranslatePhase
  /** 最近一次送去翻译的中文 */
  text: string
  /** 已追加的英文词数（done） */
  words: number
  /** 失败原因（failed） */
  reason: string
  /**
   * 输入框的第几代：翻译失败时换一代，好把引擎提交时清掉的中文画回去。
   * Input 的值只能换 key 重建来重设（AGENTS.md Pitfalls）。
   */
  field: number
  /** 新一代输入框起始的文字：失败时画回的中文；送去翻译时清掉，框重建时不再画回 */
  seed: string
  /**
   * 输入框里没有字。只有空框画按键提示、提示才放在输入框右侧；有字时输入框独占一行，
   * 引擎才把长句折行（anvil-k0t.30 实测）
   */
  empty: boolean
}

declare module 'claude-code' {
  interface PluginState {
    anvil: {
      /**
       * anvil 面板在本会话被隐藏：`/anvil panel` 隐藏或用户手动关掉面板后为 true，
       * 本会话不再自动打开，再敲 `/anvil panel` 改回 false。
       */
      panelHidden: boolean
      /** 用量框的读数 */
      usage: Usage
      /**
       * 本次加载生效的设置，会话开始（含每次重新加载模块）时写入。
       * 功能模块用 register 传进来的 settings；这份给拿不到 options 的读者（测试）核对。
       * `/clear`、`/resume`、`/branch` 会清掉它，直到下一次加载。
       */
      settings: Settings
      /** 缓存状态，每次变化时写入；`/clear` 后清零重写 */
      cache: CacheView
      /**
       * 本会话用 `/anvil keepalive` 切换过的保活开关：true 开、false 关，不看自动开启和阈值；
       * 没切换过（读不到值，按 null）时按默认（自动开启且上下文达到阈值）。
       * 放在 `$.state` 里，新会话（含 `/clear`、`/resume`）随引擎重置回到默认。
       */
      keepaliveOverride: boolean | null
      /** 保活循环的读数 */
      keepalive: KeepaliveView
      /** 子 agent 列表，按序号从旧到新 */
      agents: SubAgent[]
      /** 自动模式拒绝列表，旧的在前 */
      denials: Denial[]
      /** 我的消息列表 */
      messages: MyMessages
      /**
       * 最近一次在我的消息里按 Enter 的滚动请求和结果。功能本身不读它；
       * 给测试核对（plugin test 里引擎没有 ui.scroll 的实现，测试的钩子接不到插件的这次调用）。
       */
      scrolled: Scrolled | null
      /** 面板的展开状态 */
      fold: PanelFold
      /** 身份栏 */
      identity: Identity
      /** 翻译框在本会话被隐藏：`/anvil translate` 切换，隐藏时为 true */
      translateHidden: boolean
      /** 翻译框的状态 */
      translate: TranslateBox
    }
  }
}
