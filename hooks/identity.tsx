// 身份栏（spec D8）：面板最底的三行。第一行是目录名和 git 状态，第二行是模型和 effort，
// 第三行是主会话最近一次请求的输出速度、首字等待和整次用时。
// git 取法照用户原来的 ~/.claude/statusline.mjs（`--no-optional-locks`、分离 HEAD 写 `@提交号`、
// `@{u}` 领先落后、储藏数），改成一条 `status --porcelain=v2 --branch --show-stash` 取齐分支、上游、
// 领先落后、各项计数和储藏数；目录名、改动行数、停在一半的命令是 statusline 没有的，按 D8 加。
// token/s 照 .13 探针：首字是请求流里第一块不是 engine 的，结束是 stop 那块，只算主会话；
// 首字等待从请求开始算到首字，整次用时从请求开始算到 stop 那块。
// 只放不碰 `$` 的纯逻辑和界面组件；运行 git、读 git 目录和记请求时刻在 register.ts。

import type { Elements, RenderElement } from 'claude-code'

import type { GitOperation, GitView, Identity } from '../types'
import { formatDuration } from './cache'
import { COLOR, ICON, SEPARATOR, fitSegments } from './style'
import type { Segment } from './style'
import { cells, fit, padStart } from './text'

export const EMPTY_IDENTITY: Identity = { dir: '', git: null, model: null, effort: null, tokensPerSecond: null, firstTokenMs: null, requestMs: null }

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

// ---------------------------------------------------------------- 模型、effort、速度

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

/**
 * 会话开始、还没有请求时的 effort：从合并后的设置里取，当前模型自己的（modelSettings）优先，
 * 其次全局的 effortLevel；都没有时为 null。第一次主会话请求之后以请求带的为准。
 */
export function startEffort(settings: Readonly<Record<string, unknown>>, model: string | null): string | number | null {
  const level = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? value : null)
  const perModel = settings.modelSettings
  const own =
    model !== null && perModel !== null && typeof perModel === 'object'
      ? (perModel as Record<string, unknown>)[model]
      : undefined
  const ownLevel = own !== null && typeof own === 'object' ? level((own as Record<string, unknown>).effortLevel) : null
  return ownLevel ?? level(settings.effortLevel)
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
      return { text: String(effort), color: COLOR.secondary }
  }
}

/** 输出 token 数 ÷ 首字到结束的秒数；缺一个时刻、跨度不为正或没有输出时算不出 */
export function tokensPerSecond(output: number | null | undefined, firstAt: number | null, stopAt: number | null): number | null {
  if (output == null || output <= 0 || firstAt === null || stopAt === null) return null
  const span = stopAt - firstAt
  return span > 0 ? Math.round(output / (span / 1000)) : null
}

/** 秒数：不到 60 秒一位小数（12.7s），60 秒起按 D10 的时长写法（1m35s） */
export function formatSeconds(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100)
  return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : formatDuration(ms)
}

// ---------------------------------------------------------------- 三行的文字

/** 分支、worktree 名、子目录各自最多占几格（设计稿：worktree 里的分支截成 20 格）；整行放不下时再收到 10 格 */
const NAME_CELLS = 20
const NARROW_NAME_CELLS = 10

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
export function gitLine(identity: Identity, names: number = NAME_CELLS): Segment[] {
  const git = identity.git
  const dirIcon: Segment = { text: `${ICON.dir} `, color: COLOR.icon }
  if (!git) return [dirIcon, { text: identity.dir || '—', bold: true }]

  const dir: Segment[] = [dirIcon, { text: git.repo, bold: true }]
  if (git.worktree) dir.push({ text: ' ' }, { text: `${ICON.worktree} `, color: COLOR.icon }, { text: fit(git.worktree, names) })
  if (git.sub) dir.push({ text: fit(`/${git.sub}`, names), color: COLOR.secondary })

  const branch: Segment[] = []
  if (git.branch !== null) branch.push({ text: `${ICON.branch} ${fit(git.branch, names)}`, color: COLOR.branch })
  else if (git.commit !== null) branch.push({ text: `${ICON.detached} @${git.commit}`, color: COLOR.branch })
  if (branch.length > 0) {
    if (git.ahead > 0) branch.push({ text: ` ↑${git.ahead}`, color: COLOR.warn })
    if (git.behind > 0) branch.push({ text: ` ↓${git.behind}`, color: COLOR.warn })
    if (git.noUpstream) branch.push({ text: ' 无上游', color: COLOR.secondary })
  }

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

  return spaced([dir, branch, git.operation ? opSegments(git.operation) : [], counts, changed])
}

const joined = (parts: readonly Segment[][]) => parts.flatMap((part, index) => (index === 0 ? part : [SEPARATOR, ...part]))

/** 第二行：模型 · effort；还没有的项不写 */
export function modelLine(identity: Identity): Segment[] {
  const parts: Segment[][] = []
  if (identity.model) parts.push([{ text: `${ICON.model} `, color: COLOR.icon }, { text: modelLabel(identity.model) }])
  if (identity.effort !== null) parts.push([effortSegment(identity.effort)])
  return joined(parts)
}

/**
 * 后面还跟着字的数值右对齐到定宽，数字变长变短时后面的字不挪位置（spec §3）：
 * token/s 3 格（到 999），首字 5 格（12.7s、1m35s）；用时在行尾，不用补
 */
const SPEED_FIELD = { tokens: 3, seconds: 5 } as const

/** 第三行：N token/s · 首字 N s · 用时 N s；数值不着色，缺的项不写，还没有请求时写 — */
export function speedLine(identity: Identity): Segment[] {
  const icon: Segment = { text: `${ICON.speed} `, color: COLOR.icon }
  const parts: Segment[][] = []
  if (identity.tokensPerSecond !== null) parts.push([{ text: padStart(String(identity.tokensPerSecond), SPEED_FIELD.tokens) }, { text: ' token/s', color: COLOR.secondary }])
  if (identity.firstTokenMs !== null) parts.push([{ text: '首字 ', color: COLOR.secondary }, { text: padStart(formatSeconds(identity.firstTokenMs), SPEED_FIELD.seconds) }])
  if (identity.requestMs !== null) parts.push([{ text: '用时 ', color: COLOR.secondary }, { text: formatSeconds(identity.requestMs) }])
  return parts.length === 0 ? [icon, { text: '—' }] : [icon, ...joined(parts)]
}

// ---------------------------------------------------------------- 绘制

type Els = Pick<Elements['terminal'], 'Box' | 'Text'>

/**
 * 左边空 2 格：图标和框里的字（名称列、序号）从同一列起；右边空 1 格，和框的右边线对齐。
 * 三行都是"图标 内容"，图标都是图标色
 */
const PAD = { left: 2, right: 1 } as const

/** 一行里放得下的格数 */
const room = (columns: number) => Math.max(0, columns - PAD.left - PAD.right)

function line(els: Els, key: string, segments: readonly Segment[], columns: number): RenderElement {
  const { Box, Text } = els
  // 放不下的从行尾截
  const shown = fitSegments(segments, room(columns))
  return (
    <Box key={key} width={columns} flexShrink={0} paddingLeft={PAD.left} paddingRight={PAD.right}>
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

/** 交给面板的三行 */
export function identityRows(els: Els, identity: Identity, columns: number): RenderElement[] {
  // 名字长时先把名字截短，让后面的计数和行数留在行里；还放不下再从行尾截
  const full = gitLine(identity)
  const first = cells(full.map(segment => segment.text).join('')) <= room(columns) ? full : gitLine(identity, NARROW_NAME_CELLS)
  return [
    line(els, 'identity:git', first, columns),
    line(els, 'identity:model', modelLine(identity), columns),
    line(els, 'identity:speed', speedLine(identity), columns),
  ]
}
