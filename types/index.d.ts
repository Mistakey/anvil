// anvil 的类型契约：`$.state` 里的值，以及它们用到的类型

/** `/config` 里 anvil 的三项设置，默认值写在插件清单的 `userConfig` 里 */
export type Settings = {
  /** 保活与守卫共用的上下文阈值，单位 token */
  threshold: number
  /** 上下文达到阈值的会话自动开启缓存保活 */
  autoKeepalive: boolean
  /** 冷发送守卫 */
  guard: boolean
  /** 输入框上方那一行画哪几段、按什么顺序；空列表时整行不画 */
  band: readonly BandPart[]
}

/** 输入框上方那一行的段：目录名、git、5h、7d、花费 */
export type BandPart = 'dir' | 'git' | '5h' | '7d' | 'cost'

/** 一个额度窗口的读数，取自引擎的 `rateLimits` */
export type RateLimit = {
  /** `five_hour`、`seven_day` 等 */
  kind: string
  /** 0 到 100 */
  percentUsed: number
  /** 重置时刻，ISO 8601 */
  resetsAt?: string
}

/** 输入框上方那一行的用量读数：5h、7d 和花费 */
export type Usage = {
  rateLimits: RateLimit[]
  /** 本会话花费，`/cost` 同源 */
  costUsd: number | null
}

/** 主会话的缓存状态（spec D1、D2），守卫、保活和测试读它；时刻都是 `$.clock.now()` 的毫秒 */
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

/** 保活循环的读数，`/anvil` 列表据此和设置、上下文一起定出保活状态 */
export type KeepaliveView = {
  /** 这一段空闲里停下了；null 表示没停 */
  stopped: KeepaliveStop | null
  /** 这一段空闲里已经续期过，或续期请求正在路上 */
  renewing: boolean
  /** 续期请求正在路上 */
  inFlight: boolean
}

/**
 * 写给 statusline 的保活状态（`~/.claude/anvil/sessions/<session_id>.json`）：statusline 按 stdin 的 session_id 读，
 * 缓存段据此写"keepalive""keepalive failed"。statusline 不归本仓库，字段改了要一起改脚本
 */
export type StatuslineFile = {
  /** 这个会话现在会不会自动续期：保活开着、这一段空闲没停下 */
  renews: boolean
  /** 这一段空闲里续期出错（读数不达标或请求出错）的原因；没出错为 null */
  error: string | null
  /**
   * anvil 估的缓存过期时刻（Unix 毫秒）：最后一次读到缓存（主会话请求或续期）加 1 小时；还没有为 null。
   * 退出再恢复这个会话时 anvil 读回它：引擎给的恢复字段只按最后一次主会话回复算，不知道续期
   */
  expiresAt: number | null
  /** 写下的时刻，Unix 毫秒 */
  at: number
}

/** git 停在一半的命令：rebase、am 带进度 */
export type GitOperation = {
  /** merge、rebase、am、cherry-pick、revert、bisect */
  name: string
  /** 停在第几步、共几步；只有 rebase、am 有 */
  step?: number
  total?: number
}

/** 输入框上方那一行的 git 读数，由 anvil 自己运行 git 取得 */
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

/** 输入框上方那一行的目录与 git */
export type Place = {
  /** 不在 git 里时取会话目录名；还没读到为空串 */
  dir: string
  /** 不在 git 里，或还没读到时为 null */
  git: GitView | null
}

/**
 * 几次请求的速度合计：token/s 按 token 加权，总输出 ÷ 总生成用时。
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

declare module 'claude-code' {
  interface PluginState {
    anvil: {
      /** 输入框上方那一行的 5h、7d 和花费 */
      usage: Usage
      /** 输入框上方那一行的目录与 git */
      place: Place
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
      /** 还在跑的子 agent 的 id：收尾那行这时写成"Waiting for N background agents to finish"，接读数要按它算位置 */
      runningAgents: string[]
      /** 每段回复末尾接的读数 */
      turnSpeeds: TurnSpeeds
    }
  }
}
