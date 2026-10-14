// anvil 的类型契约：`$.state` 里的值，以及它们用到的类型

export type TranslateBackend = 'haiku' | 'sonnet' | 'api'

/** `/config` 里 anvil 的八项设置（spec D9、anvil-7ds），默认值写在插件清单的 `userConfig` 里 */
export type Settings = {
  /** 每个会话自动打开 anvil 面板；`/anvil panel` 切本会话 */
  showPanel: boolean
  /** 主输入框上方常驻翻译框；`/anvil translate` 切本会话 */
  showTranslate: boolean
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

/** 主会话缓存状态的原样（hooks/cache.ts 的 Cache），时刻都是 `$.clock.now()` 的毫秒 */
export type CacheMemory = {
  /** 最后一次主会话请求的时刻，0 表示本会话还没有 */
  lastRequestAt: number
  /** 过期时刻，0 表示未知（还没有请求）；一般是 lastRequestAt + TTL，恢复会话时可能更早 */
  expiresAt: number
  /** 压缩之后、下一次响应之前：不判过期 */
  compacted: boolean
  /** 上下文输入侧：上一条回复所基于的输入 token（未缓存 + 读 + 写） */
  context: number
  /** 上一条回复的输出 token */
  output: number
  /** 计价用的模型 id */
  model: string | null
  /** 上一条消息（主会话上一轮）的缓存读取量和输入总量 */
  last: { read: number; input: number } | null
  /** 本会话累计的缓存读取量和输入总量 */
  session: { read: number; input: number }
  /** 本会话的冷写：每次重建的 token 数和金额（模型不认识时金额为 null） */
  coldWrites: Array<{ at: number; tokens: number; usd: number | null }>
  /** 本轮已从 turn.step 拿到过回复的读数 */
  steppedThisTurn: boolean
  /** 守卫已拦过一次的那个过期时刻：同一段过期里再提交就放行 */
  ackedFor: number
}

/**
 * 缓存保活自己停下的原因（spec D3）：一段空闲续满 12 小时（limit，灰）、读数不达标（reading，红）、
 * 请求出错（error，红）。停下只结束这一段空闲，下一次主会话请求后清掉。
 */
export type KeepaliveStop = { kind: 'limit' | 'reading' | 'error'; reason: string }

/** 保活循环里热重载后要接上的部分（hooks/keepalive.ts 的 LoopMemory）；定时器和路上的请求随模块丢掉 */
export type KeepaliveMemory = {
  /** 这一段空闲里续期成功的次数 */
  renewals: number
  stopped: KeepaliveStop | null
  /** 这一段空闲里用 `/anvil keepalive` 重新开启的时刻，0 表示没有 */
  restartedAt: number
}

/** 保活循环的读数，缓存框据此和设置、上下文一起定出保活状态 */
/** 一件事从什么时候起、什么时候结束（还在发生时 until 为 null） */
export type ActivitySpan = { since: number; until: number | null }

export type KeepaliveView = {
  /** 这一段空闲里停下了；null 表示没停 */
  stopped: KeepaliveStop | null
  /** 这一段空闲里已经续期过，或续期请求正在路上 */
  renewing: boolean
  /** 续期请求正在路上：缓存框的"进行中"后面接一个转动的图标 */
  inFlight: boolean
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

/** 身份栏（spec D8）：面板最底的一行。目录、git、模型、effort 交还 statusline（2026-10-14） */
export type Identity = {
  /** 本会话主会话请求的合计，身份栏写它的平均；换了对话（`/clear`、`/resume`、`/branch`）从零算 */
  speed: SpeedTally
}

/**
 * 几次请求的速度合计（spec D8）：token/s 按 token 加权，总输出 ÷ 总生成用时；首字取各次的平均。
 * 生成用时是首字到结束，整段一起到的请求退回整次用时（只会偏低），这时 isLowerBound 为 true，数字前标 ≥。
 * 有量得出流速的请求时，output、generationMs 只合计这些请求，下限的不算进 token/s（addTally）
 */
export type SpeedTally = {
  /** 计入的请求次数 */
  requests: number
  /** token/s 计入的请求的输出 token 数（含思考）之和 */
  output: number
  /** token/s 计入的请求的生成用时之和，毫秒 */
  generationMs: number
  /** 首字等待（请求开始到响应的第一块）之和，毫秒 */
  firstTokenMs: number
  /** token/s 计入的请求都用了退路 */
  isLowerBound: boolean
}

/** 一段回复（一轮）的读数，接在原生收尾那行（TurnDuration）后面 */
export type TurnSpeed = {
  /** 这一段各次请求的合计（token/s 用它） */
  tally: SpeedTally
  /** 这一段第一次请求的首字等待，毫秒 */
  firstTokenMs: number
  /** 收尾那行记进对话的时刻（`$.clock.now()`），原生那行的"done HH:MM"按它算 */
  doneAt: number
  /** 这时还在跑的子 agent 数：原生那行这时写成"Waiting for N background agents to finish" */
  waitingAgents: number
}

/** 每段回复的读数 */
export type TurnSpeeds = {
  /** 正在进行的一轮：turnId 和到目前为止的读数；收尾那行记进对话时移进 lines */
  current: { turnId: string; tally: SpeedTally; firstTokenMs: number } | null
  /** 键是收尾那行的 uuid（对话记录里 `turn_duration` 那条，也是 TurnDuration 的 requestId） */
  lines: Record<string, TurnSpeed>
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
       * anvil 面板在本会话被隐藏：`/anvil panel` 隐藏或用户手动关掉面板后为 true，本会话不再自动打开；
       * `/anvil panel` 显示后为 false；和 `/config` 的 showPanel 相同时记 null，按 showPanel（没切换过时读不到值，也按 null）。
       */
      panelHidden: boolean | null
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
      /**
       * 缓存状态原样（hooks/cache.ts 的 Cache），每次变化时写入。只给热重载后的模块接上：
       * 重载换掉模块内存、撤掉定时器，`$.state` 还在（anvil-k0t.49）
       */
      cacheMemory: CacheMemory
      /** 保活循环的续期次数、停下和重新开启的时刻（hooks/keepalive.ts 的 LoopMemory），用处同 cacheMemory */
      keepaliveMemory: KeepaliveMemory
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
      /** 每段回复末尾接的读数 */
      turnSpeeds: TurnSpeeds
      /** 翻译框在本会话被隐藏：`/anvil translate` 切换，隐藏时为 true；和 `/config` 的 showTranslate 相同时（含没切换过）为 null，按 showTranslate */
      translateHidden: boolean | null
      /** 翻译框的状态 */
      translate: TranslateBox
      /**
       * 正在发生的几件事各自的起止（`$.clock.now()` 的毫秒；还在发生时 until 为 null，结束后留着，落定要用）：
       * 主会话回复（这一轮的第一次请求到这一轮结束，子 agent 的不算）、保活续期请求、翻译。动效按它画（spec D10「流光」）
       */
      activity: { reply: ActivitySpan | null; keep: ActivitySpan | null; translate: ActivitySpan | null }
      /** 面板里焦点所在元素的 key（ui.focus 的 element）；面板没有焦点时不看它 */
      focusKey: string | null
      /** 出过错（ui.fault）的 Client 模块文件名，如 `rail.tsx`；之后不再用它，退回静止 */
      clientFaults: string[]
    }
  }
}
