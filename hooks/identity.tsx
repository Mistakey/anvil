// 身份栏（spec D8）：面板最底的三行。第一行是目录名和 git 状态，第二行是模型和 effort，
// 第三行是主会话最近一次请求的输出速度、首字等待和整次用时。
// git 取法照用户原来的 ~/.claude/statusline.mjs（`--no-optional-locks`、分离 HEAD 写 `@提交号`、
// `@{u}` 领先落后、储藏数），改成一条 `status --porcelain=v2 --branch --show-stash` 取齐分支、上游、
// 领先落后、各项计数和储藏数；目录名、改动行数、停在一半的命令是 statusline 没有的，按 D8 加。
// token/s 照 .51 探针：首字是响应的第一块（引擎的信封也算），结束是 stop 那块，只算主会话；
// 思考不出正文，只隔一阵来一个空的 thinking 块，有时整段思考只在结尾来一个，跳过 engine 块会把思考的时间漏掉。
// 首字等待从请求开始算到首字，整次用时从请求开始算到 stop 那块。
// 只放不碰 `$` 的纯逻辑和界面组件；运行 git、读 git 目录和记请求时刻在 register.ts。

import type { Elements, RenderElement } from 'claude-code'

import type { GitOperation, GitView, Identity } from '../types'
import { formatDuration } from './cache'
import { glowText, isLive, spin, still, toCells } from './live'
import type { Live, Span } from './live'
import { LIGHT } from './motion'
import type { Cell } from './motion'
import { COLOR, ICON, SEPARATOR, fitSegments } from './style'
import type { Segment } from './style'
import { cells, fitTail, padStart } from './text'

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

/**
 * 比这还快的不是流出来的，是整段一起到的：.51 探针里真流出来的 Opus 5.5 是 55–107、Haiku 5.5 是 189–247 token/s，
 * 整段一起到的算出来是 1980–9229
 */
const STREAM_CEILING = 1000

/**
 * 输出 token 数（含思考）÷ 首字到结束的秒数；整段一起到（快过 STREAM_CEILING）或没有首字时退回 ÷ 整次用时，
 * 只会偏低不会偏高。没有结束、跨度不为正或没有输出时算不出
 */
export function tokensPerSecond(output: number | null | undefined, startAt: number, firstAt: number | null, stopAt: number | null): number | null {
  if (output == null || output <= 0 || stopAt === null) return null
  const perSecond = (from: number) => (stopAt > from ? output / ((stopAt - from) / 1000) : null)
  const streamed = firstAt === null ? null : perSecond(firstAt)
  const speed = streamed !== null && streamed <= STREAM_CEILING ? streamed : perSecond(startAt)
  return speed === null ? null : Math.round(speed)
}

/** 秒数：不到 60 秒一位小数（12.7s），60 秒起按 D10 的时长写法（1m35s） */
export function formatSeconds(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100)
  return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : formatDuration(ms)
}

// ---------------------------------------------------------------- 三行的文字

/**
 * 分支、worktree 名、子目录各自最多占几格（设计稿：worktree 里的分支截成 20 格）。
 * 整行放不下时名字让位给计数：几个名字平分剩下的格子，每个至少 NAME_MIN 格（anvil-k0t.46）
 */
const NAME_CELLS = 20
const NAME_MIN = 4
const NAME_ROOMY = 8

/** 几组之间空两格（设计稿 .ft）；放不下时收成一格 */
const GROUP_GAP = 2
const NARROW_GAP = 1

function opSegments(operation: GitOperation): Segment[] {
  const progress = operation.step !== undefined && operation.total !== undefined ? ` ${operation.step}/${operation.total}` : ''
  return [
    { text: `${ICON.pause} `, color: COLOR.high },
    { text: operation.name, color: COLOR.high, bold: true },
    ...(progress ? [{ text: progress, color: COLOR.high }] : []),
  ]
}

function spaced(groups: readonly Segment[][], gap: number): Segment[] {
  return groups.filter(group => group.length > 0).flatMap((group, index) => (index === 0 ? group : [{ text: ' '.repeat(gap) }, ...group]))
}

/** 第一行：目录名、分支、停在一半的命令、各项计数和储藏、改动行数 */
export function gitLine(identity: Identity, names: number = NAME_CELLS, gap: number = GROUP_GAP): Segment[] {
  const git = identity.git
  const dirIcon: Segment = { text: `${ICON.dir} `, color: COLOR.icon }
  if (!git) return [dirIcon, { text: identity.dir || '—', bold: true }]

  const dir: Segment[] = [dirIcon, { text: git.repo, bold: true }]
  if (git.worktree) dir.push({ text: ' ' }, { text: `${ICON.worktree} `, color: COLOR.icon }, { text: fitTail(git.worktree, names) })
  if (git.sub) dir.push({ text: fitTail(`/${git.sub}`, names), color: COLOR.secondary })

  const branch: Segment[] = []
  if (git.branch !== null) branch.push({ text: `${ICON.branch} ${fitTail(git.branch, names)}`, color: COLOR.branch })
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

  return spaced([dir, branch, git.operation ? opSegments(git.operation) : [], counts, changed], gap)
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

/**
 * 第三行（不含行首的图标，图标在 identityRows 里画）：N token/s · 首字 N s · 用时 N s；缺的项不写，还没有请求时写 —。
 * 数值正文色、标签次要色；replying 时数值也退到次要色：那是上一次请求的读数，这一次结束就换（anvil-k0t.46）
 */
export function speedLine(identity: Identity, replying = false): Segment[] {
  const value = (text: string): Segment => (replying ? { text, color: COLOR.secondary } : { text })
  const parts: Segment[][] = []
  if (identity.tokensPerSecond !== null) parts.push([value(padStart(String(identity.tokensPerSecond), SPEED_FIELD.tokens)), { text: ' token/s', color: COLOR.secondary }])
  if (identity.firstTokenMs !== null) parts.push([{ text: '首字 ', color: COLOR.secondary }, value(padStart(formatSeconds(identity.firstTokenMs), SPEED_FIELD.seconds))])
  if (identity.requestMs !== null) parts.push([{ text: '用时 ', color: COLOR.secondary }, value(formatSeconds(identity.requestMs))])
  return parts.length === 0 ? [value('—')] : joined(parts)
}

// ---------------------------------------------------------------- 绘制

type Els = Pick<Elements['terminal'], 'Box' | 'Text'> & Partial<Pick<Elements['terminal'], 'Client'>>

/**
 * 左边空 2 格：图标和框里的字（名称列、序号）从同一列起；右边空 1 格，和框的右边线对齐。
 * 三行都是"图标 内容"，图标都是图标色
 */
const PAD = { left: 2, right: 1 } as const

/** 一行里放得下的格数 */
const room = (columns: number) => Math.max(0, columns - PAD.left - PAD.right)

/** 一行；lead 是画在最前面的一格图标（速度行的图标回复中换成转动的 ◐），后面空一格 */
function line(els: Els, key: string, segments: readonly Segment[], columns: number, lead?: RenderElement): RenderElement {
  const { Box, Text } = els
  // 放不下的从行尾截
  const shown = fitSegments(segments, room(columns) - (lead ? 2 : 0))
  return (
    <Box key={key} width={columns} flexShrink={0} paddingLeft={PAD.left} paddingRight={PAD.right}>
      {lead ? (
        <Box key={`lead:${key}`} width={2} flexShrink={0}>
          {lead}
          <Text> </Text>
        </Box>
      ) : null}
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

const widthOf = (segments: readonly Segment[]) => cells(segments.map(segment => segment.text).join(''))

/** 第一行里名字（worktree 名、分支、子目录）有几个 */
function nameCount(identity: Identity): number {
  const git = identity.git
  if (!git) return 0
  return (git.worktree ? 1 : 0) + (git.sub ? 1 : 0) + (git.branch !== null ? 1 : 0)
}

/**
 * 第一行：名字长时先把名字截短（从前面截，留下结尾），让后面的计数和行数留在行里：
 * 几个名字平分剩下的格子；每个分不到 NAME_ROOMY 格时组间距收成一格再分，每个至少 NAME_MIN 格；还放不下再从行尾截
 */
export function fittedGitLine(identity: Identity, columns: number): Segment[] {
  const full = gitLine(identity)
  const count = nameCount(identity)
  if (widthOf(full) <= room(columns) || count === 0) return full
  // 名字收成一格（"…"）时的宽度，就是名字以外的部分
  const share = (gap: number) => Math.floor((room(columns) - (widthOf(gitLine(identity, 1, gap)) - count)) / count)
  const gap = share(GROUP_GAP) >= NAME_ROOMY ? GROUP_GAP : NARROW_GAP
  return gitLine(identity, Math.max(NAME_MIN, share(gap)), gap)
}

/** 几段字逐格拆开；values：正文色的字（读数）标 lit，落定时跟着从微光色落回来 */
function cellsOf(segments: readonly Segment[], values = false): Cell[] {
  return segments.flatMap(segment =>
    toCells(segment.text, segment.color, segment.bold).map(cell => (values && segment.color === undefined && cell.ch.trim() ? { ...cell, lit: true } : cell)),
  )
}

/**
 * 交给面板的三行（spec D10「呼吸」）。reply 是主会话这一次回复的起止：
 * - 回复中：模型名从正文色渐变成 Claude 橙，跟着呼吸从中间亮到光芯再暗回；速度行的图标换成转动的 ◐，上一次的读数退到次要色；
 * - 回复结束：模型名落回正文色，新的读数和闪电图标从 Claude 的微光色落回原色（660ms）。
 */
export function identityRows(els: Els, identity: Identity, columns: number, view: { reply?: Span | null; live?: Live } = {}): RenderElement[] {
  const { Box, Text } = els
  const reply = view.reply ?? null
  const live = view.live ?? still(0)
  const replying = reply !== null && reply.until === null
  const moving = isLive(reply, live.now)
  const git = line(els, 'identity:git', fittedGitLine(identity, columns), columns)

  // 第二行：模型名回复中发光
  const model = modelLine(identity)
  const named = identity.model ? modelLabel(identity.model) : ''
  const at = model.findIndex(segment => segment.text === named)
  const second =
    moving && named !== '' && at >= 0 ? (
      <Box key="identity:model" width={columns} flexShrink={0} paddingLeft={PAD.left} paddingRight={PAD.right}>
        <Text>{model.slice(0, at).map(segment => <Text color={segment.color} bold={segment.bold}>{segment.text}</Text>)}</Text>
        {glowText(els, live, { key: 'glow:model', cells: toCells(named), span: reply, mode: 'breathe', shine: LIGHT.core, lit: LIGHT.body })}
        <Text wrap="truncate">{model.slice(at + 1).map(segment => <Text color={segment.color} bold={segment.bold}>{segment.text}</Text>)}</Text>
      </Box>
    ) : (
      line(els, 'identity:model', model, columns)
    )

  // 第三行：回复中图标转动、读数退后；结束后整行落定
  const speed = fitSegments(speedLine(identity, replying), room(columns) - 2)
  let third: RenderElement
  if (replying) third = line(els, 'identity:speed', speed, columns, spin(els, live, { key: 'spin:speed' }))
  else if (moving) {
    third = (
      <Box key="identity:speed" width={columns} flexShrink={0} paddingLeft={PAD.left} paddingRight={PAD.right}>
        {glowText(els, live, {
          key: 'glow:speed',
          cells: [{ ch: ICON.speed, color: COLOR.icon, lit: true }, { ch: ' ' }, ...cellsOf(speed, true)],
          span: reply,
          mode: 'flash',
          shine: LIGHT.shine,
        })}
      </Box>
    )
  } else third = line(els, 'identity:speed', speed, columns, <Text color={COLOR.icon}>{ICON.speed}</Text>)
  return [git, second, third]
}
