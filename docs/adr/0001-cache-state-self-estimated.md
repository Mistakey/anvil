# 缓存状态只靠 anvil 自己估算，TTL 固定 1 小时

> Source: anvil-k0t (D1)

Claude Code 自己的缓存追踪器（精确过期时刻、本次写入的 TTL、内置 keepalive 的续期）只在 statusline 的 stdin 里，mod 拿不到；留一个"数据泵" statusline 把它写成文件给 anvil 读是可行的，但 statusline 已决定并入 anvil 面板、整个取消。所以 anvil 按"最后一次主会话请求 + 1 小时"估算过期，恢复会话时用引擎给的 `prompt_cache_likely_expired` 起步；TTL 一律按 1 小时，不探测 5 分钟（用户只在订阅套餐内用）。代价是看不到别人的 fork 和内置 keepalive 的续期，估算偏保守（守卫偶尔误报、多发一次保活请求）；超额或用 API key 时实际 TTL 是 5 分钟，过期时刻会估晚。

**2026-10-14**：statusline 已恢复，显示用的缓存过期时刻改由 statusline 给出真实值；anvil 的估算只供保活和冷发送守卫使用。
