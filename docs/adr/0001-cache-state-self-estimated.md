# 缓存状态只靠 anvil 自己估算，TTL 固定 1 小时

> Source: anvil-k0t (D1)

Claude Code 自己的缓存追踪器（精确过期时刻、本次写入的 TTL、内置 keepalive 的续期）只在 statusline 的 stdin 里，mod 拿不到；留一个"数据泵" statusline 把它写成文件给 anvil 读是可行的，但 statusline 已决定并入 anvil 面板、整个取消。所以 anvil 按"最后一次主会话请求 + 1 小时"估算过期，恢复会话时用引擎给的 `prompt_cache_likely_expired` 起步；TTL 一律按 1 小时，不探测 5 分钟（用户只在订阅套餐内用）。代价是看不到别人的 fork 和内置 keepalive 的续期，估算偏保守（守卫偶尔误报、多发一次保活请求）；超额或用 API key 时实际 TTL 是 5 分钟，过期时刻会估晚。

**2026-10-14**：statusline 已恢复，显示用的缓存过期时刻改由 statusline 给出真实值；anvil 的估算只供保活和冷发送守卫使用。

**2026-10-15**：方向倒过来接上了：不是 statusline 写文件给 anvil，而是 anvil 把"会不会自动续期、续期出没出错"写进 `~/.claude/anvil/sessions/<session_id>.json`，statusline 按 stdin 的 `session_id` 读，缓存段据此写"warm · keepalive"。anvil 自己仍只用估算。

**2026-10-15**：恢复会话不再只靠引擎的 `prompt_cache_likely_expired`：它只按最后一次主会话回复算，不知道保活续的期，用户退出前续过期的会话恢复后被守卫误拦。anvil 把自己的估算（`expiresAt`）也写进同一个文件，恢复时比引擎的晚就照它；引擎判定已过期、离最后一次回复又不到 1 小时（TTL 更短）时仍听引擎的。
