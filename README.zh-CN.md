# anvil

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code 2.1.296+](https://img.shields.io/badge/Claude%20Code-2.1.296%2B%20mod-d97757.svg)](https://docs.claude.com/en/docs/claude-code)

[English](README.md) | 简体中文

**一个让长会话更省的 Claude Code mod。** 离开时让 prompt 缓存不过期；缓存已经冷了时，拦下那条会整段重建缓存的消息；在主输入框上方画一行：你在哪、套餐额度还剩多少。

<p align="center">
  <a href="#安装">安装</a> · <a href="#功能">功能</a> · <a href="#上手教程">上手教程</a> · <a href="#设置">设置</a> · <a href="#常见问题">常见问题</a> · <a href="#开发">开发</a>
</p>

## 功能

- **缓存保活**：上下文较大的会话空闲时，anvil 在 prompt 缓存快过期前发一个后台请求，读一遍缓存，不进对话记录，你回来发的下一条消息就不用为整段重建付钱。每段空闲最多续 12 小时。
- **冷发送守卫**：缓存已经过期、上下文又大时，anvil 把你的下一条消息拦下一次，告诉你发出去要重建多少（token 数和按 API 牌价估的金额）。再按一次 Enter 就发出；不需要这段上下文时用 `/clear` 重新开始。
- **主输入框上方一行**：目录名 · git · 5 小时用量 · 7 天用量 · 本会话花费。git 写分支和领先落后、停在一半的 merge 或 rebase、冲突、已暂存、已修改、未跟踪、储藏和未提交的行数；两个用量窗口各有 10 格热度进度条、百分比和重置时刻。
- **每段回复的速度**：输出 token/s 和首字等待（TTFT）接在 Claude Code 原生的「Worked for …」那行后面。

模型、effort、上下文和缓存的真实过期时刻归主输入框下方那一行，也就是你自己的 [statusline](#主输入框下方那一行)。anvil 把保活状态写进一个小文件，供 statusline 读。

## 前提条件

- **Claude Code 2.1.296 或更新**（在 2.1.299 上测试）。mod 是 Claude Code 的早期功能，接口在版本之间可能变化。
- **终端字体是 [Nerd Font](https://www.nerdfonts.com/)**，图标才画得出来。
- **Claude 订阅**（Pro 或 Max）：保活按订阅下主会话 1 小时的缓存 TTL 设计，只在订阅套餐内成立。

## 安装

在 Claude Code 里：

```
/plugin install anvil --marketplace Mistakey/anvil
/reload-plugins
```

<details>
<summary><strong>分步安装、从终端安装，或从克隆加载</strong></summary>

先添加市场，再从中安装：

```
/plugin marketplace add Mistakey/anvil
/plugin install anvil@anvil
```

从终端：

```sh
claude plugin marketplace add Mistakey/anvil
claude plugin install anvil@anvil
```

或者从克隆直接加载，只对这一次会话生效：

```sh
git clone https://github.com/Mistakey/anvil
claude --plugin-dir ./anvil
```

</details>

安装时可能提示有设置项没填，用默认值即可，之后在 [`/config`](#设置) 里改。

## 上手教程

### 1. 看主输入框上方那一行

| 部分 | 显示 |
| --- | --- |
| 目录名 | 仓库名（加粗）、linked worktree 名、所在的子目录；不在 git 里时是会话目录名 |
| git | 分支、`↑` 领先 `↓` 落后、`no upstream`（无上游）、停在一半的 `merge` 或 `rebase 2/5`、`=` 冲突、`+` 已暂存、`!` 已修改、`?` 未跟踪、储藏、未提交的 `+行 −行` |
| 5h、7d | 10 格热度进度条、已用百分比、重置时刻（当天写 `22:00`，不是当天写 `09:00 10-15`）；窗口还没开始时写 `—` |
| 花费 | Claude Code 报的本会话花费（`/cost` 同源） |

每段回复结束、改文件或跑命令的工具调用之后、你发消息时都重新读一遍 git。会话开始时用量读数要过几秒才到，在那之前先画本机各会话最近一次读到的。终端窄时依次让出：先把名字截短，再去掉进度条，git 只留分支，再去掉花费和 git；重置时刻一直留着。

### 2. 命令

| 命令 | 作用 |
| --- | --- |
| `/anvil` | 列出子命令和它们现在的状态 |
| `/anvil keepalive` | 在本会话关掉或开启保活，不看阈值 |

新会话从你在 `/config` 里定的默认值开始。

### 保活怎么工作

- 缓存的过期时刻由 anvil 自己估算：最后一次主会话请求的时刻加 1 小时。
- 上下文达到阈值（默认 5 万 token）的会话空闲时，anvil 等 50 分钟，发一个要求只回一个词的后台请求（`$.model.fork`），不进对话记录。
- 每次请求都检查自己的读数：读到的量接近整段上下文、写入很少，就算续上，再定下一次；否则保活停下：没读到缓存、写入过多、请求出错，或空闲满 12 小时。`/anvil` 里写明原因。
- 停下只结束这一段空闲：你发了消息之后，下一段空闲照常保活。
- 每次请求约等于读一遍整段上下文再加几个输出 token，计入你的套餐额度。Claude Code 要一直开着。
- 退出 Claude Code 后保活就停了。再恢复这个会话（`claude --resume`、`/resume`）时，anvil 按自己记下的过期时刻起步，算上退出前保活续的期；Claude Code 给的恢复信息只按最后一次回复算，会把续过期的缓存当成已过期。

### 守卫怎么工作

- 缓存已过期、上下文达到阈值时，anvil 把你的下一条消息拦下一次、放回主输入框，提示一行，如：*anvil: the cache expired 1h10m ago; sending this message rebuilds 152k tokens (~$3.04). …*（缓存已过期 1h10m，发送这条消息要重建 152k tokens，约 $3.04）
- 再按一次 Enter 就发出；不需要旧的上下文时用 `/clear`。
- 斜杠命令和插件发起的消息直接放行；刚压缩完、刚 `/clear` 后不拦。

### 主输入框下方那一行

statusline 是你自己的脚本（设置里的 [`statusLine`](https://docs.claude.com/en/docs/claude-code/statusline)），Claude Code 交给它模型、effort、上下文和缓存的真实状态（`prompt_cache` 的 `hit_ratio`、`warm`、`expires_at`）。它不知道的是 anvil 会不会续期，所以 anvil 给每个会话写一份：

```
~/.claude/anvil/sessions/<session_id>.json        # 设了 CLAUDE_CONFIG_DIR 时在它下面
{ "renews": true, "error": null, "expiresAt": 1791998610193, "at": 1791995010193 }
```

`session_id` 就是 statusline 输入里的那个。保活开着、没停下时 `renews` 为 true；续期失败停下时 `error` 是原因（空闲满 12 小时不算出错）；`expiresAt` 是 anvil 估的过期时刻（Unix 毫秒，算上续期），恢复会话时 anvil 自己读回它。anvil 只写不删，愿意的话在脚本里顺手清掉一周以前的。有了它，缓存段可以写成 `󰆼 94% · 有效 · 自动续期`、`󰆼 94% · 有效至 21:40` 或 `󰆼 94% · 21:40 已失效`，再按状态上色：会续的绿、只到某个时刻的黄、已失效的红。

## 设置

运行 `/config`，打开 anvil 的设置项：

| 设置项 | 默认值 | 含义 |
| --- | --- | --- |
| `threshold` | `50000` | 上下文阈值（token）：达到它的会话自动开启保活，守卫也只拦这类会话 |
| `autoKeepalive` | `true` | 上下文达到阈值的会话自动开启保活；`/anvil keepalive` 仍可按会话切换 |
| `guard` | `true` | 缓存过期后拦下第一条消息 |

## 它碰什么

| 做什么 | 通过 |
| --- | --- |
| 读会话事件：请求和用量、子 agent 的开始和结束、工具调用、你发的消息 | mod 钩子 |
| 发保活请求 | `$.model.fork`，只在会话空闲时 |
| 在会话目录里只读地运行 `git`（`--no-optional-locks`） | `$.process.run` |
| 记下最近的 5h、7d 读数，本机各会话共用 | `$.store` |
| 给 statusline 写保活状态 | `~/.claude/anvil/sessions/` |

除了保活请求，没有东西离开你的电脑。`claude plugin validate .` 会列出 mod 挂的每个钩子和每个调用。

## 常见问题

**主输入框上方那一行没有出现。**
Claude Code 在那里画问卷时它会让出来，`ctrl+x ctrl+a` 也会把它收起。还是没有的话，在对话里找 Claude Code 写的、指出 anvil 哪个钩子出错的那一行，带上它[提一个 issue](https://github.com/Mistakey/anvil/issues)。

**图标显示成方框或问号。**
终端字体不是 Nerd Font。装一个，并在终端设置里选上它。

**缓存状态和 Claude Code 自己追踪的一致吗？**
保活和守卫按 anvil 自己的估算行动：mod 读不到 Claude Code 自己的缓存追踪，anvil 按请求时刻和用量推算。anvil 看不到的请求（别的插件的 fork、Claude Code 内置的保活）会让估算偏保守：最坏是守卫多提醒一次，或保活多发一次请求。statusline 拿到的是 Claude Code 的真实读数。

**用 API key、或者缓存是 5 分钟时能用吗？**
上方那一行可以（没有订阅时 5h、7d 一直是 `—`）。保活和守卫按订阅的 1 小时 TTL 设计。

**我是订阅用户，为什么守卫里的金额按 API 牌价算？**
缓存读写怎么折算进订阅额度没有文档，API 牌价是唯一可比的尺度。上方那一行的花费直接取 Claude Code 报的数（`/cost`）。

**我的组织统一管理 Claude Code。**
在托管设置下，Claude Code 不把 `classic.SessionStart`、`session.compact` 交给用户自己安装的插件。这时缓存估算接不上恢复的会话和压缩，除非组织在托管设置里列出 anvil。

## 开发

仓库本身就是插件：`.claude-plugin/plugin.json` 是清单，`hooks/register.ts` 是入口。Claude Code 直接加载 TypeScript，没有构建步骤。

```sh
claude --plugin-dir .              # 加载；保存文件即热重载
claude plugin validate .           # 列出钩子、调用，以及 Claude Code 会拒绝的内容
claude plugin test .               # 跑 tests/*.test.ts
npx -p typescript tsc -p .         # 类型检查
```

当前 Claude Code 构建的类型声明在插件第一次于交互会话中加载时生成到 `.claude-plugin/types/`。不开交互会话时用 `CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --plugin-dir . -p "ok" --model haiku --max-turns 1` 生成。

[`CONTEXT.md`](CONTEXT.md) 定义术语，[`AGENTS.md`](AGENTS.md) 收录开发约定和 mods 接口的已知坑，[`docs/adr/`](docs/adr) 记录设计决定。

## 致谢

- Stephen Casella 的 [Flightdeck](https://github.com/scasella/claude-flightdeck)：模块结构，读状态时合并到默认值上的写法。
- Karan Bansal 的 [cache-tax](https://github.com/karanb192/cache-tax)：缓存估算、保活循环和冷发送守卫。

两者都是 MIT 许可。[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 列出 anvil 从各自借用了什么，并附许可原文。

## 许可

[MIT](LICENSE)
