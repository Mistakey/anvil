import type { ClassicEventOf, ModelCompleteResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { contrast, mix } from '../hooks/color'
import { faultedModule, liveOf } from '../hooks/live'
import {
  BREATH,
  LIGHT,
  SPIN,
  beat,
  breath,
  breatheCells,
  catchUp,
  clockOf,
  envelope,
  glintCells,
  groove,
  isMoving,
  phaseOf,
  runs,
  settle,
  spinColor,
  spinGlyph,
  swell,
  wordCells,
} from '../hooks/motion'
import type { Beat, Pulse, Cell as Square } from '../hooks/motion'
import { PING_AFTER_MS } from '../hooks/keepalive'
import { COLOR, ICON } from '../hooks/style'
import { cells } from '../hooks/text'
import { SESSION, drain, flat, spawnInput, stepInput, turnInput, world } from './world'

const NOW = 10 * 3_600_000

const STEP = BREATH.stepMs

const SECOND = 1000

/** 进行中图标走一格：两拍 */
const TURN = SPIN.stepMs

/** 吸满的那一刻（一口气里） */
const PEAK = BREATH.cycleMs * BREATH.inhale

/** 静止细槽中间的颜色 */
const GROOVE_PEAK = '#4a4c51'

/** 从 clock 起走几拍到吸得最满的那一拍 */
const toPeak = (clock: number) => {
  const ticks = Array.from({ length: BREATH.cycleMs / STEP }, (_, k) => k)
  return ticks.reduce((best, k) => (breath(clock + k * STEP) > breath(clock + best * STEP) ? k : best), 0)
}

// ---------------------------------------------------------------- 纯逻辑（Client 模块共用，motion.ts）

test('节奏：帧时钟 110ms 一拍（同 flightdeck），一口气 2640ms 正好 24 拍；◐◓◑◒ 两拍一格，一口气转三圈', () => {
  expect(STEP).toBe(110)
  expect(BREATH.cycleMs / STEP).toBe(24)
  expect(SPIN.stepMs / STEP).toBe(2)
  expect(BREATH.cycleMs / (SPIN.stepMs * SPIN.frames.length)).toBe(3)
  expect([0, 220, 440, 660, 880].map(spinGlyph)).toEqual(['◐', '◓', '◑', '◒', '◐'])
  expect(spinGlyph(219)).toBe('◐')
  // 出现、消失、落定都是整拍
  for (const ms of [BREATH.inMs, BREATH.outMs, BREATH.settleMs]) expect(ms % STEP).toBe(0)
})

test('相位按绝对时刻算：每拍前进一样多（1/24），一口气之后回到原处；几处同一时刻同一相位', () => {
  for (const start of [0, NOW, NOW + 37]) {
    const phases = Array.from({ length: 49 }, (_, k) => phaseOf(start + k * STEP))
    for (let k = 1; k < phases.length; k += 1) {
      const step = ((phases[k] ?? 0) - (phases[k - 1] ?? 0) + 1) % 1
      expect(Math.abs(step - 1 / 24)).toBeLessThan(1e-9)
    }
    expect(breath(start + BREATH.cycleMs)).toBe(breath(start))
  }
})

test('呼吸：吸 40%、呼 60%，两头是缓的；每一拍都在变，不停住、不跳', () => {
  expect(breath(0)).toBe(0)
  expect(breath(PEAK)).toBe(1)
  // 吸气一路涨、呼气一路落
  const at = (t: number) => breath(t * BREATH.cycleMs)
  for (let t = 0; t < 0.38; t += 0.02) expect(at(t + 0.02) >= at(t), `${t}`).toBe(true)
  for (let t = 0.4; t < 0.98; t += 0.02) expect(at(t + 0.02) <= at(t), `${t}`).toBe(true)
  // 吸得比呼快：涨到一半在 20%，落回一半在 70%
  expect(Math.abs(at(0.2) - 0.5)).toBeLessThan(1e-9)
  expect(Math.abs(at(0.7) - 0.5)).toBeLessThan(1e-9)
  // 逐拍：每拍都不一样（不停住），相邻两拍差得不多（不跳）
  const levels = Array.from({ length: 25 }, (_, k) => breath(NOW + k * STEP))
  for (let k = 1; k < levels.length; k += 1) {
    const d = Math.abs((levels[k] ?? 0) - (levels[k - 1] ?? 0))
    expect(d, `${k}`).toBeGreaterThan(0)
    expect(d, `${k}`).toBeLessThan(0.2)
  }
})

test('沿线的明暗：中间最亮、往两边暗，吸气时铺开变亮，呼尽时收拢但不灭', () => {
  const width = 51
  const center = width / 2
  // 呼尽：最亮处还有 0.62，两端几乎是 0
  expect(swell(25, center, width, 0)).toBeGreaterThan(0.6)
  expect(swell(0, center, width, 0)).toBeLessThan(0.02)
  // 吸满：最亮处到 1，两端也亮起来
  expect(swell(25, center, width, 1)).toBeGreaterThan(0.99)
  expect(swell(0, center, width, 1)).toBeGreaterThan(0.1)
  // 左右对称
  expect(swell(10, center, width, 0.5)).toBe(swell(40, center, width, 0.5))
})

test('出现、消失、落定：440ms 亮起，结束后 660ms 暗下去、落定，之后不再动', () => {
  expect(envelope(0, 0, null)).toBe(0)
  expect(envelope(BREATH.inMs, 0, null)).toBe(1)
  expect(envelope(5000, null, null)).toBe(1)
  expect(envelope(5000, 0, 5000)).toBe(1)
  expect(envelope(5000 + BREATH.outMs, 0, 5000)).toBe(0)
  expect(isMoving(5000 + BREATH.outMs - 1, 5000)).toBe(true)
  expect(isMoving(5000 + BREATH.outMs, 5000)).toBe(false)
  expect(settle(5000, null)).toBe(0)
  expect(settle(5000, 5000)).toBe(1)
  expect(settle(5000 + BREATH.settleMs / 2, 5000)).toBeGreaterThan(0)
  expect(settle(5000 + BREATH.settleMs, 5000)).toBe(0)
})

test('细槽：中间略亮、两端隐进面板底色，左右对称；不承载信息，比线暗', () => {
  const line = groove(51, COLOR.pane)
  expect(line).toHaveLength(51)
  expect(line.every(cell => cell.ch === '─')).toBe(true)
  const at = (x: number) => contrast(line[x]?.color ?? COLOR.pane, COLOR.pane)
  expect(at(25)).toBeGreaterThan(at(0))
  expect(at(0)).toBeLessThan(1.1)
  expect(at(10)).toBe(at(40))
  expect(at(25)).toBeLessThan(contrast(COLOR.line, COLOR.pane))
})

test('细槽上的呼吸：呼尽时中间留短短一截亮橙的粗线；吸满时粗线铺开、光芯最亮，两头用 ╼ ╾ 接回细线', () => {
  for (const width of [51, 70]) {
    const base = groove(width, COLOR.pane)
    // 还没亮起来
    expect(breatheCells(base, PEAK, 0)).toEqual(base)
    // 呼尽：中间三四格粗线，比 Claude 橙亮，两端还是细槽
    const low = breatheCells(base, 0, 1)
    expect(low.map(cell => cell.ch).join(''), `${width}`).toMatch(/^─+╼━{2,6}╾─+$/)
    const mid = Math.floor(width / 2)
    expect(contrast(low[mid]?.color ?? '', COLOR.pane)).toBeGreaterThan(contrast(LIGHT.body, COLOR.pane))
    expect(low[0]?.color).toBe(base[0]?.color)
    // 吸满：中间一大段粗线，两头接口，宽度不变
    const high = breatheCells(base, PEAK, 1)
    const glyphs = high.map(cell => cell.ch).join('')
    expect(glyphs, `${width}`).toMatch(/^─+╼━{20,}╾─+$/)
    expect(cells(glyphs)).toBe(width)
    expect(high[mid]?.color).toBe(LIGHT.core)
    // 左右对称：明暗按位置
    expect(high[5]?.color).toBe(high[width - 6]?.color)
    // 吸满时比呼尽时铺得开：亮过 Claude 橙的格子多
    const lit = (line: Square[]) => line.filter(cell => contrast(cell.color ?? COLOR.pane, COLOR.pane) >= contrast(LIGHT.body, COLOR.pane)).length
    expect(lit(high)).toBeGreaterThan(lit(low) + 10)
  }
})

test('翻译框上边框的呼吸：从标题后面亮起、往右渐暗，字形不变，标题不碰', () => {
  const line: Square[] = [
    ...[...'── '].map(ch => ({ ch, color: COLOR.promptLine })),
    ...[...'中→英'].map(ch => ({ ch, bold: true })),
    ...[...` ${'─'.repeat(40)}`].map(ch => ({ ch, color: COLOR.promptLine })),
  ]
  const lit = glintCells(line, PEAK, 1, '#bdbdbd', 7)
  expect(lit.map(cell => cell.ch)).toEqual(line.map(cell => cell.ch))
  expect(lit.slice(3, 6)).toEqual(line.slice(3, 6))
  expect(lit[7]?.color).toBe('#bdbdbd')
  expect(contrast(lit[7]?.color ?? '', '#282a36')).toBeGreaterThan(contrast(lit[40]?.color ?? '', '#282a36'))
  expect(glintCells(line, PEAK, 0, '#bdbdbd', 7)).toEqual(line)
})

test('字上的呼吸：从中间亮起、往两头渐暗，吸满时比呼尽时亮；之外是本色', () => {
  const word: Square[] = [...'Opus 5.5'].map(ch => ({ ch, color: LIGHT.body }))
  expect(wordCells(word, PEAK, 0, LIGHT.core)).toEqual(word)
  const high = wordCells(word, PEAK, 1, LIGHT.core)
  const low = wordCells(word, 0, 1, LIGHT.core)
  const light = (cell: Square | undefined) => contrast(cell?.color ?? COLOR.pane, COLOR.pane)
  expect(light(high[4])).toBeGreaterThan(light(high[0]))
  expect(light(high[4])).toBeGreaterThan(light(low[4]))
  expect(light(high[0])).toBeGreaterThan(light(low[0]))
  // 呼尽时中间也比本色亮一点：一直在发光
  expect(light(low[4])).toBeGreaterThan(light(word[4]))
})

test('进行中图标：Claude 橙，吸满时亮到光芯', () => {
  expect(spinColor(0)).toBe(LIGHT.body)
  expect(spinColor(PEAK)).toBe(LIGHT.core)
})

test('颜色在 OKLab 里插值、取到 1/16 档；相邻同色的格子并成一段', () => {
  expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
  expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
  expect(mix('#000000', '#ffffff', 0.5)).toBe(mix('#000000', '#ffffff', 0.51))
  expect(runs([{ ch: 'a', color: '#111111' }, { ch: 'b', color: '#111111' }, { ch: 'c' }])).toEqual([{ ch: 'ab', color: '#111111' }, { ch: 'c' }])
})

test('计时照 flightdeck：挂载时起一次，之后每拍加一拍；再画（新的 now）不清零、不重起，只换要不要重画', () => {
  const timers: (() => void)[] = []
  const redraws: number[] = []
  const surface = {
    state: undefined as { ref: Beat } | undefined,
    setState(next: { ref: Beat }) {
      surface.state = next
      redraws.push(clockOf(next.ref, STEP))
    },
    every(ms: number, fn: () => void) {
      expect(ms).toBe(STEP)
      timers.push(fn)
      return () => undefined
    },
  }
  const tick = () => timers.forEach(fn => fn())
  let until: number | null = null
  const ref = beat(surface, NOW, STEP, clock => isMoving(clock, until))
  expect(timers).toHaveLength(1)
  expect(clockOf(ref, STEP)).toBe(NOW)
  tick()
  tick()
  tick()
  expect(clockOf(ref, STEP)).toBe(NOW + 3 * STEP)
  // 钩子重画给了新的 now：不清零、不重起
  const again = beat(surface, NOW + 5000, STEP, clock => isMoving(clock, until))
  expect(again).toBe(ref)
  expect(timers).toHaveLength(1)
  expect(clockOf(ref, STEP)).toBe(NOW + 3 * STEP)
  tick()
  expect(clockOf(ref, STEP)).toBe(NOW + 4 * STEP)
  // 结束了：暗完之后照样计拍，但不再重画
  until = NOW + 4 * STEP
  beat(surface, NOW + 6000, STEP, clock => isMoving(clock, until))
  const before = redraws.length
  for (let k = 0; k < 10; k += 1) tick()
  expect(redraws.length - before).toBe(BREATH.outMs / STEP - 1)
  expect(clockOf(ref, STEP)).toBe(NOW + 14 * STEP)
})

/** 造一个 Client 的 surface：every 记下计时，tick() 走一拍 */
function fakeSurface() {
  const timers: (() => void)[] = []
  const surface = {
    state: undefined as { ref: Beat } | undefined,
    setState(next: { ref: Beat }) {
      surface.state = next
    },
    every(_ms: number, fn: () => void) {
      timers.push(fn)
      return () => undefined
    },
  }
  return { surface, tick: () => timers.forEach(fn => fn()), timers }
}

test('跟墙上时钟对拍：落后整口气一次补上，剩下的一拍一拍追（多走一拍或这一拍不走），不跳', () => {
  const cycle = BREATH.cycleMs / STEP
  expect(catchUp(0, cycle)).toBe(1)
  // 落后一拍：这一拍走两拍；超前一拍：这一拍不走
  expect(catchUp(1, cycle)).toBe(2)
  expect(catchUp(-1, cycle)).toBe(0)
  // 引擎卡了 27 拍：整口气（24 拍）一次补上，相位不变，再多走一拍，剩下的下几拍追
  expect(catchUp(27, cycle)).toBe(1 + 24 + 1)
})

test('真实会话里几个 Client 共用一个拍子：同一帧照抄，跟着墙上时钟不漂；引擎卡过也一拍一拍追上', () => {
  // 墙上时钟（真实会话里钩子的 now 和它是同一个时钟）
  const T0 = 1_760_000_000_000
  let wall = T0
  const p: Pulse = { tick: 0, wall: Number.NEGATIVE_INFINITY }
  const a = fakeSurface()
  const b = fakeSurface()
  const ra = beat(a.surface, T0, STEP, () => true, () => wall, p)
  // 挂载：拍子停着，直接从墙上时刻起
  expect(ra.wall).not.toBe(null)
  expect(clockOf(ra, STEP)).toBe(Math.round(T0 / STEP) * STEP)
  // 帧时钟比 110ms 慢（伪终端实测约 123ms 一拍）：一直跟着墙上时钟，差不过一拍；每拍至多多走一拍
  let last = clockOf(ra, STEP)
  for (let k = 0; k < 200; k += 1) {
    wall += 123
    a.tick()
    const clock = clockOf(ra, STEP)
    expect(clock - last, `${k}`).toBeLessThanOrEqual(2 * STEP)
    expect(clock - last, `${k}`).toBeGreaterThanOrEqual(STEP)
    expect(Math.abs(clock - wall), `${k}`).toBeLessThanOrEqual(STEP)
    last = clock
  }
  // 后挂载的 Client（钩子的 now 是几秒前画面板时的）：和在走的同一拍
  const rb = beat(b.surface, wall - 3000, STEP, () => true, () => wall, p)
  expect(clockOf(rb, STEP)).toBe(clockOf(ra, STEP))
  // 同一帧里两个都走：先走的定下这一拍，后走的照抄
  for (let k = 0; k < 50; k += 1) {
    wall += 123
    a.tick()
    wall += 3
    b.tick()
    expect(clockOf(rb, STEP), `${k}`).toBe(clockOf(ra, STEP))
  }
  // 引擎卡了 3 秒：相位不跳（这一拍至多多走一拍，整口气的部分看不出），十来拍之内追上
  last = clockOf(ra, STEP)
  wall += 3000
  a.tick()
  const step = (((phaseOf(clockOf(ra, STEP)) - phaseOf(last)) % 1) + 1) % 1
  expect(step).toBeLessThanOrEqual(2 / 24 + 1e-9)
  for (let k = 0; k < 12; k += 1) {
    wall += 123
    a.tick()
  }
  expect(Math.abs(clockOf(ra, STEP) - wall)).toBeLessThanOrEqual(STEP)

  // 耗时：墙上的第几秒，钩子重画给的 now 不管
  const c = fakeSurface()
  const rc = beat(c.surface, wall, SECOND, () => true, () => wall, p)
  expect(clockOf(rc, SECOND)).toBe(Math.floor(wall / SECOND) * SECOND)
  wall += 2500
  c.tick()
  expect(clockOf(rc, SECOND)).toBe(Math.floor(wall / SECOND) * SECOND)

  // plugin test 的假时钟（钩子的 now 和墙上时钟差得远）：不校正，一拍走一拍
  const d = fakeSurface()
  const rd = beat(d.surface, NOW, STEP, () => true, () => wall, p)
  expect(rd.wall).toBe(null)
  d.tick()
  expect(clockOf(rd, STEP)).toBe(NOW + STEP)
})

test('有 Client、模块没出过错才用它；ui.fault 报的路径按文件名认', () => {
  const els = { Client: () => null }
  const all = { now: 5, spinner: true, elapsed: true, rail: true, glow: true }
  expect(liveOf(els, 'terminal', 5, [])).toEqual(all)
  expect(liveOf(els, 'desktop', 5, [])).toEqual(all)
  expect(liveOf(els, 'terminal', 5, ['rail.tsx', 'glow.tsx'])).toEqual({ ...all, rail: false, glow: false })
  expect(liveOf({}, 'terminal', 5, [])).toEqual({ now: 5, spinner: false, elapsed: false, rail: false, glow: false })
  // VS Code 的 resolve 也给 Client，但它的元素表里没有，画出来是空的
  expect(liveOf(els, 'vscode', 5, [])).toEqual({ now: 5, spinner: false, elapsed: false, rail: false, glow: false })
  expect(faultedModule('hooks/rail.tsx')).toBe('rail.tsx')
  expect(faultedModule('hooks\\glow.tsx')).toBe('glow.tsx')
  expect(faultedModule('./spinner.tsx')).toBe('spinner.tsx')
  expect(faultedModule('hooks/other.tsx')).toBe(null)
})

// ---------------------------------------------------------------- 面板里的动效

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, ...w }
}

const sized = (columns: number) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
})

/** VS Code 的元素表没有 Client */
const vscode = (columns: number) => ({ ...sized(columns), surface: 'vscode' as const })

/** 一行里各段字和它的颜色（Text 嵌套时沿用外层的颜色） */
function textsOf(node: unknown, inherited?: unknown): { text: string; color?: unknown }[] {
  if (node === null || typeof node !== 'object') return []
  const { type, props, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const color = type === 'Text' && props?.color !== undefined ? props.color : inherited
  const kids = children ?? (props?.children as unknown[] | undefined) ?? []
  const own = kids.filter((kid): kid is string => typeof kid === 'string').join('')
  const nested = kids.filter(kid => typeof kid !== 'string').flatMap(kid => textsOf(kid, color))
  return type === 'Text' && own !== '' ? [{ text: own, color }, ...nested] : nested
}

/** 回复中：第二轮的第一次请求已经开始、还没结束 */
async function replying($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await clock.advance(1000)
  await drain($.turn.step(stepInput()))
}

test('框与框之间是一道细槽（不是空行、也不是线）；没有东西在发生时面板上一个 Client 都没有', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [50, 70, 90]) {
    const ui = await $.ui.mount(sized(columns))
    for (const id of ['usage', 'messages']) {
      const gap = await ui.find({ key: `gap:${id}` })
      expect(gap?.props, `${columns} 列 ${id}`).toMatchObject({ width: columns, height: 1 })
      expect(flat(gap)).toBe('─'.repeat(columns))
      // 两端隐进底色，中间略亮
      const colors = textsOf(gap).map(one => one.color)
      expect(colors[0]).toBe(COLOR.pane)
      expect(new Set(colors).size).toBeGreaterThan(2)
    }
    // 缓存框上面没有细槽
    expect(await ui.find({ key: 'gap:cache' })).toBeUndefined()
    expect(await ui.findAll({ type: 'Client' })).toEqual([])
    expect(flat(await ui.find({ key: 'identity:speed' }))).toBe(`${ICON.speed} —`)
    await ui.unmount()
  }
})

test('主会话回复中：细槽、模型名、速度行的图标一起呼吸，几处同相；钩子重画不清零、不重起', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await replying($, clock)
  const since = NOW + 1000
  await clock.advance(500)
  const now = since + 500
  const ui = await $.ui.mount(sized(70))
  // 细槽：rail.tsx，带回复开始的时刻和画的时刻，没有相位零点、行号
  const rail = await ui.find({ key: 'rail:usage' })
  expect(rail?.props).toMatchObject({ module: 'hooks/rail.tsx', width: 70, props: { now, since, width: 70 } })
  expect(Object.keys((rail?.props.props as object) ?? {}).sort()).toEqual(['now', 'since', 'width'])

  // 走到吸得最满的那一拍：细槽中段是粗线，宽度不变；两道细槽同一时刻画得一模一样（同相）
  await ui.advance(toPeak(now) * STEP)
  const drawn = flat(await ui.drawn({ in: 'rail:usage' }))
  expect(drawn).toMatch(/^─+╼━+╾─+$/)
  expect(cells(drawn)).toBe(70)
  expect(textsOf(await ui.drawn({ in: 'rail:messages' }))).toEqual(textsOf(await ui.drawn({ in: 'rail:usage' })))

  // 模型名：glow.tsx，lit 是 Claude 橙，亮的一档是光芯
  const model = await ui.find({ key: 'glow:model' })
  expect(model?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'breathe', lit: LIGHT.body, shine: LIGHT.core, now, since } })
  expect(flat(await ui.drawn({ in: 'glow:model' }))).toBe('Opus 5.5')

  // 速度行：转动的 ◐，颜色跟着呼吸；读数退到次要色
  const spin = await ui.find({ key: 'spin:speed' })
  expect(spin?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1, props: { now } })
  const at = now + toPeak(now) * STEP
  expect(textsOf(await ui.drawn({ in: 'spin:speed' }))).toEqual([{ text: spinGlyph(at), color: spinColor(at) }])
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(at + TURN))
  const numbers = textsOf(await ui.find({ key: 'identity:speed' })).filter(one => /\d|—/.test(one.text))
  expect(numbers.length).toBeGreaterThan(0)
  for (const one of numbers) expect(one.color, one.text).toBe(COLOR.secondary)

  // 钩子过了 5 秒才重画：Client 照自己的拍子接着走，不跳到新的 now
  await clock.advance(5000)
  await ui.redraw()
  expect(((await ui.find({ key: 'spin:speed' }))?.props.props as { now: number }).now).toBe(now + 5000)
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(at + TURN))
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(at + 2 * TURN))

  // 一口气之后回到原样：周期固定
  const first = textsOf(await ui.drawn({ in: 'rail:usage' }))
  await ui.advance(BREATH.cycleMs)
  expect(textsOf(await ui.drawn({ in: 'rail:usage' }))).toEqual(first)
  await ui.unmount()
})

test('回复结束：细槽暗下去，模型名落回正文色，新的读数和闪电图标从微光色落回原色；落定后一个 Client 都不剩', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await replying($, clock)
  await clock.advance(2000)
  await $.turn.complete(turnInput())
  const ended = NOW + 3000
  const ui = await $.ui.mount(sized(70))
  expect(await ui.find({ key: 'spin:speed' })).toBeUndefined()
  // 速度行整行交给 glow.tsx 落定：闪电和读数标了 lit
  const speed = await ui.find({ key: 'glow:speed' })
  expect(speed?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'flash', shine: LIGHT.shine, until: ended } })
  const lit = (speed?.props.props as { cells: Square[] }).cells
  expect(lit[0]).toMatchObject({ ch: ICON.speed, color: COLOR.icon, lit: true })
  expect(lit.filter(cell => cell.lit && /\d|—/.test(cell.ch)).length).toBeGreaterThan(0)
  expect(lit.filter(cell => cell.lit && cell.color !== undefined && cell.ch !== ICON.speed)).toEqual([])
  // 刚结束：读数是微光色
  const first = textsOf(await ui.drawn({ in: 'glow:speed' }))
  expect(first[0]).toMatchObject({ text: ICON.speed, color: LIGHT.shine })
  // 模型名、细槽还在落定、暗下去
  expect((await ui.find({ key: 'glow:model' }))?.props).toMatchObject({ props: { until: ended } })
  expect((await ui.find({ key: 'rail:usage' }))?.props).toMatchObject({ props: { until: ended } })
  // Client 自己走完落定：画回原色
  await ui.advance(BREATH.settleMs + STEP)
  const settled = textsOf(await ui.drawn({ in: 'glow:speed' }))
  expect(settled[0]).toMatchObject({ text: ICON.speed, color: COLOR.icon })
  expect(textsOf(await ui.drawn({ in: 'glow:model' })).map(one => one.color)).toEqual([undefined])
  // 面板下一次重画：一个 Client 都不剩，读数正文色
  await clock.advance(1000)
  await ui.redraw()
  expect(await ui.findAll({ type: 'Client' })).toEqual([])
  const after = textsOf(await ui.find({ key: 'identity:speed' }))
  expect(after[0]).toMatchObject({ text: ICON.speed, color: COLOR.icon })
  for (const one of after.filter(item => /\d|—/.test(item.text))) expect(one.color, one.text).toBeUndefined()
  await ui.unmount()
})

test('子 agent 的回复不算主会话在回复', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput({ agentId: 'ag1' })))
  const ui = await $.ui.mount(sized(70))
  expect(await ui.find({ key: 'spin:speed' })).toBeUndefined()
  expect(await ui.find({ key: 'rail:usage' })).toBeUndefined()
  await ui.unmount()
})

test('子 agent 运行中：状态列的 ◐ 转动、任务跟着呼吸亮暗、耗时每秒走；结束后固定', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await clock.advance(5000)
  const ui = await $.ui.mount(sized(70))
  // 压在 Button 的状态列（"1: " 之后）、任务一列和耗时一列（右对齐 6 格）上
  expect((await ui.find({ key: 'over:mark:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 3 })
  expect((await ui.find({ key: 'over:task:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 6 })
  expect((await ui.find({ key: 'over:time:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 70 - 4 - 6 })
  expect((await ui.find({ key: 'spin:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1, props: { now: NOW + 5000 } })
  expect((await ui.find({ key: 'glow:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'breathe', shine: LIGHT.shine, since: NOW } })
  expect(flat(await ui.drawn({ in: 'glow:agent:ag1' }))).toBe('核对读数')
  expect((await ui.find({ key: 'clock:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/elapsed.tsx', width: 6 })

  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(NOW + 5000))
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    5s')
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(NOW + 5000 + TURN))
  await ui.advance(1000 - TURN)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    6s')
  await ui.advance(60_000)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe(' 1m06s')
  // Button 里照样有静止的 ◐ 和按面板重画时算的耗时，写法和列宽不变
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)

  await clock.advance(2000)
  await $.turn.complete(turnInput({ agentId: 'ag1' }))
  await ui.redraw()
  expect(await ui.find({ key: 'spin:agent:ag1' })).toBeUndefined()
  expect(await ui.find({ key: 'glow:agent:ag1' })).toBeUndefined()
  expect(await ui.find({ key: 'clock:agent:ag1' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^\u{F00C} +核对读数 +Sonnet +7s$/u)
  await ui.unmount()
})

test('缓存框保活：续期请求在路上时"进行中"跟着呼吸亮暗、后面接转动的 ◐，请求结束就去掉', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  // 排在 world 的 fork 之前：这一次续期请求停在路上，放行后读到整段缓存
  on('model.fork', {}, async () => {
    await gate
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 40 } } }
  })
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await clock.advance(PING_AFTER_MS)

  const ui = await $.ui.mount(sized(70))
  const glow = await ui.find({ key: 'glow:keepalive' })
  const now = NOW + PING_AFTER_MS
  expect(glow?.props).toMatchObject({ module: 'hooks/glow.tsx', props: { mode: 'breathe', shine: LIGHT.shine, now, since: now } })
  expect(flat(await ui.drawn({ in: 'glow:keepalive' }))).toBe('进行中')
  expect((await ui.find({ key: 'spin:keepalive' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', props: { now } })
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(now))
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(now + TURN))

  release()
  await clock.settle()
  await ui.redraw()
  expect(await ui.find({ key: 'spin:keepalive' })).toBeUndefined()
  expect(await ui.find({ key: 'glow:keepalive' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'row:keepalive' }))).toBe('保活进行中')
  await ui.unmount()
})

// ---------------------------------------------------------------- 翻译框

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('翻译框正在翻译：上边框从标题后面亮起、"正在翻译"跟着呼吸亮暗、◐ 原地转动，后面的字不动', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  on('model.complete', async () => {
    await gate
    const value: ModelCompleteResult = { isAnswered: true, text: 'Make it async.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    return { value }
  })
  const { clock } = engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const input = await ui.find({ type: 'Input' })
  await ui.input({ key: input?.key ?? '', text: '把函数改成异步的' })
  await clock.settle()
  await ui.redraw()
  // 上边框：rail.tsx 的 glint，带着整条线（标题加粗、不上色）、亮一档的线色和最亮处（标题后面那一格）
  const line = await ui.find({ key: 'line:translate' })
  expect(line?.props).toMatchObject({ module: 'hooks/rail.tsx', width: 120, props: { tint: '#bdbdbd', center: 3 + cells(`${ICON.translate} 中→英`) + 1 } })
  const rule = (line?.props.props as { cells: Square[] }).cells
  expect(rule.map(cell => cell.ch).join('')).toMatch(/^── .* ─+$/)
  expect(cells(flat(await ui.drawn({ in: 'line:translate' })))).toBe(120)
  // 状态：◐ 和"正在翻译"都是 Client
  expect(flat(await ui.drawn({ in: 'glow:translate' }))).toBe(' 正在翻译')
  const spin = await ui.find({ key: 'spin:translate' })
  expect(spin?.props).toMatchObject({ module: 'hooks/spinner.tsx' })
  const props = spin?.props.props as { now: number }
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(props.now))
  await ui.advance(TURN)
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(props.now + TURN))
  release()
  await ui.unmount()
})

// ---------------------------------------------------------------- 退路：没有 Client、Client 出错

async function stillPanel($: Engine, ui: Mounted<'terminal', 'Pane'> | Mounted<'vscode', 'Pane'>, columns: number) {
  // 一个 Client 都没有
  expect(await ui.findAll({ type: 'Client' })).toEqual([])
  // 框间是静止的细槽
  expect(flat(await ui.find({ key: 'gap:usage' }))).toBe('─'.repeat(columns))
  // 运行中的子 agent：Button 里静止的 ◐ 和按 now 算的耗时
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)
}

test('没有 Client 的界面：◐ 静止、耗时随面板重画更新；回复中模型名直接是 Claude 橙、速度行是静止的 ◐', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput()))
  await clock.advance(5000)
  const ui = await $.ui.mount(vscode(70))
  await stillPanel($, ui, 70)
  expect(flat(await ui.find({ key: 'identity:speed' }))).toMatch(/^◐/)
  expect(textsOf(await ui.find({ key: 'identity:model' })).find(one => one.text === 'Opus 5.5')?.color).toBe(LIGHT.body)
  await clock.advance(3000)
  await ui.redraw()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +8s$/)
  await ui.unmount()
})

// Client 出错的退路：plugin test 的 `$` 没有 ui.fault，造不出这个事件（AGENTS.md Pitfalls）；
// 出错的模块不再用、退回静止由上面的 liveOf 单测核对，接线在交互会话里验证

// ---------------------------------------------------------------- 框

test('四个彩框：标题识别色加粗；侧边是识别色调暗的一档；上边框从标题处的光渐暗到侧边。我的消息中性', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  const denied: ClassicEventOf['classic.PermissionDenied'] = {
    session_id: 's1',
    transcript_path: '/work/s1.jsonl',
    cwd: '/work',
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf dir' },
    tool_use_id: 'deny1',
    reason: 'classifier',
  }
  await $.classic.PermissionDenied(denied)
  const ui = await $.ui.mount(sized(70))
  const sections: [string, string, string, string][] = [
    ['cache', '缓存', COLOR.cache, COLOR.cacheLine],
    ['usage', '用量', COLOR.usage, COLOR.usageLine],
    ['agents', '子 agent', COLOR.agents, COLOR.agentsLine],
    ['denials', '自动模式拒绝', COLOR.denials, COLOR.denialsLine],
    ['messages', '我的消息', COLOR.messages, COLOR.messagesLine],
  ]
  const texts = await ui.findAll({ type: 'Text' })
  for (const [id, title, color, border] of sections) {
    expect((await ui.find({ key: `box:${id}` }))?.props.borderColor, id).toBe(border)
    // 上边框整行压在框的第一行上：两角是侧边的颜色，标题后面最亮，往右渐暗到侧边
    const edge = await ui.find({ key: `edge:section:${id}` })
    expect(edge?.props, id).toMatchObject({ position: 'absolute', top: 0, left: 0 })
    const line = textsOf(edge)
    expect(line.map(one => one.text).join(''), id).toMatch(/^╭─+╮$/)
    expect(line[0]?.color, id).toBe(border)
    expect(line[line.length - 1]?.color, id).toBe(border)
    const lit = line.slice(1, -1).map(one => contrast(String(one.color), COLOR.pane))
    expect(Math.max(...lit), id).toBeGreaterThan(contrast(border, COLOR.pane) + 1)
    if (id === 'messages') continue
    const head = texts.filter(one => (one.text ?? '').endsWith(title))
    expect(head.length, id).toBeGreaterThan(0)
    for (const one of head) expect(one.props, id).toMatchObject({ color, bold: true })
  }
  await ui.unmount()
})
