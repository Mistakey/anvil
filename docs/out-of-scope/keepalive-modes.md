# 不做 always 保活和"冷写后自动开 3 小时"

**决定**：缓存保活只有一种开法：`/config` 的自动开启决定默认（上下文达到阈值的会话自动开），`/anvil keepalive` 切换本会话。不做 cache-tax 的 always，也不做缓存冷写之后自动开 3 小时。

**出处**（v1 spec，`git show d21c521:docs/specs/anvil-k0t/spec.md`）：

- §1 非目标：「cache-tax 的 always 和"冷写后自动开 3 小时"」。
- D3：「不做 always，也不做"冷写后自动开 3 小时"」；自动开启加本会话切换的两层分工由用户 2026-10-13 定。
