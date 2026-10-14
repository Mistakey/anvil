import type { FsEntry, On, ProcessRunResult, TurnStepChunk, TurnStepInput, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { effortSegment, formatSeconds, gitLine, modelLabel, modelLine, operationOf, parseNumstat, parseRepo, parseStatus, repoNames, speedLine, tokensPerSecond } from '../hooks/identity'
import { COLOR, ICON } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import type { Identity } from '../types'
import { turnInput } from './world'

// ---------------------------------------------------------------- git 输出的固定样例

/** 一个仓库在某一刻的样子：git 命令的输出，和 git 目录里的文件（键是相对 git 目录的路径） */
type Sample = {
  cwd: string
  /** rev-parse 的四行；null 表示不在 git 里（exit 128） */
  revParse: string | null
  status: string
  numstat: string | null
  files?: Record<string, string>
}

const MAIN_REPO = ['C:/w/anvil', 'C:/w/anvil/.git', 'C:/w/anvil/.git', ''].join('\n')

const WORKING: Sample = {
  cwd: 'C:\\w\\anvil',
  revParse: MAIN_REPO,
  status: [
    '# branch.oid 9f2c1e0a64564d7b2e8f0c1d2e3f4a5b6c7d8e9f',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +1 -0',
    '# stash 1',
    '1 M. N... 100644 100644 100644 aaa bbb hooks/register.ts',
    '1 .M N... 100644 100644 100644 aaa bbb hooks/panel.tsx',
    '1 .D N... 100644 100644 000000 aaa bbb old.ts',
    '? notes.md',
  ].join('\n'),
  numstat: ['300\t40\thooks/register.ts', '12\t8\thooks/panel.tsx', '-\t-\tlogo.png'].join('\n'),
}

const sample = (over: Partial<Sample>): Sample => ({ ...WORKING, ...over })

const CLEAN = ['# branch.oid 9f2c1e0', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'].join('\n')

const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const failed: ProcessRunResult = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 400, cache_read_input_tokens: 150000, cache_creation_input_tokens: 500, model: 'claude-opus-5-5', ...over,
})

/** 一次请求的时间线：等 firstMs 出首字，再用 streamMs 流完，最后是带用量的 stop */
type Timing = { firstMs: number; streamMs: number; output: number }

// 插件之下的世界：git 和 git 目录按样例作答；请求按 timing 流出
function engine(on: On, repo: { current: Sample }, timing: { current: Timing } = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }) {
  const clock = mock.clock(on, { now: 10 * 3_600_000 })
  const gitRuns: string[][] = []
  const gitDir = () => parseRepo(repo.current.revParse ?? '')?.gitDir ?? ''
  // 引擎把插件给的路径按本机写法规范化（Windows 上是反斜杠），这里统一回正斜杠，取相对 git 目录的部分
  const slashed = (path: string) => path.replace(/\\/g, '/')
  const inGitDir = (path: string) => slashed(path).slice(gitDir().length + 1)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: repo.current.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const { firstMs, streamMs, output } = timing.current
    await clock.sleep(firstMs)
    const thinking: TurnStepChunk = { kind: 'thinking', index: 0, text: '想' }
    yield thinking
    await clock.sleep(streamMs)
    const done = usage({ output_tokens: output })
    const stop: TurnStepChunk = { kind: 'stop', stopReason: 'end_turn', usage: done }
    yield stop
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: done }
  })
  on('process.run', ($, e) => {
    const [, , command] = e.argv
    gitRuns.push([...e.argv])
    const now = repo.current
    if (command === 'rev-parse') return { value: now.revParse === null ? failed : ok(now.revParse) }
    if (now.revParse === null) return { value: failed }
    if (command === 'status') return { value: ok(now.status) }
    if (command === 'diff') return { value: now.numstat === null ? failed : ok(now.numstat) }
    return { value: failed }
  })
  on('fs.list', ($, e) => {
    const names = slashed(e.path) === gitDir() ? new Set(Object.keys(repo.current.files ?? {}).map(path => path.split('/')[0] ?? '')) : new Set<string>()
    const entries: FsEntry[] = [...names].map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', ($, e) => {
    const text = repo.current.files?.[inGitDir(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: (repo.current.files ?? {})[inGitDir(e.path)] !== undefined }))
  return { clock, gitRuns }
}

type Engine = Parameters<TestBody>[0]

const SESSION = { cwd: 'C:\\w\\anvil', surface: null, isInteractive: true }

const pane = (bodyColumns: number) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
})

/** 画出来的一个元素里所有的字，按文档顺序 */
function flat(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flat).join('')
  if (node !== null && typeof node === 'object') {
    const { children, props } = node as { children?: unknown; props?: { children?: unknown } }
    return flat(children ?? props?.children ?? [])
  }
  return ''
}

const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')

const { dir: D, branch: B, detached: H, worktree: W, stash: S, lines: L, pause: P, model: M, speed: V } = ICON

/** 按样例开一个会话，画出面板，读身份栏第一行 */
async function firstLine($: Engine, on: On, repo: Sample, columns = 70): Promise<string> {
  engine(on, { current: repo })
  await $.session.start({ ...SESSION, cwd: repo.cwd })
  const ui = await $.ui.mount(pane(columns))
  const line = flat(await ui.find({ key: 'identity:git' }))
  await ui.unmount()
  return line
}

// ---------------------------------------------------------------- 第一行：目录名

test('目录名：主仓库取仓库目录名', async ($, on) => {
  expect(await firstLine($, on, sample({ status: CLEAN, numstat: '' }))).toBe(`${D} anvil  ${B} main`)
})

test('目录名：linked worktree 接 worktree 目录名，主仓库名取共用 git 目录的上一级', async ($, on) => {
  const linked = sample({
    cwd: 'C:\\w\\anvil-worktrees\\agent-a9f9190b',
    revParse: ['C:/w/anvil-worktrees/agent-a9f9190b', 'C:/w/anvil/.git/worktrees/agent-a9f9190b', 'C:/w/anvil/.git', ''].join('\n'),
    status: ['# branch.oid 1234567', '# branch.head worktree-agent-a9f9190b', '# branch.upstream origin/x', '1 .M N... 1 1 1 a b x.ts'].join('\n'),
    numstat: '120\t4\tx.ts',
  })
  expect(await firstLine($, on, linked)).toBe(`${D} anvil ${W} agent-a9f9190b  ${B} …tree-agent-a9f9190b  !1  ${L} +120 −4`)
})

test('目录名：会话目录是仓库的子目录时接相对路径', async ($, on) => {
  const sub = sample({ cwd: 'C:\\w\\anvil\\hooks', revParse: ['C:/w/anvil', 'C:/w/anvil/.git', 'C:/w/anvil/.git', 'hooks/'].join('\n'), status: CLEAN, numstat: '' })
  expect(await firstLine($, on, sub)).toBe(`${D} anvil/hooks  ${B} main`)
})

test('目录名：不在 git 里只写会话目录名', async ($, on) => {
  const outside = sample({ cwd: 'C:\\Users\\me\\Downloads', revParse: null })
  expect(await firstLine($, on, outside)).toBe(`${D} Downloads`)
})

// ---------------------------------------------------------------- 第一行：分支和计数

test('分支、领先、各项计数、储藏数、未提交改动行数（二进制文件不计行数）', async ($, on) => {
  expect(await firstLine($, on, WORKING)).toBe(`${D} anvil  ${B} main ↑1  +1 !2 ?1 ${S} 1  ${L} +312 −48`)
})

test('领先和落后都写；冲突在最前', async ($, on) => {
  const diverged = sample({
    status: ['# branch.oid 1', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3', 'u UU N... 1 1 1 1 a b c x.ts'].join('\n'),
    numstat: '',
  })
  expect(await firstLine($, on, diverged)).toBe(`${D} anvil  ${B} main ↑2 ↓3  =1`)
})

test('分离 HEAD 显示 @提交号，不标无上游', async ($, on) => {
  const detached = sample({ status: ['# branch.oid a64564d7b2e8f0c1d', '# branch.head (detached)'].join('\n'), numstat: '' })
  expect(await firstLine($, on, detached)).toBe(`${D} anvil  ${H} @a64564d`)
})

test('没有上游时标"无上游"', async ($, on) => {
  const local = sample({ status: ['# branch.oid 1', '# branch.head feature/cache', '1 A. N... 0 1 1 0 a x.ts', '1 A. N... 0 1 1 0 a y.ts'].join('\n'), numstat: '57\t0\tx.ts' })
  expect(await firstLine($, on, local)).toBe(`${D} anvil  ${B} feature/cache 无上游  +2  ${L} +57 −0`)
})

// ---------------------------------------------------------------- 第一行：停在一半的命令

test('merge 停在一半：⏸ merge，冲突和已暂存', async ($, on) => {
  const merging = sample({
    status: [
      '# branch.oid 1',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      'u UU N... 1 1 1 1 a b c x.ts',
      'u AA N... 1 1 1 1 a b c y.ts',
      '1 M. N... 1 1 1 a b p.ts',
      '1 M. N... 1 1 1 a b q.ts',
      '1 A. N... 0 1 1 0 a r.ts',
    ].join('\n'),
    numstat: '86\t12\tx.ts',
    files: { MERGE_HEAD: 'abc\n', ORIG_HEAD: 'def\n' },
  })
  expect(await firstLine($, on, merging)).toBe(`${D} anvil  ${B} main  ${P} merge  =2 +3  ${L} +86 −12`)
})

test('rebase 停在第 2 步（共 5 步）：分支名取 rebase 的原分支，带进度', async ($, on) => {
  const rebasing = sample({
    status: ['# branch.oid 77aa88b', '# branch.head (detached)', 'u UU N... 1 1 1 1 a b c x.ts'].join('\n'),
    numstat: '40\t9\tx.ts',
    files: {
      REBASE_HEAD: 'abc\n',
      'rebase-merge/msgnum': '2\n',
      'rebase-merge/end': '5\n',
      'rebase-merge/head-name': 'refs/heads/feature/cache\n',
    },
  })
  expect(await firstLine($, on, rebasing)).toBe(`${D} anvil  ${B} feature/cache  ${P} rebase 2/5  =1  ${L} +40 −9`)
})

test('cherry-pick、revert、bisect、am 停在一半', () => {
  expect(operationOf(new Set(['CHERRY_PICK_HEAD']), null)).toEqual({ name: 'cherry-pick' })
  expect(operationOf(new Set(['REVERT_HEAD']), null)).toEqual({ name: 'revert' })
  expect(operationOf(new Set(['BISECT_LOG']), null)).toEqual({ name: 'bisect' })
  expect(operationOf(new Set(['rebase-apply']), { dir: 'rebase-apply', step: '1', total: '3', isAm: true })).toEqual({ name: 'am', step: 1, total: 3 })
  // rebase 优先于它停下时留着的别的标记
  expect(operationOf(new Set(['rebase-merge', 'CHERRY_PICK_HEAD']), { dir: 'rebase-merge', step: '3', total: '4', isAm: false })).toEqual({ name: 'rebase', step: 3, total: 4 })
  expect(operationOf(new Set(['ORIG_HEAD', 'FETCH_HEAD']), null)).toBe(null)
})

test('linked worktree 里停在一半的命令看它自己的 git 目录', async ($, on) => {
  const linked = sample({
    cwd: 'C:\\w\\anvil-worktrees\\t17',
    revParse: ['C:/w/anvil-worktrees/t17', 'C:/w/anvil/.git/worktrees/t17', 'C:/w/anvil/.git', ''].join('\n'),
    status: CLEAN.replace('main', 'task/t17'),
    numstat: '',
    files: { MERGE_HEAD: 'abc\n' },
  })
  expect(await firstLine($, on, linked)).toBe(`${D} anvil ${W} t17  ${B} task/t17  ${P} merge`)
})

// ---------------------------------------------------------------- 第一行：纯逻辑与配色

test('解析：rev-parse、status、numstat', () => {
  expect(parseRepo(['C:/w/anvil', 'C:/w/anvil/.git', 'C:/w/anvil/.git', 'hooks/', ''].join('\n'))).toEqual({
    top: 'C:/w/anvil', gitDir: 'C:/w/anvil/.git', commonDir: 'C:/w/anvil/.git', prefix: 'hooks',
  })
  expect(repoNames({ top: 'D:/x/repo.wt', gitDir: 'D:/srv/repo.git/worktrees/repo.wt', commonDir: 'D:/srv/repo.git', prefix: '' })).toEqual({
    repo: 'repo', worktree: 'repo.wt', sub: '',
  })
  expect(parseStatus('# branch.oid (initial)\n# branch.head main\n')).toMatchObject({ branch: 'main', commit: null, noUpstream: true })
  expect(parseStatus(WORKING.status)).toMatchObject({ ahead: 1, behind: 0, staged: 1, modified: 2, untracked: 1, stashes: 1, conflicts: 0 })
  expect(parseNumstat(WORKING.numstat ?? '')).toEqual({ added: 312, deleted: 48 })
})

test('第一行配色：图标是图标色，分支紫；领先、落后、已修改黄，冲突红加粗、已暂存绿、⏸ 橙、行数绿红，状态色一种颜色一个意思', () => {
  const identity: Identity = {
    dir: 'anvil',
    git: {
      repo: 'anvil', worktree: null, sub: '', branch: 'main', commit: null, noUpstream: false, ahead: 1, behind: 2,
      conflicts: 1, staged: 1, modified: 1, untracked: 1, stashes: 1, lines: { added: 3, deleted: 4 }, operation: { name: 'merge' },
    },
    model: null, effort: null, tokensPerSecond: null, firstTokenMs: null, requestMs: null,
  }
  const colorOf = (needle: string) => gitLine(identity).find(segment => segment.text.includes(needle))
  expect(colorOf(D)?.color).toBe(COLOR.icon)
  expect(colorOf('main')?.color).toBe(COLOR.branch)
  expect(colorOf('↑1')?.color).toBe(COLOR.warn)
  expect(colorOf('↓2')?.color).toBe(COLOR.warn)
  expect(colorOf('=1')).toMatchObject({ color: COLOR.danger, bold: true })
  expect(colorOf('+1')?.color).toBe(COLOR.ok)
  expect(colorOf('!1')?.color).toBe(COLOR.warn)
  expect(colorOf('?1')?.color).toBe(COLOR.secondary)
  expect(colorOf('merge')).toMatchObject({ color: COLOR.high, bold: true })
  expect(colorOf('+3')?.color).toBe(COLOR.ok)
  expect(colorOf('−4')?.color).toBe(COLOR.danger)
})

// ---------------------------------------------------------------- 第二行：模型、effort；第三行：速度

test('模型写 Opus 5.5、Sonnet 4.5、Haiku', () => {
  expect(['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-fable-5-1[1m]', 'haiku', 'gpt-x'].map(modelLabel)).toEqual([
    'Opus 5.5', 'Sonnet 4.5', 'Opus 4', 'Fable 5.1', 'Haiku', 'gpt-x',
  ])
})

test('effort 五档颜色：low 绿、medium 黄、high 橙、xhigh 红、max 红加粗', () => {
  expect(['low', 'medium', 'high', 'xhigh', 'max'].map(effortSegment)).toEqual([
    { text: 'low', color: COLOR.ok },
    { text: 'medium', color: COLOR.warn },
    { text: 'high', color: COLOR.high },
    { text: 'xhigh', color: COLOR.danger },
    { text: 'max', color: COLOR.danger, bold: true },
  ])
})

const IDENTITY: Identity = { dir: '', git: null, model: 'claude-opus-5-5', effort: 'high', tokensPerSecond: 68, firstTokenMs: 1500, requestMs: 12_740 }

test('token/s：输出 ÷ 首字到结束；缺时刻、跨度为零、没有输出时算不出', () => {
  expect(tokensPerSecond(400, 2000, 10000)).toBe(50)
  expect(tokensPerSecond(400, null, 10000)).toBe(null)
  expect(tokensPerSecond(400, 5000, 5000)).toBe(null)
  expect(tokensPerSecond(0, 0, 1000)).toBe(null)
})

test('第二行只有模型 · effort；第三行 token/s · 首字 · 用时（图标另画），数值不着色、右对齐到定宽；回复中数值次要色', () => {
  expect(text(modelLine(IDENTITY))).toBe(`${M} Opus 5.5 · high`)
  const line = speedLine(IDENTITY)
  expect(text(line)).toBe(' 68 token/s · 首字  1.5s · 用时 12.7s')
  for (const value of [' 68', ' 1.5s', '12.7s']) expect(line.find(segment => segment.text === value)?.color).toBeUndefined()
  // 主会话回复中：这是上一次的读数，数值退到次要色，写法和位置不变
  const replying = speedLine(IDENTITY, true)
  expect(text(replying)).toBe(text(line))
  for (const value of [' 68', ' 1.5s', '12.7s']) expect(replying.find(segment => segment.text === value)?.color).toBe(COLOR.secondary)
  // 数字变长变短时，"首字""用时"不挪位置
  const at = (identity: Identity, word: string) => text(speedLine(identity)).indexOf(word)
  for (const other of [{ ...IDENTITY, tokensPerSecond: 312, firstTokenMs: 12_700 }, { ...IDENTITY, tokensPerSecond: 9, firstTokenMs: 95_400 }]) {
    expect(at(other, '首字')).toBe(at(IDENTITY, '首字'))
    expect(at(other, '用时')).toBe(at(IDENTITY, '用时'))
  }
})

test('第三行：还没有请求时写 —；缺的项不写', () => {
  const none: Identity = { ...IDENTITY, tokensPerSecond: null, firstTokenMs: null, requestMs: null }
  expect(text(speedLine(none))).toBe('—')
  expect(text(speedLine({ ...IDENTITY, tokensPerSecond: null }))).toBe('首字  1.5s · 用时 12.7s')
})

test('秒数：不到 60 秒一位小数，60 秒起按 1m35s', () => {
  expect([0, 1500, 12_740, 59_940, 60_000, 95_400, 3_725_000].map(formatSeconds)).toEqual(['0.0s', '1.5s', '12.7s', '59.9s', '1m00s', '1m35s', '1h02m'])
})

/** 身份栏第二、三行 */
async function lowerLines($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(pane(70))
  const lines = [flat(await ui.find({ key: 'identity:model' })), flat(await ui.find({ key: 'identity:speed' }))]
  await ui.unmount()
  return lines
}

/** 跑完一次请求：时钟走到它流完 */
async function step($: Engine, clock: { advance: (ms: number) => Promise<void> }, input: TurnStepInput) {
  const stream = $.turn.step(input)
  const drained = (async () => {
    for await (const chunk of stream) void chunk
    return stream.result
  })()
  await clock.advance(60_000)
  const result = await drained
  // 主会话的这一轮结束：回复中速度行的图标是转动的 ◐，结束后才是闪电图标
  if (input.agentId === undefined) await $.turn.complete(turnInput())
  return result
}

test('会话开始时只有模型；每次主会话请求后写 effort、从首字算起的 token/s、首字等待和整次用时', async ($, on) => {
  const timing = { current: { firstMs: 2000, streamMs: 8000, output: 400 } }
  const { clock } = engine(on, { current: sample({ status: CLEAN, numstat: '' }) }, timing)
  await $.session.start(SESSION)
  expect(await lowerLines($)).toEqual([`${M} Opus 5.5`, `${V} —`])

  // 首字前等了 2 秒不算进速度：400 tokens ÷ 8 秒；整次 10 秒
  await step($, clock, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  expect(await lowerLines($)).toEqual([`${M} Opus 5.5 · high`, `${V}  50 token/s · 首字  2.0s · 用时 10.0s`])

  // 子 agent 的请求不计入：模型、effort、速度都不变
  timing.current = { firstMs: 500, streamMs: 1000, output: 900 }
  await step($, clock, { turnId: 't2', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 3, agentId: 'ag1' })
  expect(await lowerLines($)).toEqual([`${M} Opus 5.5 · high`, `${V}  50 token/s · 首字  2.0s · 用时 10.0s`])

  // 下一次主会话请求换了模型和 effort
  timing.current = { firstMs: 1500, streamMs: 4000, output: 360 }
  await step($, clock, { turnId: 't3', index: 0, model: 'claude-sonnet-5-5', effort: 'max', messageCount: 5 })
  expect(await lowerLines($)).toEqual([`${M} Sonnet 5.5 · max`, `${V}  90 token/s · 首字  1.5s · 用时 5.5s`])
})

test('第二行：第一次请求前不写 effort（settings、环境变量里设了也不推算），第一次请求后写请求带的', async ($, on) => {
  const { clock } = engine(on, { current: sample({ status: CLEAN, numstat: '' }) })
  on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } }))
  on('env.get', () => ({ value: 'low' }))
  await $.session.start(SESSION)
  expect((await lowerLines($))[0]).toBe(`${M} Opus 5.5`)

  await step($, clock, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3 })
  expect((await lowerLines($))[0]).toBe(`${M} Opus 5.5 · xhigh`)
})

// ---------------------------------------------------------------- 刷新与排版

test('主会话一轮结束后重新读 git', async ($, on) => {
  const repo = { current: sample({ status: CLEAN, numstat: '' }) }
  engine(on, repo)
  await $.session.start(SESSION)
  repo.current = WORKING
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: usage() })
  const ui = await $.ui.mount(pane(70))
  expect(flat(await ui.find({ key: 'identity:git' }))).toContain('+312 −48')
  await ui.unmount()
})

test('每条 git 命令都带 --no-optional-locks', async ($, on) => {
  const { gitRuns } = engine(on, { current: WORKING })
  await $.session.start(SESSION)
  expect(gitRuns.length).toBeGreaterThan(0)
  for (const argv of gitRuns) expect(argv.slice(0, 2)).toEqual(['git', '--no-optional-locks'])
})

test('身份栏三行在面板最底（我的消息下面）；各种宽度下都不超出面板', async ($, on) => {
  const long = sample({
    cwd: 'C:\\w\\anvil-worktrees\\agent-a9f9190b',
    revParse: ['C:/w/anvil-worktrees/agent-a9f9190b', 'C:/w/anvil/.git/worktrees/agent-a9f9190b', 'C:/w/anvil/.git', 'hooks/deep/'].join('\n'),
    files: { 'rebase-merge/msgnum': '12', 'rebase-merge/end': '15', 'rebase-merge/head-name': 'refs/heads/feature/a-very-long-branch-name' },
  })
  const { clock } = engine(on, { current: long })
  await $.session.start(SESSION)
  await step($, clock, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3 })
  for (const columns of [110, 70, 52, 40]) {
    const ui = await $.ui.mount(pane(columns))
    const root = await ui.find({ key: 'identity:git' })
    expect(root?.props.width).toBe(columns)
    for (const key of ['identity:git', 'identity:model', 'identity:speed']) {
      // 左边空 2 格：图标和框里的名称列、序号从同一列起；右边空 1 格，和框的右边线对齐
      expect((await ui.find({ key }))?.props, key).toMatchObject({ paddingLeft: 2, paddingRight: 1 })
      const shown = flat(await ui.find({ key }))
      expect(cells(shown) <= columns - 3, `${columns} 列 ${key}：${shown}`).toBe(true)
    }
    const order = (await ui.findAll({ type: 'Box' })).map(one => one.key).filter(key => key?.startsWith('section:') || key?.startsWith('identity:'))
    expect(order.slice(-4)).toEqual(['section:messages', 'identity:git', 'identity:model', 'identity:speed'])
    await ui.unmount()
  }
})

test('更窄时组间距收成一格，名字至少 4 格；计数和改动行数仍在行里', async ($, on) => {
  const linked = sample({
    cwd: 'C:\w\anvil-worktrees\anvil-k0t.46',
    revParse: ['C:/w/anvil-worktrees/anvil-k0t.46', 'C:/w/anvil/.git/worktrees/anvil-k0t.46', 'C:/w/anvil/.git', ''].join('\n'),
    status: ['# branch.oid 1', '# branch.head task/anvil-k0t.46', '1 M. N... 1 1 1 a b x.ts', ...Array.from({ length: 22 }, (_, i) => `1 .M N... 1 1 1 a b y${i}.ts`)].join('\n'),
    numstat: '433\t186\tx.ts',
  })
  const line = await firstLine($, on, linked, 51)
  expect(line).toBe(`${D} anvil ${W} ….46 ${B} ….46 无上游 +1 !22 ${L} +433 −186`)
  expect(cells(line)).toBeLessThanOrEqual(51 - 3)
})

test('面板窄、名字长时名字让位：平分剩下的格子、从前面截，计数和改动行数留在行里', async ($, on) => {
  const linked = sample({
    cwd: 'C:\w\anvil-worktrees\anvil-k0t.17',
    revParse: ['C:/w/anvil-worktrees/anvil-k0t.17', 'C:/w/anvil/.git/worktrees/anvil-k0t.17', 'C:/w/anvil/.git', ''].join('\n'),
    status: ['# branch.oid 1', '# branch.head task/anvil-k0t.17', '1 .M N... 1 1 1 a b x.ts', '? y.ts'].join('\n'),
    numstat: '120\t4\tx.ts',
  })
  expect(await firstLine($, on, linked, 64)).toBe(`${D} anvil ${W} …vil-k0t.17  ${B} …vil-k0t.17 无上游  !1 ?1  ${L} +120 −4`)
})
