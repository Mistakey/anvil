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

declare module 'claude-code' {
  interface PluginState {
    anvil: {
      /**
       * 本次加载生效的设置，会话开始（含每次重新加载模块）时写入。
       * 功能模块用 register 传进来的 settings；这份给拿不到 options 的读者（测试）核对。
       * `/clear`、`/resume`、`/branch` 会清掉它，直到下一次加载。
       */
      settings: Settings
    }
  }
}
