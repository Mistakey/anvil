// 终端格子宽度：中日韩文字和全角符号占 2 格，其余（含 Nerd Font 图标）占 1 格。
// 面板按格子排版，各列的宽度和截断都靠它算，不交给引擎去裁。

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 韩文字母
  [0x2e80, 0x303e], // 中日韩部首、标点
  [0x3041, 0x33ff], // 假名、中日韩符号
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本汉字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 韩文音节
  [0xf900, 0xfaff], // 兼容汉字
  [0xfe30, 0xfe4f], // 兼容形式
  [0xff00, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6], // 全角符号
  [0x20000, 0x3fffd], // 扩展 B 及以后
]

function cellsOf(codePoint: number): number {
  return WIDE.some(([from, to]) => codePoint >= from && codePoint <= to) ? 2 : 1
}

/** 字符串在终端里占的格数 */
export function cells(text: string): number {
  let total = 0
  for (const char of text) total += cellsOf(char.codePointAt(0) ?? 0)
  return total
}

/** 超出 width 格时截到 width 格以内，末尾换成 `…`；不超出原样返回 */
export function fit(text: string, width: number): string {
  if (cells(text) <= width) return text
  if (width <= 0) return ''
  let kept = ''
  let used = 0
  for (const char of text) {
    const next = cellsOf(char.codePointAt(0) ?? 0)
    if (used + next > width - 1) break
    kept += char
    used += next
  }
  return `${kept}…`
}

/**
 * 超出 width 格时从前面截，留下结尾、开头换成 `…`；不超出原样返回。
 * 分支、worktree 名区分彼此的部分多在结尾（task/anvil-k0t.46 → …k0t.46）
 */
export function fitTail(text: string, width: number): string {
  if (cells(text) <= width) return text
  if (width <= 1) return '…'
  let kept = ''
  let used = 0
  for (const char of [...text].reverse()) {
    const next = cellsOf(char.codePointAt(0) ?? 0)
    if (used + next > width - 1) break
    kept = char + kept
    used += next
  }
  return `…${kept}`
}

/** 右侧补空格到 width 格 */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cells(text)))
}

/** 左侧补空格到 width 格 */
export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - cells(text))) + text
}

const isWide = (char: string) => cellsOf(char.codePointAt(0) ?? 0) === 2

/** 一行字里最后一个能断开的位置（断在第 k 个字之前）：前一个是空格，或前后有一个是中文（全角）字；没有为 0 */
function lastBreak(chars: readonly string[]): number {
  for (let k = chars.length - 1; k > 0; k -= 1) {
    const before = chars[k - 1] ?? ''
    const after = chars[k] ?? ''
    if (before === ' ' || isWide(before) || isWide(after)) return k
  }
  return 0
}

/**
 * 按格子折成至多 maxLines 行，空白压成一个空格；放不下时最后一行末尾换成 `…`。
 * 中文逐字折，英文单词尽量不拆开（单词比一行还长时照样拆）。
 */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const one = text.replace(/\s+/g, ' ').trim()
  if (width <= 0 || maxLines <= 0 || one === '') return []
  const lines: string[] = []
  let rest = one
  while (rest !== '' && lines.length < maxLines) {
    if (cells(rest) <= width) {
      lines.push(rest)
      rest = ''
      break
    }
    let line = ''
    let used = 0
    let index = 0
    const chars = [...rest]
    while (index < chars.length) {
      const char = chars[index] ?? ''
      const size = cellsOf(char.codePointAt(0) ?? 0)
      if (used + size > width) break
      line += char
      used += size
      index += 1
    }
    // 断在英文单词中间时退回到上一个能断的地方：空格后面，或中文（全角）字的前后。
    // 只退到空格会把空格前的一大段中文也挤到下一行，上一行后半截空着（anvil-k0t.44）
    const next = chars[index] ?? ''
    const breaksWord = /\S/.test(next) && /[\x21-\x7e]$/.test(line) && /[\x21-\x7e]/.test(next)
    if (breaksWord) {
      const kept = chars.slice(0, index)
      const at = lastBreak(kept)
      if (at > 0) {
        index = at
        line = kept.slice(0, at).join('')
      }
    }
    lines.push(line.trimEnd())
    rest = chars.slice(index).join('').trimStart()
  }
  if (rest !== '' && lines.length > 0) {
    const last = lines.length - 1
    lines[last] = fit(`${lines[last]}${' '.repeat(width)}`, width).replace(/\s+…$/, '…')
  }
  return lines
}
