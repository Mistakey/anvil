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

/** 右侧补空格到 width 格 */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cells(text)))
}

/** 左侧补空格到 width 格 */
export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - cells(text))) + text
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
    // 断在英文单词中间时退回到上一个空格
    const next = chars[index] ?? ''
    const breaksWord = /\S/.test(next) && /[\x21-\x7e]$/.test(line) && /[\x21-\x7e]/.test(next)
    const space = line.lastIndexOf(' ')
    if (breaksWord && space > 0) {
      index = [...line.slice(0, space)].length + 1
      line = line.slice(0, space)
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
