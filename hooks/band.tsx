// 输入框上方那一行（AbovePrompt band）：目录名 · git · 5h · 7d · 花费（用户 2026-10-14/15 定）。
// 模型、effort、上下文、缓存交给输入框下方的 statusline，这一行不重复。
// git 照原来的身份栏（0.2.0 之前的 identity.tsx）：取法照用户原来的 ~/.claude/statusline.mjs（`--no-optional-locks`、
// 分离 HEAD 写 `@提交号`、`@{u}` 领先落后、储藏数），改成一条 `status --porcelain=v2 --branch --show-stash` 取齐分支、上游、
// 领先落后、各项计数和储藏数；另加目录名、未提交行数、停在一半的命令。组内单空格、组间两空格。
// 只放不碰 `$` 的纯逻辑和界面组件；运行 git、读 git 目录和读用量在 register.ts。

import type { Elements, RenderElement } from 'claude-code'

import type { GitOperation, GitView, Place, Usage } from '../types'
import { COLOR, ICON, SEPARATOR, fitSegments, widthOf } from './style'
import type { Segment } from './style'
import { fitTail } from './text'
import { costSegments, limitSegments } from './usage'

export const EMPTY_PLACE: Place = { dir: '', git: null }

// ---------------------------------------------------------------- git 的读法

/** 每条 git 命令都带：status 刷新索引时会拿 index.lock，超时被杀就留下残锁（statusline 的注释） */
export const GIT = ['git', '--no-optional-locks'] as const

/** 仓库根、git 目录、共用 git 目录（判断 linked worktree）、会话目录在仓库里的相对路径；不在 git 里时失败 */
export const REV_PARSE = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--show-prefix'] as const

/** 分支、上游、领先落后、储藏数和逐个文件的状态 */
export const STATUS = ['status', '--porcelain=v2', '--branch', '--show-stash'] as const

/** 未提交改动的行数：工作区和暂存区相对 HEAD */
export const NUMSTAT = ['diff', 'HEAD', '--numstat'] as const

export type RepoPaths = { top: string; gitDir: string; commonDir: string; prefix: string }

export function parseRepo(out: string): RepoPaths | null {
  const [top, gitDir, commonDir, prefix = ''] = out.split(/\r?\n/)
  if (!top || !gitDir || !commonDir) return null
  return { top, gitDir, commonDir, prefix: prefix.replace(/\/+$/, '') }
}

/** 路径的最后一段；`/` 和 `\` 都算分隔符 */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * 目录名：主仓库取仓库目录名；linked worktree 另接 worktree 目录名（主仓库名取共用 git 目录的上一级）；
 * 子目录接相对路径。不在 git 里的情况由调用方取会话目录名。
 */
export function repoNames(paths: RepoPaths): Pick<GitView, 'repo' | 'worktree' | 'sub'> {
  if (samePath(paths.gitDir, paths.commonDir)) return { repo: baseName(paths.top), worktree: null, sub: paths.prefix }
  const common = paths.commonDir.replace(/[\\/]+$/, '')
  const repo = /[\\/]\.git$/.test(common) ? baseName(common.replace(/[\\/]\.git$/, '')) : baseName(common).replace(/\.git$/, '')
  return { repo, worktree: baseName(paths.top), sub: paths.prefix }
}

export type Status = Omit<GitView, 'repo' | 'worktree' | 'sub' | 'lines' | 'operation'>

/** `git status --porcelain=v2 --branch --show-stash` */
export function parseStatus(out: string): Status {
  const status: Status = { branch: null, commit: null, noUpstream: false, ahead: 0, behind: 0, conflicts: 0, staged: 0, modified: 0, untracked: 0, stashes: 0 }
  let oid: string | null = null
  let head: string | null = null
  let hasUpstream = false
  for (const line of out.split(/\r?\n/)) {
    const words = line.split(' ')
    if (line.startsWith('# branch.oid ')) oid = words[2] ?? null
    else if (line.startsWith('# branch.head ')) head = words.slice(2).join(' ')
    else if (line.startsWith('# branch.upstream ')) hasUpstream = true
    else if (line.startsWith('# branch.ab ')) {
      status.ahead = Math.abs(Number.parseInt(words[2] ?? '0', 10)) || 0
      status.behind = Math.abs(Number.parseInt(words[3] ?? '0', 10)) || 0
    } else if (line.startsWith('# stash ')) status.stashes = Number.parseInt(words[2] ?? '0', 10) || 0
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = words[1] ?? '..'
      if (xy[0] !== '.') status.staged += 1
      if (xy[1] !== '.') status.modified += 1
    } else if (line.startsWith('u ')) status.conflicts += 1
    else if (line.startsWith('? ')) status.untracked += 1
  }
  if (head === null || head === '(detached)') {
    status.commit = oid && oid !== '(initial)' ? oid.slice(0, 7) : null
  } else {
    status.branch = head
    status.noUpstream = !hasUpstream
  }
  return status
}

/** `git diff HEAD --numstat`；二进制文件（`-`）不计 */
export function parseNumstat(out: string): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of out.split(/\r?\n/)) {
    const [plus, minus] = line.split('\t')
    if (plus === undefined || minus === undefined) continue
    added += Number.parseInt(plus, 10) || 0
    deleted += Number.parseInt(minus, 10) || 0
  }
  return { added, deleted }
}

/** rebase 停下时 git 目录里的进度文件：rebase-merge 是 msgnum / end，rebase-apply（含 am）是 next / last */
export type RebaseFiles = { dir: 'rebase-merge' | 'rebase-apply'; step?: string; total?: string; headName?: string; isAm: boolean }

/**
 * git 命令停在一半：看 git 目录里留下的标记。rebase 优先（它停下时也可能留着别的标记），
 * 其次 merge、cherry-pick、revert、bisect。
 */
export function operationOf(names: ReadonlySet<string>, rebase: RebaseFiles | null): GitOperation | null {
  if (rebase) {
    const step = Number.parseInt(rebase.step ?? '', 10)
    const total = Number.parseInt(rebase.total ?? '', 10)
    const name = rebase.isAm ? 'am' : 'rebase'
    return Number.isFinite(step) && Number.isFinite(total) && total > 0 ? { name, step, total } : { name }
  }
  if (names.has('MERGE_HEAD')) return { name: 'merge' }
  if (names.has('CHERRY_PICK_HEAD')) return { name: 'cherry-pick' }
  if (names.has('REVERT_HEAD')) return { name: 'revert' }
  if (names.has('BISECT_LOG')) return { name: 'bisect' }
  return null
}

/** 拼出 git 读数；rebase 中 HEAD 是分离的，分支名取 rebase 的 head-name */
export function gitView(paths: RepoPaths, status: Status, lines: GitView['lines'], operation: GitOperation | null, rebase: RebaseFiles | null): GitView {
  const view: GitView = { ...repoNames(paths), ...status, lines, operation }
  const headName = rebase?.headName?.trim().replace(/^refs\/heads\//, '')
  if (headName && headName !== 'detached HEAD') return { ...view, branch: headName, commit: null, noUpstream: false }
  return view
}

// ---------------------------------------------------------------- 各段

/** 分支、worktree 名、子目录各自最多占几格；窄屏时先把名字截短（从前面截，留下结尾），最短 NAME_MIN 格 */
const NAME_CELLS = 20
const NAME_MIN = 8

/** git 里几组之间空两格 */
const GROUP_GAP = 2

function spaced(groups: readonly Segment[][]): Segment[] {
  return groups.filter(group => group.length > 0).flatMap((group, index) => (index === 0 ? group : [{ text: ' '.repeat(GROUP_GAP) }, ...group]))
}

/** 目录名：仓库名加粗，linked worktree 接 worktree 名，子目录接相对路径；不在 git 里时是会话目录名。bare 时只写仓库名（窄屏） */
export function dirSegments(place: Place, names: number = NAME_CELLS, bare = false): Segment[] {
  const git = place.git
  const out: Segment[] = [{ text: `${ICON.dir} `, color: COLOR.icon }, { text: git ? git.repo : place.dir || '—', bold: true }]
  if (!git || bare) return out
  if (git.worktree) out.push({ text: ` ${ICON.worktree} `, color: COLOR.icon }, { text: fitTail(git.worktree, names) })
  if (git.sub) out.push({ text: fitTail(`/${git.sub}`, names), color: COLOR.secondary })
  return out
}

function opSegments(operation: GitOperation): Segment[] {
  const progress = operation.step !== undefined && operation.total !== undefined ? ` ${operation.step}/${operation.total}` : ''
  return [
    { text: `${ICON.pause} `, color: COLOR.high },
    { text: operation.name, color: COLOR.high, bold: true },
    ...(progress ? [{ text: progress, color: COLOR.high }] : []),
  ]
}

/**
 * git：分支紧跟 ↑↓ 和"无上游"、停在一半的命令、= + ! ? 计数和储藏、未提交行数；不在 git 里为空。
 * short 时只留分支一组和停在一半的命令（窄屏）
 */
export function gitSegments(git: GitView | null, names: number = NAME_CELLS, short = false): Segment[] {
  if (!git) return []
  const branch: Segment[] = []
  if (git.branch !== null) branch.push({ text: `${ICON.branch} ${fitTail(git.branch, names)}`, color: COLOR.branch })
  else if (git.commit !== null) branch.push({ text: `${ICON.detached} @${git.commit}`, color: COLOR.branch })
  if (branch.length > 0) {
    if (git.ahead > 0) branch.push({ text: ` ↑${git.ahead}`, color: COLOR.warn })
    if (git.behind > 0) branch.push({ text: ` ↓${git.behind}`, color: COLOR.warn })
    if (git.noUpstream) branch.push({ text: ' 无上游', color: COLOR.secondary })
  }
  const operation = git.operation ? opSegments(git.operation) : []
  if (short) return spaced([branch, operation])

  const marks: (Segment | null)[] = [
    git.conflicts > 0 ? { text: `=${git.conflicts}`, color: COLOR.danger, bold: true } : null,
    git.staged > 0 ? { text: `+${git.staged}`, color: COLOR.ok } : null,
    git.modified > 0 ? { text: `!${git.modified}`, color: COLOR.warn } : null,
    git.untracked > 0 ? { text: `?${git.untracked}`, color: COLOR.secondary } : null,
    git.stashes > 0 ? { text: `${ICON.stash} ${git.stashes}`, color: COLOR.secondary } : null,
  ]
  const counts: Segment[] = marks
    .filter((one): one is Segment => one !== null)
    .flatMap((one, index) => (index === 0 ? [one] : [{ text: ' ' }, one]))

  const lines = git.lines
  const changed: Segment[] =
    lines && lines.added + lines.deleted > 0
      ? [
          { text: `${ICON.lines} `, color: COLOR.icon },
          { text: `+${lines.added}`, color: COLOR.ok },
          { text: ' ' },
          { text: `−${lines.deleted}`, color: COLOR.danger },
        ]
      : []

  return spaced([branch, operation, counts, changed])
}

// ---------------------------------------------------------------- 一行

const joined = (parts: readonly Segment[][]) => parts.filter(part => part.length > 0).flatMap((part, index) => (index === 0 ? part : [SEPARATOR, ...part]))

/** 窄屏时依次让出的东西；重置时刻一直留着（用户定） */
type Level = { names: number; bars: boolean; git: 'full' | 'short' | 'none'; cost: boolean; bareDir: boolean }

const LEVELS: readonly Level[] = [
  { names: NAME_CELLS, bars: true, git: 'full', cost: true, bareDir: false },
  { names: NAME_MIN, bars: true, git: 'full', cost: true, bareDir: false },
  { names: NAME_MIN, bars: false, git: 'full', cost: true, bareDir: false },
  { names: NAME_MIN, bars: false, git: 'short', cost: true, bareDir: false },
  { names: NAME_MIN, bars: false, git: 'short', cost: false, bareDir: false },
  { names: NAME_MIN, bars: false, git: 'none', cost: false, bareDir: false },
  { names: NAME_MIN, bars: false, git: 'none', cost: false, bareDir: true },
]

/** 左边空 1 格，和主输入框的边线错开 */
const PAD_LEFT = 1

function lineAt(place: Place, usage: Usage, now: number, level: Level): Segment[] {
  return joined([
    dirSegments(place, level.names, level.bareDir),
    level.git === 'none' ? [] : gitSegments(place.git, level.names, level.git === 'short'),
    limitSegments('five_hour', usage.rateLimits, now, level.bars),
    limitSegments('seven_day', usage.rateLimits, now, level.bars),
    level.cost ? costSegments(usage) : [],
  ])
}

/**
 * 整行：放得下就全画；放不下先把名字截短，再去掉进度条、git 只留分支、去掉花费、去掉 git、目录只留仓库名，
 * 还放不下就从行尾截（窄屏退化先这样，用户再调）
 */
export function bandLine(place: Place, usage: Usage, now: number, columns: number): Segment[] {
  const room = Math.max(0, columns - PAD_LEFT)
  for (const level of LEVELS) {
    const line = lineAt(place, usage, now, level)
    if (widthOf(line) <= room) return line
  }
  return fitSegments(lineAt(place, usage, now, LEVELS[LEVELS.length - 1] as Level), room)
}

/** 画成一行；嵌套的 Text 沿用外层的 color，所以外层不设颜色（AGENTS.md Pitfalls） */
export function drawBand(els: Pick<Elements['terminal'], 'Box' | 'Text'>, segments: readonly Segment[], columns: number): RenderElement {
  const { Box, Text } = els
  return (
    <Box key="band" width={columns} flexShrink={0} paddingLeft={PAD_LEFT}>
      <Text wrap="truncate">
        {segments.map(segment => (
          <Text color={segment.color} bold={segment.bold}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}
