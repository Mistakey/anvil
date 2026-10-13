# anvil v1 调度协议（herdr）

适用于 Epic anvil-k0t 的交付任务 .11–.23。设计以 `docs/specs/anvil-k0t/spec.md` 为准；任务正文和 Epic 的 Rulings 每次都以 tracker 里的当前内容为准。

## 角色

- **调度会话**：只派活、合入、关任务、通知用户。不写功能代码；不替用户回答任务会话里的权限确认或提问；不替用户给人工节点下结论。
- **任务会话**：一个任务对应一个会话、一个 worktree。做完就报告，不合入、不关任务。
- 不用 forge runner、`forge invoke`、forge:execute（forge 正在重做，这条路容易卡住）。forge 只当任务板用：`list`、`show`、`ready`、`update --claim`、`comment`、`close`、`create`。

## 位置

- 主仓库：`C:\work\5.code\personal\anvil`（main）。
- 集成分支 `anvil-v1`，worktree 放在 `C:\work\5.code\personal\anvil-worktrees\anvil-v1`；第一次需要时由调度会话从 main 拉出。
- 任务 worktree 放在 `C:\work\5.code\personal\anvil-worktrees\<任务 id>`，分支 `task/<任务 id>`，从当时的 `anvil-v1` 拉出。可以用 `herdr worktree create --cwd <主仓库> --branch task/<任务 id> --base anvil-v1 --path <路径> --label <任务 id> --no-focus` 建，一个任务一个 herdr workspace；具体用法以 `herdr worktree` 的帮助和返回的 JSON 为准。
- 任务会话的 herdr agent 名取任务号：`t11` … `t23`。

## 派活

- 读 `forge tracker list --parent anvil-k0t`：状态是 open、依赖都已关闭的 AI 任务（implement、review、closeout）就可以派。
- 同时最多 3 个任务会话。理由：.11 之后大多是彼此独立的模块，能并行的通常只有 2–3 个；同时跑的会话越多越费订阅额度；合入由调度会话一个一个做。
- 起会话：在任务 worktree 的 pane 里运行 `herdr agent start t<号> --kind claude --pane <pane>`，等它 idle 后，用 `herdr agent prompt` 发下面的开场白。
- 盯进度：用 `herdr agent wait`。状态变成 blocked 时，用 `herdr notification show` 通知用户去那个 pane 处理，并在调度 pane 里写清是哪个任务、卡在哪里。看输出用 `herdr agent read --source recent-unwrapped`。

## 任务会话开场白（implement）

```text
你负责 anvil 的任务 <id>。当前目录就是这个任务的 worktree（分支 task/<id>）。
1. 先读：forge tracker show <id>（正文和验收）、forge tracker body show anvil-k0t（Rulings）、spec 里正文指到的 D、AGENTS.md、.forge/config.md。
2. 运行 forge tracker update <id> --claim 领取任务。被拒就停下，输出一行：BLOCKED <id>: <原因>
3. 按正文的 Acceptance 实现，测试先行。新 worktree 先按 AGENTS.md 生成类型，再跑 validate、plugin test、tsc。
4. 在本分支提交（<type>(<scope>): <中文>，正文写任务 id）。不要合入 anvil-v1，不要关闭任务，不要用 forge:execute 或 forge invoke。
5. 完成后用 forge tracker comment <id> 写交付摘要（做了什么、提交、检查结果、遗留问题），最后单独一行输出：READY <id> <提交号>
6. 碰到 spec 没定、又没有合理默认的事，停下，输出一行：QUESTION <id>: <问题>，等用户答复。
```

## 合入与关闭

- 看到 `READY`：在 anvil-v1 的 worktree 里 `git merge --no-ff task/<id>`，再跑检查（validate、plugin test、tsc；这个 worktree 第一次用时先生成类型）。
- 合并冲突或检查失败：把情况发回该任务会话，让它在自己的分支上合入最新的 anvil-v1、解决后重新 READY。
- 成功：`forge tracker close <id> --resolution "<交付摘要>；合入 anvil-v1 <合并提交>"`。然后结束该任务会话，`git worktree remove` 删掉 worktree，`git branch -d` 删掉分支。
- 看到 `QUESTION`：通知用户，把问题原样转给用户；用户答复后，再原样转给任务会话。

## 特殊任务

- **.12 探针**：READY 后不合入。关闭时 resolution 写明试用步骤的 material id 和探针 worktree 的路径。探针的 worktree 和分支保留到 .13 结束；分支没有合入，删除前先问用户。
- **.13、.22 人工节点**：不开会话。依赖关闭后通知用户，在调度 pane 里说清要做什么（任务正文就是清单）。用户回报后，把结论原样写进 resolution 再关闭。.13 的第 1、2、4、5 项任一不成立时，停止派活，请用户回规划会话改 spec、重切任务。一次只让用户做一个人工节点。
- **.21 review**：worktree 用 anvil-v1 当前提交（detached HEAD，不建任务分支）。开场白改成：领取后按正文对照 `git diff main...anvil-v1` 做 review，发现写成任务评论，最后输出 `READY <id>`（没有要修的）或 `FINDINGS <id>`。有要修的发现时，调度会话为每条发现建一个任务：`forge tracker create --parent anvil-k0t --type implement --blocks anvil-k0t.22`，正文写清发现和验收，按 implement 流程派；review 本身照常关闭，resolution 写结论和新建任务的 id。
- **.23 closeout**：会话开在主仓库目录（main），按正文做。这是最后一步，完成后调度会话确认 Epic 已关闭。

## 断了怎么办

调度会话不保存进度。中断或压缩之后，用 `forge tracker list --parent anvil-k0t` 和 `herdr agent list` 重新弄清现状。任务是 in_progress、却找不到对应 agent 的，先看它的 worktree 和评论，再问用户是接着做还是重新派。
