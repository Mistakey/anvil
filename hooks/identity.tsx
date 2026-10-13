// 身份栏（spec D8）：面板最底的两行。第一行是目录名和 git 状态，第二行是模型、effort 和输出速度。
// git 取法照用户原来的 ~/.claude/statusline.mjs（`--no-optional-locks`、分离 HEAD 写 `@提交号`、
// `@{u}` 领先落后、储藏数），改成一条 `status --porcelain=v2 --branch --show-stash` 取齐分支、上游、
// 领先落后、各项计数和储藏数；目录名、改动行数、停在一半的命令是 statusline 没有的，按 D8 加。
// tok/s 照 .13 探针：首字是请求流里第一块不是 engine 的，结束是 stop 那块，只算主会话。
// 只放不碰 `$` 的纯逻辑和界面组件；运行 git、读 git 目录和记请求时刻在 register.ts。

import type { Elements, RenderElement } from 'claude-code'

import type { GitOperation, GitView, Identity } from '../types'
import { COLOR, ICON, SEPARATOR, fitSegments } from './style'
import type { Segment } from './style'
import { fit } from './text'

export const EMPTY_IDENTITY: Identity = { dir: '', git: null, model: null, effort: null, tokensPerSecond: null }

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
 * 目录名（D8）：主仓库取仓库目录名；linked worktree 另接 worktree 目录名（主仓库名取共用 git 目录的上一级）；
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
 * git 命令停在一半（D8）：看 git 目录里留下的标记。rebase 优先（它停下时也可能留着别的标记），
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

// ---------------------------------------------------------------- 模型、effort、tok/s

/** Opus 5.5、Sonnet 4.5、Haiku；不认识的原样 */
export function modelLabel(id: string): string {
  const bare = id.replace(/\[[^\]]*\]$/, '')
  const match = /(opus|sonnet|haiku|fable)(?:-(\d+)(?:[-.](\d{1,2})(?!\d))?)?/i.exec(bare)
  if (!match) return bare
  const family = (match[1] ?? '').charAt(0).toUpperCase() + (match[1] ?? '').slice(1).toLowerCase()
  const major = match[2] && match[2].length <= 2 ? match[2] : undefined
  const version = major ? (match[3] ? `${major}.${match[3]}` : major) : ''
  return version ? `${family} ${version}` : family
}

/** effort 五档颜色（D10）：low 绿、medium 黄、high 橙、xhigh 红、max 红加粗；数字档不着色 */
export function effortSegment(effort: string | number): Segment {
  switch (effort) {
    case 'low':
      return { text: effort, color: COLOR.ok }
    case 'medium':
      return { text: effort, color: COLOR.warn }
    case 'high':
      return { text: effort, color: COLOR.high }
    case 'xhigh':
      return { text: effort, color: COLOR.danger }
    case 'max':
      return { text: effort, color: COLOR.danger, bold: true }
    default:
      return { text: String(effort), color: COLOR.muted }
  }
}

/** 输出 token 数 ÷ 首字到结束的秒数；缺一个时刻、跨度不为正或没有输出时算不出 */
export function tokensPerSecond(output: number | null | undefined, firstAt: number | null, stopAt: number | null): number | null {
  if (output == null || output <= 0 || firstAt === null || stopAt === null) return null
  const span = stopAt - firstAt
  return span > 0 ? Math.round(output / (span / 1000)) : null
}

// ---------------------------------------------------------------- 两行的文字

/** 分支、worktree 名、子目录各自最多占几格（设计稿：worktree 里的分支截成 20 格） */
const NAME_CELLS = 20

/** 几组之间空两格（设计稿 .ft） */
const GROUP_GAP = '  '

function opSegments(operation: GitOperation): Segment[] {
  const progress = operation.step !== undefined && operation.total !== undefined ? ` ${operation.step}/${operation.total}` : ''
  return [
    { text: `${ICON.pause} `, color: COLOR.high },
    { text: operation.name, color: COLOR.high, bold: true },
    ...(progress ? [{ text: progress, color: COLOR.high }] : []),
  ]
}

function spaced(groups: readonly Segment[][]): Segment[] {
  return groups.filter(group => group.length > 0).flatMap((group, index) => (index === 0 ? group : [{ text: GROUP_GAP }, ...group]))
}

/** 第一行：目录名、分支、停在一半的命令、各项计数和储藏、改动行数 */
export function gitLine(identity: Identity): Segment[] {
  const git = identity.git
  const dirIcon: Segment = { text: `${ICON.dir} `, color: COLOR.usage }
  if (!git) return [dirIcon, { text: identity.dir || '—', bold: true }]

  const dir: Segment[] = [dirIcon, { text: git.repo, bold: true }]
  if (git.worktree) dir.push({ text: ' ' }, { text: `${ICON.worktree} `, color: COLOR.dim }, { text: fit(git.worktree, NAME_CELLS) })
  if (git.sub) dir.push({ text: fit(`/${git.sub}`, NAME_CELLS), color: COLOR.muted })

  const branch: Segment[] = []
  if (git.branch !== null) branch.push({ text: `${ICON.branch} ${fit(git.branch, NAME_CELLS)}`, color: COLOR.branch })
  else if (git.commit !== null) branch.push({ text: `${ICON.detached} @${git.commit}`, color: COLOR.branch })
  if (branch.length > 0) {
    if (git.ahead > 0) branch.push({ text: ` ↑${git.ahead}`, color: COLOR.ahead })
    if (git.behind > 0) branch.push({ text: ` ↓${git.behind}`, color: COLOR.usage })
    if (git.noUpstream) branch.push({ text: ' 无上游', color: COLOR.dim })
  }

  const marks: (Segment | null)[] = [
    git.conflicts > 0 ? { text: `=${git.conflicts}`, color: COLOR.danger, bold: true } : null,
    git.staged > 0 ? { text: `+${git.staged}`, color: COLOR.ok } : null,
    git.modified > 0 ? { text: `!${git.modified}`, color: COLOR.ahead } : null,
    git.untracked > 0 ? { text: `?${git.untracked}`, color: COLOR.muted } : null,
    git.stashes > 0 ? { text: `${ICON.stash} ${git.stashes}`, color: COLOR.dim } : null,
  ]
  const counts: Segment[] = marks
    .filter((one): one is Segment => one !== null)
    .flatMap((one, index) => (index === 0 ? [one] : [{ text: ' ' }, one]))

  const lines = git.lines
  const changed: Segment[] =
    lines && lines.added + lines.deleted > 0
      ? [
          { text: `${ICON.lines} `, color: COLOR.dim },
          { text: `+${lines.added}`, color: COLOR.added },
          { text: ' ' },
          { text: `−${lines.deleted}`, color: COLOR.deleted },
        ]
      : []

  return spaced([dir, branch, git.operation ? opSegments(git.operation) : [], counts, changed])
}

/** 第二行：模型 · effort · tok/s；还没有的项不写 */
export function modelLine(identity: Identity): Segment[] {
  const parts: Segment[][] = []
  if (identity.model) parts.push([{ text: `${ICON.model} `, color: COLOR.dim }, { text: modelLabel(identity.model) }])
  if (identity.effort !== null) parts.push([effortSegment(identity.effort)])
  if (identity.tokensPerSecond !== null) parts.push([{ text: String(identity.tokensPerSecond) }, { text: ' tok/s', color: COLOR.muted }])
  return parts.flatMap((part, index) => (index === 0 ? part : [SEPARATOR, ...part]))
}

// ---------------------------------------------------------------- 绘制

type Els = Pick<Elements['terminal'], 'Box' | 'Text'>

function line(els: Els, key: string, segments: readonly Segment[], columns: number): RenderElement {
  const { Box, Text } = els
  // 左右各空 1 格（设计稿 .ft 的 padding），放不下的从行尾截
  const shown = fitSegments(segments, Math.max(0, columns - 2))
  return (
    <Box key={key} width={columns} flexShrink={0} paddingX={1}>
      <Text wrap="truncate">
        {shown.map(segment => (
          <Text color={segment.color} bold={segment.bold}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/** 交给面板的两行 */
export function identityRows(els: Els, identity: Identity, columns: number): RenderElement[] {
  return [line(els, 'identity:git', gitLine(identity), columns), line(els, 'identity:model', modelLine(identity), columns)]
}
