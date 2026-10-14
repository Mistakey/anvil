# anvil

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code 2.1.296+](https://img.shields.io/badge/Claude%20Code-2.1.296%2B%20mod-d97757.svg)](https://docs.claude.com/en/docs/claude-code)
[![全屏终端](https://img.shields.io/badge/terminal-fullscreen%20%C2%B7%20110%2B%20cols-555.svg)](#前提条件)
[![界面：中文](https://img.shields.io/badge/UI-%E4%B8%AD%E6%96%87-c0392b.svg)](#语言)

[English](README.md) | 简体中文

**一个让长会话更省、更好看的 Claude Code mod。** 离开时让 prompt 缓存不过期；缓存已经冷了时，拦下那条会整段重建缓存的消息；在对话右侧停靠一个面板，放下原来 statusline 上的全部信息和更多内容；再给你一个输入框，写中文、发英文。

<p align="center">
  <img src="docs/media/session.png" alt="全屏的 Claude Code，右侧停靠着 anvil 面板：缓存、用量、一个已完成的子 agent、用户发的消息和身份栏；左边是 Claude 的英文回复，主输入框上方是中→英翻译框" width="900">
</p>

<p align="center">
  <a href="#安装">安装</a> · <a href="#功能">功能</a> · <a href="#上手教程">上手教程</a> · <a href="#设置">设置</a> · <a href="#常见问题">常见问题</a> · <a href="#开发">开发</a>
</p>

## 功能

- **缓存保活**：上下文较大的会话空闲时，anvil 在 prompt 缓存快过期前发一个后台请求，读一遍缓存，不进对话记录，你回来发的下一条消息就不用为整段重建付钱。每段空闲最多续 12 小时。
- **冷发送守卫**：缓存已经过期、上下文又大时，anvil 把你的下一条消息拦下一次，告诉你发出去要重建多少（token 数和按 API 牌价估的金额）。再按一次 Enter 就发出；不需要这段上下文时用 `/clear` 重新开始。
- **停靠面板**：自上而下是缓存（命中率、过期时刻、保活）、用量（5 小时和 7 天额度的重置时刻与预测、上下文、本会话花费）、子 agent、自动模式拒绝、我的消息（在一条上按 Enter，对话滚到这条消息），最下面三行身份栏（目录和 git 状态、模型和 effort、平均输出速度和首字等待）。每段回复自己的速度接在 Claude Code 原生的「Worked for …」那行后面。
- **中→英翻译框**：主输入框上方的第二个输入框：写中文、按 Enter，英文译文追加到主输入框，由你检查后发送。翻译用订阅内的 Haiku 或 Sonnet，也可以接任意 OpenAI 兼容的 API。

| 面板 | 翻译框 |
| --- | --- |
| <img src="docs/media/panel.png" alt="anvil 面板：缓存命中率 93%、有效至 18:17，上下文不到 50k、保活未启用；5h 和 7d 的用量条、重置时刻和预测；上下文 45k / 1M；花费 $0.01；一个已完成的子 agent；一条消息；身份栏" width="320"> | <img src="docs/media/translate.png" alt="一句中文翻译完之后的翻译框：显示已追加 21 个词，英文译文在主输入框里等着发送" width="520"><br><br>译文进的是主输入框；你在那里按 Enter 之前，什么都不会发出去。 |

## 前提条件

- **Claude Code 2.1.296 或更新**（在 2.1.299 上测试）。mod 是 Claude Code 的早期功能，接口在版本之间可能变化。
- **全屏渲染**：运行 `/tui fullscreen`，或设环境变量 `CLAUDE_CODE_NO_FLICKER=1`。面板只在全屏下停靠。
- **终端至少 110 列**：144 列起会话开始时面板自己打开；110 到 144 列之间在你发第一条消息时打开；不到 110 列时 Claude Code 把它放成主输入框上方的内联面板。
- **终端字体是 [Nerd Font](https://www.nerdfonts.com/)**，图标才画得出来。
- **Claude 订阅**（Pro 或 Max）：保活按订阅下主会话 1 小时的缓存 TTL 设计，只在订阅套餐内成立。

### 语言

界面目前只有中文，其他语言在计划中。

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

### 1. 开一个会话

在足够宽的终端里以全屏启动 Claude Code。面板停靠在右侧，翻译框出现在主输入框上方。拖面板的左边界可以改宽度，Claude Code 会记住。

### 2. 看懂面板

| 区块 | 显示 |
| --- | --- |
| **缓存** | 本会话的缓存命中率；缓存是否有效、几点过期，或已过期多久；保活状态 |
| **用量** | 5 小时和 7 天的用量、重置时刻、按现在的速度预计用完的时刻；上下文用了多少；本会话花费 |
| **子 agent** | 本会话有了子 agent 才出现：状态、任务、模型、耗时 |
| **自动模式拒绝** | 自动模式的分类器拒绝过才出现：时刻、工具、命令或路径（密钥已遮掉） |
| **我的消息** | 本会话发过的消息，旧的在上 |
| 身份栏 | 目录、分支、领先落后、冲突、已暂存、已修改、未跟踪、储藏、未提交的改动行数、停在一半的 merge 或 rebase；模型和 effort；平均输出速度（token/s）和首字等待 |

### 3. 用按键

点击面板，或按 `ctrl+x tab`（翻译框显示着时按两次：焦点按 主输入框 → 翻译框 → 面板 轮转）。之后：

| 按键 | 作用 |
| --- | --- |
| `1`–`9` | 展开对应的子 agent：任务、执行情况、最近的调用、回答 |
| `a` / `d` / `m` | 展开子 agent、自动模式拒绝、我的消息列表 |
| `↑` `↓` | 在列表标题和各条之间移动 |
| `Enter` | 按下焦点所在的一项：展开列表、打开子 agent 或拒绝的详情、让对话滚到那条消息 |
| `Esc` | 收起，回到主输入框 |

### 4. 翻译

点击翻译框或按 `ctrl+x tab`，写中文，按 Enter。英文另起一行追加到主输入框末尾，在主输入框里检查、修改、发送。`Shift+Enter` 换行，中文输入法照常可用。中文里夹的代码、路径和英文术语原样保留。

### 5. 命令

子命令都是切换，只作用于当前会话；新会话回到默认。

| 命令 | 作用 |
| --- | --- |
| `/anvil` | 列出子命令和它们现在的状态 |
| `/anvil panel` | 隐藏或显示面板 |
| `/anvil translate` | 隐藏或显示翻译框 |
| `/anvil keepalive` | 在本会话关掉或开启保活，不看阈值 |

手动关掉面板等同隐藏：本会话不再自动打开，直到你敲 `/anvil panel`。

### 保活怎么工作

- 缓存的过期时刻由 anvil 自己估算：最后一次主会话请求的时刻加 1 小时。
- 上下文达到阈值（默认 5 万 token）的会话空闲时，anvil 等 50 分钟，发一个要求只回一个词的后台请求（`$.model.fork`），不进对话记录。
- 每次请求都检查自己的读数：读到的量接近整段上下文、写入很少，就算续上，再定下一次；否则保活停下，缓存框里写明原因：没读到缓存、写入过多、请求出错，或空闲满 12 小时。
- 停下只结束这一段空闲：你发了消息之后，下一段空闲照常保活。
- 每次请求约等于读一遍整段上下文再加几个输出 token，计入你的套餐额度。Claude Code 要一直开着。

### 守卫怎么工作

- 缓存已过期、上下文达到阈值时，anvil 把你的下一条消息拦下一次、放回主输入框，提示一行，如：*anvil：缓存已过期 1h10m，发送这条消息要重建 152k tokens（约 $3.04）……*
- 再按一次 Enter 就发出；不需要旧的上下文时用 `/clear`。
- 斜杠命令和插件发起的消息直接放行；刚压缩完、刚 `/clear` 后不拦。

## 设置

运行 `/config`，打开 anvil 的设置项：

| 设置项 | 默认值 | 含义 |
| --- | --- | --- |
| `threshold` | `50000` | 上下文阈值（token）：达到它的会话自动开启保活，守卫也只拦这类会话 |
| `autoKeepalive` | `true` | 上下文达到阈值的会话自动开启保活；`/anvil keepalive` 仍可按会话切换 |
| `guard` | `true` | 缓存过期后拦下第一条消息 |
| `translateBackend` | `haiku` | `haiku`、`sonnet` 用订阅内的模型；`api` 用你自己的 OpenAI 兼容接口 |
| `translateApiUrl` | | 接口地址：base URL（`…/v1`）或完整的 `…/chat/completions`，后端选 `api` 时用 |
| `translateApiModel` | | 请求的模型名，后端选 `api` 时用 |

API key 读环境变量 `ANVIL_TRANSLATE_API_KEY`，不写进设置。

## 它碰什么

| 做什么 | 通过 |
| --- | --- |
| 读会话事件：请求和用量、子 agent、工具调用、自动模式拒绝、你发的消息 | mod 钩子 |
| 发保活请求 | `$.model.fork`，只在会话空闲时 |
| 翻译 | `$.model.complete` 调 Haiku 或 Sonnet，或向你配置的 API 发 HTTPS 请求 |
| 在会话目录里只读地运行 `git`（`--no-optional-locks`） | `$.process.run` |
| 记下最近的用量读数供预测，本机各会话共用 | `$.store` |

除此之外没有东西离开你的电脑。`claude plugin validate .` 会列出 mod 挂的每个钩子和每个调用。

## 常见问题

**面板没有出现。**
确认是全屏渲染、终端至少 110 列；不到 144 列时面板在你发第一条消息时才打开，不在会话开始时。隐藏过或手动关掉过的，敲 `/anvil panel`。还是没有的话，在对话里找 Claude Code 写的、指出 anvil 哪个钩子出错的那一行，带上它[提一个 issue](https://github.com/Mistakey/anvil/issues)。

**图标显示成方框或问号。**
终端字体不是 Nerd Font。装一个，并在终端设置里选上它。

**缓存状态和 Claude Code 自己追踪的一致吗？**
是估算。mod 读不到 Claude Code 自己的缓存追踪，anvil 按请求时刻和用量推算。anvil 看不到的请求（别的插件的 fork、Claude Code 内置的保活）会让估算偏保守：最坏是守卫多提醒一次，或保活多发一次请求。

**用 API key、或者缓存是 5 分钟时能用吗？**
面板和翻译框可以。保活和守卫按订阅的 1 小时 TTL 设计。

**我是订阅用户，为什么金额按 API 牌价算？**
缓存读写怎么折算进订阅额度没有文档，API 牌价是唯一可比的尺度。用量框里的本会话花费直接取 Claude Code 报的数（`/cost`）。

**我的组织统一管理 Claude Code。**
在托管设置下，Claude Code 不把三个事件（`classic.SessionStart`、`classic.PermissionDenied`、`session.compact`）交给用户自己安装的插件。这时自动模式拒绝列表一直是空的，缓存状态也接不上恢复的会话和压缩，除非组织在托管设置里列出 anvil。

**`/clear`、`/resume` 之后面板清零了。**
这是预期的：换了对话，计数从零开始。

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

- Stephen Casella 的 [Flightdeck](https://github.com/scasella/claude-flightdeck)：停靠面板、子 agent 列表、遮密钥和界面动效的写法。
- Karan Bansal 的 [cache-tax](https://github.com/karanb192/cache-tax)：缓存估算、保活循环和冷发送守卫。

两者都是 MIT 许可。[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 列出 anvil 从各自借用了什么，并附许可原文。

## 许可

[MIT](LICENSE)
