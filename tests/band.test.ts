import type { On, RenderPropsOf, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { bandLine, gitSegments, operationOf, parseNumstat, parseRepo, parseStatus, repoNames } from '../hooks/band'
import { COLOR, ICON } from '../hooks/style'
import type { Segment } from '../hooks/style'
import { cells } from '../hooks/text'
import type { GitView, Place, Usage } from '../types'
import { SESSION, flat, turnInput, world } from './world'
import type { Repo, WorldOptions } from './world'

// 输入框上方那一行：目录名 · git · 5h · 7d · 花费（用户 2026-10-14/15 定）

// ---------------------------------------------------------------- git 输出的固定样例

const MAIN_REPO = ['C:/w/anvil', 'C:/w/anvil/.git', 'C:/w/anvil/.git', ''].join('\n')

const WORKING: Repo = {
  cwd: 'C:\\w\\anvil',
  revParse: MAIN_REPO,
  status: [
    '# branch.oid 9f2c1e0a64564d7b2e8f0c1d2e3f4a5b6c7d8e9f',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +1 -0',
    '# stash 1',
    '1 M. N... 100644 100644 100644 aaa bbb hooks/register.ts',
    '1 .M N... 100644 100644 100644 aaa bbb hooks/band.tsx',
    '1 .D N... 100644 100644 000000 aaa bbb old.ts',
    '? notes.md',
  ].join('\n'),
  numstat: ['300\t40\thooks/register.ts', '12\t8\thooks/band.tsx', '-\t-\tlogo.png'].join('\n'),
}

const sample = (over: Partial<Repo>): Repo => ({ ...WORKING, ...over })

const CLEAN = ['# branch.oid 9f2c1e0', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'].join('\n')

const { dir: D, branch: B, detached: H, worktree: W, stash: S, lines: L, pause: P, reset: R } = ICON

// 本地时间 2026-10-13 20:00；格式化按本地时区，测试也按本地时区造时刻
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const NOW = at(13, 20)
const iso = (ms: number) => new Date(ms).toISOString()

const READING: SessionUsage = {
  startedAt: 0,
  context: { tokens: 152_000, window: 200_000, percent: 76 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: iso(at(13, 22)) },
    { kind: 'seven_day', percentUsed: 18, resetsAt: iso(at(15, 9)) },
  ],
  cost: { usd: 3.9 },
}

const BAND: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} }

async function band($: Engine, props: Partial<RenderPropsOf['AbovePrompt']> = {}) {
  return $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, ...props } })
}

/** 按样例开一个会话，画出那一行 */
async function lineOf($: Engine, on: On, options: WorldOptions, columns = 200): Promise<string> {
  mock.clock(on, { now: NOW })
  world(on, { reading: { current: READING }, ...options })
  await $.session.start({ ...SESSION, cwd: options.repo?.current.cwd ?? SESSION.cwd })
  const ui = await band($, { bodyColumns: columns })
  const line = flat(await ui.drawn())
  await ui.unmount()
  return line
}

/** 那一行按 " · " 分开的几组：目录名、git（不在 git 里时没有）、5h、7d、花费 */
const groups = (line: string) => line.trim().split(' · ')

async function gitOf($: Engine, on: On, repo: Repo): Promise<string> {
  const [dir, git] = groups(await lineOf($, on, { repo: { current: repo } }))
  return `${dir} · ${git}`
}

const bar = (filled: number) => `${'━'.repeat(filled)}${'─'.repeat(10 - filled)}`

// ---------------------------------------------------------------- 整行

test('一行：目录名 · git · 5h · 7d · 花费；5h、7d 是 10 格进度条、百分比和重置时刻', async ($, on) => {
  const line = await lineOf($, on, { repo: { current: sample({ status: CLEAN, numstat: '' }) } })
  expect(line).toBe(`${D} anvil · ${B} main · 5h ${bar(6)} 62% ${R} 22:00 · 7d ${bar(2)} 18% ${R} 09:00 10-15 · $3.90`)
})

test('5h、7d 的重置时刻一直显示：没有读数、窗口已过重置时写 0% 和 —；花费还没有读数时不画', async ($, on) => {
  const line = await lineOf($, on, { reading: { current: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: iso(at(13, 19)) }] } } })
  expect(groups(line)).toEqual([`${D} work`, `5h ${bar(0)} 0% ${R} —`, `7d ${bar(0)} 0% ${R} —`])
})

test('开局引擎还没有 5h、7d 时先画存档里最近的读数；读数到了再换', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const reading = { current: { ...READING, rateLimits: [] } as SessionUsage }
  const { store } = world(on, { reading })
  store.set('usageHistory.five_hour', { resetsAt: at(13, 22), samples: [{ at: NOW - 60_000, percent: 55 }] })
  await $.session.start(SESSION)
  const ui = await band($)
  expect(flat(await ui.drawn())).toContain(`5h ${bar(6)} 55% ${R} 22:00`)

  // 约 3 秒后引擎有了读数：隔一阵会再读，读到就画
  reading.current = READING
  await clock.advance(2000)
  expect(flat(await ui.drawn())).toContain(`5h ${bar(6)} 62% ${R} 22:00`)
  await ui.unmount()
})

test('读数随 session.measure 更新；花费在一轮结束时重新读', async ($, on) => {
  mock.clock(on, { now: NOW })
  const reading = { current: READING }
  world(on, { reading })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(SESSION)
  const ui = await band($)
  await $.session.measure({ ...READING, rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: iso(at(13, 22)) }], changed: ['rateLimits'] })
  expect(flat(await ui.drawn())).toContain(`5h ${bar(9)} 91%`)
  reading.current = { ...READING, cost: { usd: 123.4 } }
  await $.turn.complete(turnInput())
  expect(flat(await ui.drawn())).toMatch(/· \$123$/)
  await ui.unmount()
})

test('有问卷占着那一栏时让出来；手机上不画', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, { reading: { current: READING } })
  // 引擎自己画的问卷（替身）
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['问卷'] }) as never)
  await $.session.start(SESSION)
  const survey = await band($, { hasSurvey: true })
  expect(await survey.find({ key: 'band' })).toBeUndefined()
  await survey.unmount()
  const shown = await band($)
  expect(await shown.find({ key: 'band' })).toBeDefined()
  await shown.unmount()
})

// ---------------------------------------------------------------- 目录名

test('目录名：主仓库取仓库目录名', async ($, on) => {
  expect(await gitOf($, on, sample({ status: CLEAN, numstat: '' }))).toBe(`${D} anvil · ${B} main`)
})

test('目录名：linked worktree 接 worktree 目录名，主仓库名取共用 git 目录的上一级', async ($, on) => {
  const linked = sample({
    cwd: 'C:\\w\\anvil-worktrees\\agent-a9f9190b',
    revParse: ['C:/w/anvil-worktrees/agent-a9f9190b', 'C:/w/anvil/.git/worktrees/agent-a9f9190b', 'C:/w/anvil/.git', ''].join('\n'),
    status: ['# branch.oid 1234567', '# branch.head worktree-agent-a9f9190b', '# branch.upstream origin/x', '1 .M N... 1 1 1 a b x.ts'].join('\n'),
    numstat: '120\t4\tx.ts',
  })
  expect(await gitOf($, on, linked)).toBe(`${D} anvil ${W} agent-a9f9190b · ${B} …tree-agent-a9f9190b  !1  ${L} +120 −4`)
})

test('目录名：会话目录是仓库的子目录时接相对路径', async ($, on) => {
  const sub = sample({ cwd: 'C:\\w\\anvil\\hooks', revParse: ['C:/w/anvil', 'C:/w/anvil/.git', 'C:/w/anvil/.git', 'hooks/'].join('\n'), status: CLEAN, numstat: '' })
  expect(await gitOf($, on, sub)).toBe(`${D} anvil/hooks · ${B} main`)
})

test('目录名：不在 git 里只写会话目录名，没有 git 那一组', async ($, on) => {
  const line = await lineOf($, on, { repo: { current: sample({ cwd: 'C:\\Users\\me\\Downloads', revParse: null }) } })
  expect(groups(line)[0]).toBe(`${D} Downloads`)
  expect(groups(line)[1]).toStartWith('5h ')
})

// ---------------------------------------------------------------- git：分支和计数

test('分支、领先、各项计数、储藏数、未提交改动行数（二进制文件不计行数）；组内单空格、组间两空格', async ($, on) => {
  expect(await gitOf($, on, WORKING)).toBe(`${D} anvil · ${B} main ↑1  +1 !2 ?1 ${S} 1  ${L} +312 −48`)
})

test('领先和落后都写；冲突在最前', async ($, on) => {
  const diverged = sample({
    status: ['# branch.oid 1', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3', 'u UU N... 1 1 1 1 a b c x.ts'].join('\n'),
    numstat: '',
  })
  expect(await gitOf($, on, diverged)).toBe(`${D} anvil · ${B} main ↑2 ↓3  =1`)
})

test('分离 HEAD 显示 @提交号，不标无上游', async ($, on) => {
  const detached = sample({ status: ['# branch.oid a64564d7b2e8f0c1d', '# branch.head (detached)'].join('\n'), numstat: '' })
  expect(await gitOf($, on, detached)).toBe(`${D} anvil · ${H} @a64564d`)
})

test('没有上游时标"无上游"', async ($, on) => {
  const local = sample({ status: ['# branch.oid 1', '# branch.head feature/cache', '1 A. N... 0 1 1 0 a x.ts', '1 A. N... 0 1 1 0 a y.ts'].join('\n'), numstat: '57\t0\tx.ts' })
  expect(await gitOf($, on, local)).toBe(`${D} anvil · ${B} feature/cache no upstream  +2  ${L} +57 −0`)
})

// ---------------------------------------------------------------- git：停在一半的命令

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
  expect(await gitOf($, on, merging)).toBe(`${D} anvil · ${B} main  ${P} merge  =2 +3  ${L} +86 −12`)
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
  expect(await gitOf($, on, rebasing)).toBe(`${D} anvil · ${B} feature/cache  ${P} rebase 2/5  =1  ${L} +40 −9`)
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
  expect(await gitOf($, on, linked)).toBe(`${D} anvil ${W} t17 · ${B} task/t17  ${P} merge`)
})

// ---------------------------------------------------------------- 纯逻辑与配色

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

const GIT: GitView = {
  repo: 'anvil', worktree: null, sub: '', branch: 'main', commit: null, noUpstream: false, ahead: 1, behind: 2,
  conflicts: 1, staged: 1, modified: 1, untracked: 1, stashes: 1, lines: { added: 3, deleted: 4 }, operation: { name: 'merge' },
}

test('git 配色：分支紫；领先、落后、已修改黄，冲突红加粗、已暂存绿、⏸ 橙、行数绿红，状态色一种颜色一个意思', () => {
  const colorOf = (needle: string) => gitSegments(GIT).find(segment => segment.text.includes(needle))
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

test('5h、7d 配色：标签次要色，百分比按四档，重置图标图标色、时刻次要色；花费柔青', () => {
  const usage: Usage = { rateLimits: READING.rateLimits, costUsd: 3.9 }
  const line = bandLine({ dir: 'anvil', git: null }, usage, NOW, 200)
  const find = (text: string) => line.find(segment => segment.text === text)
  expect(find('5h ')?.color).toBe(COLOR.secondary)
  expect(find('62%')?.color).toBe(COLOR.warn)
  expect(find('18%')?.color).toBe(COLOR.ok)
  expect(find(` ${R} `)?.color).toBe(COLOR.icon)
  expect(find('22:00')?.color).toBe(COLOR.secondary)
  expect(find('$3.90')?.color).toBe(COLOR.cost)
})

// ---------------------------------------------------------------- 窄屏

const text = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')

const LONG: Place = {
  dir: 'anvil-k0t.46',
  git: { ...GIT, worktree: 'anvil-k0t.46', branch: 'task/a-very-long-branch-name-k0t.46', operation: null, conflicts: 0, stashes: 0, untracked: 0, behind: 0, lines: { added: 433, deleted: 186 } },
}
const USAGE: Usage = { rateLimits: READING.rateLimits, costUsd: 3.9 }

test('放不下时依次让出：名字截短、进度条、git 只留分支、花费、git、worktree 名；重置时刻一直在', () => {
  const wide = text(bandLine(LONG, USAGE, NOW, 200))
  expect(wide).toContain(`${B} …-branch-name-k0t.46 ↑1`)
  expect(wide).toContain(bar(6))
  const widths = [150, 130, 110, 90, 80, 70, 60, 50]
  const lines = widths.map(columns => text(bandLine(LONG, USAGE, NOW, columns)))
  for (const [index, line] of lines.entries()) {
    expect(cells(line) <= (widths[index] ?? 0) - 1, `${widths[index]} 列：${line}`).toBe(true)
  }
  // 名字先截短到 8 格
  expect(lines.some(line => line.includes(`${B} …-k0t.46`) && line.includes(bar(6)))).toBe(true)
  // 再去掉进度条，计数和行数还在
  expect(lines.some(line => !line.includes('━') && line.includes(`${L} +433 −186`))).toBe(true)
  // 再只留分支，花费还在
  expect(lines.some(line => !line.includes(`${L}`) && line.includes('$3.90'))).toBe(true)
  // 再去掉 git、目录只留仓库名：重置时刻还在
  expect(text(bandLine(LONG, USAGE, NOW, 70))).toBe(`${D} anvil ${W} …-k0t.46 · 5h 62% ${R} 22:00 · 7d 18% ${R} 09:00 10-15`)
  expect(text(bandLine(LONG, USAGE, NOW, 50))).toBe(`${D} anvil · 5h 62% ${R} 22:00 · 7d 18% ${R} 09:00 10-15`)
})

test('更窄时从行尾截，不超出那一栏', () => {
  for (const columns of [60, 40, 20, 8]) {
    const line = text(bandLine(LONG, USAGE, NOW, columns))
    expect(cells(line) <= columns - 1, `${columns} 列：${line}`).toBe(true)
  }
})

// ---------------------------------------------------------------- 刷新

test('主会话一轮结束、改文件的工具调用后、用户提交时重新读 git', async ($, on) => {
  mock.clock(on, { now: NOW })
  const repo = { current: sample({ status: CLEAN, numstat: '' }) }
  const { gitRuns } = world(on, { repo, reading: { current: READING } })
  await $.session.start(SESSION)
  const ui = await band($)
  repo.current = WORKING
  await $.turn.complete(turnInput())
  expect(flat(await ui.drawn())).toContain('+312 −48')

  repo.current = sample({ status: CLEAN, numstat: '' })
  const before = gitRuns.length
  await $.tool.call({ tool: 'Edit', file_path: 'x.ts', old_string: 'a', new_string: 'b', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'x.ts', tool_use_id: 'tu2' } as never)
  expect(flat(await ui.drawn())).not.toContain('+312')
  const afterTools = gitRuns.length
  expect(afterTools).toBeGreaterThan(before)

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(gitRuns.length).toBeGreaterThan(afterTools)
  await ui.unmount()
})

test('每条 git 命令都带 --no-optional-locks', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { gitRuns } = world(on, { repo: { current: WORKING } })
  await $.session.start(SESSION)
  expect(gitRuns.length).toBeGreaterThan(0)
  for (const argv of gitRuns) expect(argv.slice(0, 2)).toEqual(['git', '--no-optional-locks'])
})
