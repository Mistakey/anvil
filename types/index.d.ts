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

/** 面板上的三个列表 */
export type ListId = 'messages' | 'denials' | 'agents'

/** 面板的展开状态（spec D8、D9）；Esc 把焦点交回主输入框时回到全收起 */
export type PanelFold = {
  /** 展开的列表，其余收成一行；null 时都按上限显示 */
  expanded: ListId | null
  /** 展开详情的子 agent id */
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
  /** 主会话最近一次请求的 effort；模型不支持或还没有请求时为 null */
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
   * 输入框的第几代：开始写下一句时换一代。Input 没有清空的办法，
   * 只能换 key 重建（AGENTS.md Pitfalls）。
   */
  field: number
  /** 新一代输入框起始的文字：开始写下一句时已经敲下的字 */
  seed: string
}

declare module 'claude-code' {
  interface PluginState {
    anvil: {
      /**
       * anvil 面板在本会话被隐藏：`/anvil panel hide` 或用户手动关掉面板后为 true，
       * 本会话不再自动打开，`/anvil panel show` 改回 false。
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
       * 缓存保活在本会话被关闭：`/anvil keepalive off` 后为 true，`on` 改回 false。
       * 放在 `$.state` 里，新会话（含 `/clear`、`/resume`）随引擎重置回到默认。
       */
      keepaliveOff: boolean
      /** 保活循环的读数 */
      keepalive: KeepaliveView
      /** 子 agent 列表，按序号从旧到新 */
      agents: SubAgent[]
      /** 面板的展开状态 */
      fold: PanelFold
      /** 身份栏 */
      identity: Identity
      /** 翻译框在本会话被隐藏：`/anvil translate hide` 后为 true，`show` 改回 false */
      translateHidden: boolean
      /** 翻译框的状态 */
      translate: TranslateBox
    }
  }
}
