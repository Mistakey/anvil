// 终端格子宽度：中日韩文字和全角符号占 2 格，其余（含 Nerd Font 图标）占 1 格。
// 输入框上方那一行按格子排版、截断，收尾那行的读数按它算起点，不交给引擎去裁。

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
