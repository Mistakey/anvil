import type { ClassicEventOf, On, PromptSubmitInput, SessionAppendInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, FoundElement, Mounted } from 'claude-code/testing'

import { hidesPanel } from '../hooks/panel'
import { SESSION, anvil, drain, panes, spawnInput, stepInput, turnInput, typed, world } from './world'

const OPEN = { id: 'anvil', title: 'anvil', columns: 70 }

function engine(on: On) {
  mock.clock(on)
  const { state } = world(on)
  return { ...panes(on), state }
}

test('会话开始时自己打开面板，请求约 70 列，Esc 不关面板', async ($, on) => {
  const { opens } = engine(on)
  await $.session.start(SESSION)

  expect(opens).toEqual([OPEN])
})

test('宽度门槛没放下时，用户下一次提交消息时再开一次', async ($, on) => {
  const { opens, screen } = engine(on)
  screen.placed = false
  await $.session.start(SESSION)
  expect(opens).toHaveLength(1)

  // 用户提交的这次算用户请求，引擎放下了
  screen.placed = true
  await $.prompt.submit(typed('继续'))
  expect(opens).toEqual([OPEN, OPEN])

  // 已经放下了，之后的提交不再开
  await $.prompt.submit(typed('再来'))
  expect(opens).toHaveLength(2)
})

test('不是用户自己提交的消息（后台通知等）不触发再开', async ($, on) => {
  const { opens, screen } = engine(on)
  screen.placed = false
  await $.session.start(SESSION)

  const notice: PromptSubmitInput = { text: '任务完成', wait: false, origin: { kind: 'task-notification' } }
  await $.prompt.submit(notice)
  expect(opens).toHaveLength(1)
})

test('/anvil panel 切换：隐藏后本会话不再自动打开，再敲一次重新打开；新会话回到显示', async ($, on) => {
  const { opens, closes, screen, state } = engine(on)
  await $.session.start(SESSION)
  expect(state.get('anvil.panelHidden'), '新会话不带隐藏').toBe(undefined)

  const hidden = await $.command.run(anvil('panel'))
  expect(hidden.text).toBe('面板已隐藏（本会话）')
  expect(closes).toEqual(['anvil'])
  expect(state.get('anvil.panelHidden')).toBe(true)

  // 提交消息、重新加载（session.start 再来一次）都不再自动打开
  screen.placed = false
  await $.prompt.submit(typed('继续'))
  await $.session.start(SESSION)
  expect(opens).toHaveLength(1)

  screen.placed = true
  const shown = await $.command.run(anvil(' panel '))
  expect(shown.text).toBe('面板已显示')
  expect(opens).toEqual([OPEN, OPEN])
  expect(state.get('anvil.panelHidden'), '切回默认：按 /config').toBe(null)
})

test('/config 关掉面板：会话开始不打开、提交消息不补开，/anvil panel 在本会话打开，再敲一次回到隐藏', { options: { showPanel: false } }, async ($, on) => {
  const { opens, closes, screen, state } = engine(on)
  await $.session.start(SESSION)
  expect(opens).toEqual([])
  // 重新加载时面板可能还开着（刚在 /config 里关掉），收起
  expect(closes).toEqual(['anvil'])

  screen.placed = false
  await $.prompt.submit(typed('继续'))
  expect(opens).toEqual([])
  expect((await $.command.run(anvil(''))).text).toMatch(/^ {2}\/anvil panel +显示或隐藏 anvil 面板（现在：隐藏）$/m)

  screen.placed = true
  expect((await $.command.run(anvil('panel'))).text).toBe('面板已显示（本会话）')
  expect(opens).toEqual([OPEN])
  expect(state.get('anvil.panelHidden')).toBe(false)
  expect((await $.command.run(anvil(''))).text).toMatch(/^ {2}\/anvil panel +显示或隐藏 anvil 面板（现在：显示）$/m)

  expect((await $.command.run(anvil('panel'))).text).toBe('面板已隐藏')
  expect(state.get('anvil.panelHidden'), '切回默认：按 /config').toBe(null)
})

test('切换到显示时引擎放不下面板，说明原因', async ($, on) => {
  const { screen } = engine(on)
  screen.placed = false
  await $.session.start(SESSION)

  await $.command.run(anvil('panel'))
  const shown = await $.command.run(anvil('panel'))
  expect(shown.text).toBe('面板已显示，但暂时放不下：终端 120 列，不到 144 列')
})

// plugin test 的 `$` 没有 ui.close，测试也不能冒充用户关（origin 由引擎盖章，改了会被拒）：
// 关闭来源的判断用纯函数测，接线由交互会话验证
test('用户手动关掉面板等同隐藏；anvil 自己关和卸载时的关闭不算', () => {
  expect(hidesPanel({ kind: 'person' })).toBe(true)
  expect(hidesPanel({ kind: 'plugin' })).toBe(false)
  expect(hidesPanel({ kind: 'unload' })).toBe(false)
})

test('/anvil 列出 panel 子命令；旧写法 hide|show 按未知子命令处理', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)

  // 其余功能的子命令也在列表里，这里只看 panel 那一行
  const list = (await $.command.run(anvil(''))).text ?? ''
  expect(list).toStartWith('用法：/anvil <子命令>')
  expect(list).toMatch(/^ {2}\/anvil panel +显示或隐藏 anvil 面板（现在：显示）$/m)
  expect((await $.command.run(anvil('panel hide'))).text).toStartWith('没有子命令 panel hide。')
  expect((await $.command.run(anvil('panel show'))).text).toStartWith('没有子命令 panel show。')
})

test('守卫拦下这条消息时，面板照样补开（先补开面板，再过守卫）', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * 3_600_000 })
  world(on)
  const { opens, screen } = panes(on)
  screen.placed = false
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await clock.advance(2 * 3_600_000)

  screen.placed = true
  const first = await $.prompt.submit(typed('继续'))
  expect(first.drop).toMatch(/^anvil：缓存已过期/)
  expect(opens).toEqual([OPEN, OPEN])
})
const PANE_70 = {
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
}

// 真实终端只画带边框 Box 之后的兄弟节点压在边框上的字，画不出它里面绝对定位到边框行的字（.13 第 6 项、.17 实测）；
// plugin test 不经过 Ink 的绘制，这里只核对结构
test('标题和右上角状态是带边框的框之后的兄弟节点，绝对定位压在上边框那一行', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对缓存读数'))
  const ui = await $.ui.mount(PANE_70)
  const keys = (await ui.findAll({ type: 'Box' })).map(one => one.key)
  for (const [id, title] of [['messages', '我的消息'], ['agents', '子 agent'], ['usage', '用量'], ['cache', '缓存']]) {
    expect((await ui.find({ key: `box:${id}` }))?.props.borderStyle).toBe('round')
    // 标题不在带边框的框里面，在它后面
    expect(flat(await ui.find({ key: `box:${id}` }))).not.toContain(` ${title} `)
    expect(keys.indexOf(`title:section:${id}`), id).toBeGreaterThan(keys.indexOf(`box:${id}`))
    const head = await ui.find({ key: `title:section:${id}` })
    expect(head?.props).toMatchObject({ position: 'absolute', top: 0, left: 2 })
    expect(flat(head)).toContain(title)
  }
  // 子 agent 的右上角计数也压在边框上
  expect((await ui.find({ key: 'status:section:agents' }))?.props).toMatchObject({ position: 'absolute', top: 0, right: 2 })
  await ui.unmount()
})

function flat(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flat).join('')
  if (node !== null && typeof node === 'object') {
    const { children, props } = node as { children?: unknown; props?: { children?: unknown } }
    return flat(children ?? props?.children ?? [])
  }
  return ''
}

// ---------------------------------------------------------------- 排版（spec D7、D8、D10）

type DeniedInput = ClassicEventOf['classic.PermissionDenied']

let denials = 0
/** 自动模式的分类器拒绝了一次调用 */
const denied = (command: string): DeniedInput => ({
  session_id: 's1',
  transcript_path: '/work/s1.jsonl',
  cwd: '/work',
  hook_event_name: 'PermissionDenied',
  tool_name: 'Bash',
  tool_input: { command },
  tool_use_id: `deny${++denials}`,
  reason: 'classifier',
})

let rows = 0
/** 用户在主输入框发出的一条消息进了对话 */
const appended = (text: string): SessionAppendInput =>
  ({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: `u${++rows}`,
  }) as SessionAppendInput

/** 一次绘制：宽 columns 列、高 bodyRows 行 */
const sized = (columns: number, bodyRows = 48, isFocused = false) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view: {} },
})

function layoutEngine(on: On) {
  const clock = mock.clock(on, { now: 10 * 3_600_000 })
  world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock }
}

async function addAgents($: Engine, count: number) {
  for (let n = 0; n < count; n += 1) await $.agent.spawn(spawnInput(`任务 ${n + 1}`))
}

async function addDenials($: Engine, count: number) {
  for (let n = 0; n < count; n += 1) await $.classic.PermissionDenied(denied(`rm -rf dir${n + 1}`))
}

async function addMessages($: Engine, count: number) {
  for (let n = 0; n < count; n += 1) await $.session.append(appended(`第 ${n + 1} 条`))
}

type Child = { props?: { key?: string; height?: number } }
const children = (node: FoundElement | undefined): Child[] =>
  (node?.children ?? []).filter((one): one is Child => typeof one === 'object' && one !== null)

/** 面板自上而下的区块和身份栏，按画出来的顺序 */
async function order(ui: Mounted<'terminal', 'Pane'>) {
  const keys = (await ui.findAll({ type: 'Box' })).map(one => one.key ?? '')
  return keys.filter(key => /^section:[a-z]+$/.test(key) || key.startsWith('identity:')).map(key => key.replace(/^section:/, ''))
}

/** 一个区块占的行数：框是框里的行（两行的消息占 2 行）加上下边框，收成一行的是 1，没画是 0 */
async function heightOf(ui: Mounted<'terminal', 'Pane'>, id: string) {
  const box = await ui.find({ key: `box:${id}` })
  if (box) return children(box).reduce((sum, one) => sum + (one.props?.height ?? 1), 0) + 2
  return (await ui.find({ key: `section:${id}` })) ? 1 : 0
}

/** 整个面板占的行数：各区块、区块之间的空行，加上身份栏的三行 */
async function totalHeight(ui: Mounted<'terminal', 'Pane'>) {
  let total = 0
  for (const id of ['cache', 'usage', 'agents', 'denials', 'messages']) total += await heightOf(ui, id)
  const boxes = await ui.findAll({ type: 'Box' })
  const lines = boxes.filter(one => one.key?.startsWith('identity:') || one.key?.startsWith('gap:'))
  return total + lines.length
}

// 面板内宽：开着别的面板时约 50 列，请求的 70 列，拖宽后 90 列
const PANEL_WIDTHS = [50, 70, 90]

test('框与框之间是一行细槽（不是空行），我的消息和身份栏之间没有', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 1)
  await addDenials($, 1)
  for (const expanded of [false, true]) {
    const ui = await $.ui.mount(sized(70))
    if (expanded) await ui.press({ key: 'list:agents' })
    const keys = (await ui.findAll({ type: 'Box' }))
      .map(one => one.key ?? '')
      .filter(key => /^section:[a-z]+$/.test(key) || key.startsWith('gap:') || key.startsWith('identity:'))
    expect(keys, String(expanded)).toEqual([
      'section:cache',
      'gap:usage',
      'section:usage',
      'gap:agents',
      'section:agents',
      'gap:denials',
      'section:denials',
      'gap:messages',
      'section:messages',
      'identity:git',
      'identity:model',
      'identity:speed',
    ])
    const gap = await ui.find({ key: 'gap:usage' })
    expect(gap?.props.height).toBe(1)
    expect(flat(gap)).toBe('─'.repeat(70))
    await ui.unmount()
  }
})

test('终端上 50、70、90 列：全文没有 tok/s、≈、已重建、压缩、上一条', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '摘要', toolUses: [] }] })
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await addMessages($, 2)
  for (const columns of PANEL_WIDTHS) {
    const ui = await $.ui.mount(sized(columns))
    const all = flat(await ui.find({ type: 'Box' }))
    for (const word of ['tok/s', '≈', '已重建', '压缩', '上一条', '…']) expect(all, `${columns} 列 ${word}`).not.toContain(word)
    await ui.unmount()
  }
})

test('框宽按面板内宽：50、70、90 列下五个框和框里的每一行都不超出面板', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 2)
  await addDenials($, 2)
  await addMessages($, 3)
  await $.session.append(appended('很长的一条消息，'.repeat(20)))
  for (const columns of PANEL_WIDTHS) {
    const ui = await $.ui.mount(sized(columns))
    for (const one of await ui.findAll({ type: 'Box' })) {
      const width = one.props.width
      if (typeof width === 'number') expect(width <= columns, `${columns} 列 ${one.key}`).toBe(true)
    }
    for (const id of ['cache', 'usage', 'agents', 'denials', 'messages']) {
      const box = await ui.find({ key: `box:${id}` })
      expect(box?.props.width, `${columns} 列 ${id}`).toBe(columns)
      for (const row of children(box)) {
        const width = (row.props as { width?: unknown } | undefined)?.width
        if (typeof width === 'number') expect(width <= columns - 4, `${columns} 列 ${row.props?.key}`).toBe(true)
      }
    }
    await ui.unmount()
  }
})

test('自上而下：缓存、用量、子 agent、自动模式拒绝、我的消息，身份栏在最底三行', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 2)
  await addDenials($, 2)
  await addMessages($, 2)
  for (const columns of PANEL_WIDTHS) {
    const ui = await $.ui.mount(sized(columns))
    expect(await order(ui), `${columns} 列`).toEqual(['cache', 'usage', 'agents', 'denials', 'messages', 'identity:git', 'identity:model', 'identity:speed'])
    // 内容都短、放得下：哪个区块都没有截断
    for (const id of ['cache', 'usage', 'agents', 'denials', 'messages']) {
      expect(flat(await ui.find({ key: `section:${id}` })), `${columns} 列 ${id}`).not.toContain('…')
    }
    await ui.unmount()
  }
})

test('子 agent、自动模式拒绝在本会话还没有内容时整个框不画；我的消息一直画，没有消息时一行提示', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  for (const columns of PANEL_WIDTHS) {
    const ui = await $.ui.mount(sized(columns))
    expect(await order(ui), `${columns} 列`).toEqual(['cache', 'usage', 'messages', 'identity:git', 'identity:model', 'identity:speed'])
    expect(await ui.find({ key: 'section:agents' })).toBeUndefined()
    expect(await ui.find({ key: 'section:denials' })).toBeUndefined()
    expect(await ui.find({ key: 'list:agents' })).toBeUndefined()
    const messages = await ui.find({ key: 'box:messages' })
    expect(children(messages)).toHaveLength(1)
    expect(flat(messages)).toContain('本会话还没有发过消息')
    await ui.unmount()
  }

  // 有了第一个子 agent 才画子 agent 框；拒绝框照样不画
  await addAgents($, 1)
  const ui = await $.ui.mount(sized(70))
  expect(await order(ui)).toEqual(['cache', 'usage', 'agents', 'messages', 'identity:git', 'identity:model', 'identity:speed'])
  await ui.unmount()
})

test('子 agent、自动模式拒绝的框高固定：1 条和 10 条一样高，最多显示最近 3 条，更早的收进顶部一行', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 1)
  await addDenials($, 1)
  await addMessages($, 3)
  const heights = async () => {
    const found: Record<string, number> = {}
    for (const columns of PANEL_WIDTHS) {
      const ui = await $.ui.mount(sized(columns))
      found[`agents ${columns}`] = await heightOf(ui, 'agents')
      found[`denials ${columns}`] = await heightOf(ui, 'denials')
      found[`total ${columns}`] = await totalHeight(ui)
      await ui.unmount()
    }
    return found
  }
  const one = await heights()
  await addAgents($, 9)
  await addDenials($, 9)
  const ten = await heights()
  expect(ten).toEqual(one)
  // 顶部一行加最近 3 条，再加上下边框
  expect(one['agents 70']).toBe(6)
  expect(one['denials 70']).toBe(6)

  const ui = await $.ui.mount(sized(70))
  expect(flat(await ui.find({ key: 'row:earlier:agents' }))).toBe(' ▴ 更早的 7 个 · 按 a 展开')
  expect(flat(await ui.find({ key: 'row:earlier:denials' }))).toBe('    ▴ 更早的 7 条 · 按 d 展开')
  expect(await ui.find({ key: 'agent:7' })).toBeUndefined()
  for (const seq of [8, 9, 10]) expect(await ui.find({ key: `agent:${seq}` }), `第 ${seq} 个`).toBeDefined()
  await ui.unmount()
})

test('只有 1 条时它画在框里第一行，下面留空到固定高度', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 1)
  const ui = await $.ui.mount(sized(70))
  const rows = children(await ui.find({ key: 'box:agents' }))
  expect(rows).toHaveLength(4)
  expect(rows[0]?.props?.key).toBe('row:agent:ag1')
  expect(rows.slice(1).every(row => flat(row).trim() === '')).toBe(true)
  await ui.unmount()
})

test('我的消息占满剩余高度，身份栏贴底：各区块加身份栏正好是面板的行数', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 5)
  await addDenials($, 2)
  await addMessages($, 60)
  for (const columns of PANEL_WIDTHS) {
    // 40 行：我的消息恰好剩 2 行（"更早的"一行加最新一条），再矮就放不下最新一条（用量框项间空行多占 3 行）
    for (const bodyRows of [40, 48]) {
      const ui = await $.ui.mount(sized(columns, bodyRows))
      expect(await totalHeight(ui), `${columns} 列 ${bodyRows} 行`).toBe(bodyRows)
      // 最新的一条在最下面
      const last = children(await ui.find({ key: 'box:messages' })).at(-1)
      expect(flat(last)).toContain('第 60 条')
      await ui.unmount()
    }
  }
})

test('面板矮、最新一条消息有两行时：先收成一行，还放不下就不画"更早的"，身份栏不被挤出面板', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 2)
  await addDenials($, 3)
  for (let n = 0; n < 4; n += 1) await $.session.append(appended(`第 ${n + 1} 条：${'这是一条很长的消息，用来把我的消息撑成两行。'.repeat(4)}`))
  for (const columns of PANEL_WIDTHS) {
    // 39 行：别的区块和身份栏占 36 行，我的消息只剩 1 行；40 行剩 2 行；41 行剩 3 行，放得下"更早的"加两行的最新一条
    for (const [bodyRows, lines] of [[39, 1], [40, 2], [41, 3]] as const) {
      const ui = await $.ui.mount(sized(columns, bodyRows))
      expect(await totalHeight(ui), `${columns} 列 ${bodyRows} 行`).toBe(bodyRows)
      expect(await order(ui), `${columns} 列 ${bodyRows} 行`).toEqual(['cache', 'usage', 'agents', 'denials', 'messages', 'identity:git', 'identity:model', 'identity:speed'])
      const rows = children(await ui.find({ key: 'box:messages' }))
      expect(rows.reduce((sum, one) => sum + (one.props?.height ?? 1), 0), `${columns} 列 ${bodyRows} 行`).toBe(lines)
      expect(flat(rows.at(-1))).toContain('第 4 条')
      expect(flat(rows[0]).includes('更早的'), `${columns} 列 ${bodyRows} 行`).toBe(bodyRows > 39)
      await ui.unmount()
    }
  }
})

test('消息少时我的消息框也拉高到底：框可伸长、面板至少和可见高度一样高', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount(sized(70, 40))
  expect((await ui.find({ key: 'section:messages' }))?.props.flexGrow).toBe(1)
  expect((await ui.find({ key: 'box:messages' }))?.props.flexGrow).toBe(1)
  const root = (await ui.findAll({ type: 'Box' }))[0]
  expect(root?.props.minHeight).toBe(40)
  await ui.unmount()
})

test('按 a 展开子 agent：用我的消息让出的空间，其余收成一行；Esc 收起后回到固定高度', async ($, on) => {
  const { clock } = layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 10)
  await addDenials($, 4)
  await addMessages($, 3)
  const before = await $.ui.mount(sized(70, 48, true))
  const fixed = await heightOf(before, 'agents')
  const total = await totalHeight(before)
  await before.unmount()

  const ui = await $.ui.mount(sized(70, 48, true))
  await ui.press({ key: 'list:agents' })
  expect(await order(ui)).toEqual(['cache', 'usage', 'agents', 'denials', 'messages', 'identity:git', 'identity:model', 'identity:speed'])
  expect(await heightOf(ui, 'denials')).toBe(1)
  expect(await heightOf(ui, 'messages')).toBe(1)
  // 十个都放得下，全显示
  expect(await ui.find({ key: 'agent:1' })).toBeDefined()
  expect(await heightOf(ui, 'agents')).toBeGreaterThan(fixed)

  // Esc 不经过 mod：面板以失去焦点重画，画完收起
  await ui.redraw(sized(70, 48, false).props)
  await clock.advance(0)
  await ui.redraw(sized(70, 48, false).props)
  expect(await heightOf(ui, 'agents')).toBe(fixed)
  expect(await totalHeight(ui)).toBe(total)
  await ui.unmount()
})

test('按序号键展开一个子 agent 的详情时框临时长高，再按收起后回到固定高度', async ($, on) => {
  layoutEngine(on)
  await $.session.start(SESSION)
  await addAgents($, 5)
  await addMessages($, 3)
  const ui = await $.ui.mount(sized(70, 48, true))
  const fixed = await heightOf(ui, 'agents')
  await ui.press({ key: 'agent:5' })
  expect(await heightOf(ui, 'agents')).toBeGreaterThan(fixed)
  // 收起时的那几条不变，详情接在它下面
  for (const seq of [3, 4, 5]) expect(await ui.find({ key: `agent:${seq}` }), `第 ${seq} 个`).toBeDefined()
  await ui.press({ key: 'agent:5' })
  expect(await heightOf(ui, 'agents')).toBe(fixed)
  await ui.unmount()
})
