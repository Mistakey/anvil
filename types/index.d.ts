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
    }
  }
}
