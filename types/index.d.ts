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

declare module 'claude-code' {
  interface PluginState {
    anvil: {
      /**
       * 本次加载生效的设置，会话开始（含每次重新加载模块）时写入。
       * 功能模块用 register 传进来的 settings；这份给拿不到 options 的读者（测试）核对。
       * `/clear`、`/resume`、`/branch` 会清掉它，直到下一次加载。
       */
      settings: Settings
      /** 缓存状态，每次变化时写入；`/clear` 后清零重写 */
      cache: CacheView
    }
  }
}
