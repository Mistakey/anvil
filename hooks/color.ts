// 真彩颜色的计算：在 OKLab 里插值，渐变不发灰、亮度均匀。进度条的热度用它；statusline 脚本里有同样的一份。

type Lab = readonly [number, number, number]

const parse = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)]
}

const toLinear = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const toGamma = (v: number) => {
  const c = Math.min(1, Math.max(0, v))
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
}

const cache = new Map<string, Lab>()

function lab(hex: string): Lab {
  const hit = cache.get(hex)
  if (hit) return hit
  const [r, g, b] = parse(hex).map(toLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const out: Lab = [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
  cache.set(hex, out)
  return out
}

function hex(value: Lab): string {
  const [L, a, b] = value
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return `#${rgb.map(v => Math.round(toGamma(v)).toString(16).padStart(2, '0')).join('')}`
}

/** 渐变的档数：插值的比例取到 1/16，相邻同色的格子并成一段，一条进度条只有几个节点 */
export const LEVELS = 16

const quantize = (t: number) => Math.round(Math.min(1, Math.max(0, t)) * LEVELS) / LEVELS

/** a 到 b 的 t 处（0 到 1，取到 1/16 档） */
export function mix(a: string, b: string, t: number): string {
  const k = quantize(t)
  if (k === 0) return a
  if (k === 1) return b
  const A = lab(a)
  const B = lab(b)
  return hex([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k])
}

/** 多段渐变：stops 的位置从小到大 */
export function gradient(stops: readonly (readonly [number, string])[], at: number): string {
  const first = stops[0]
  if (!first) return '#000000'
  if (at <= first[0]) return first[1]
  for (let i = 1; i < stops.length; i += 1) {
    const [p0, c0] = stops[i - 1] as readonly [number, string]
    const [p1, c1] = stops[i] as readonly [number, string]
    if (at <= p1) return mix(c0, c1, p1 > p0 ? (at - p0) / (p1 - p0) : 1)
  }
  return (stops[stops.length - 1] as readonly [number, string])[1]
}
