import type { On, PromptSubmitInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { hidesPanel } from '../hooks/panel'
import { SESSION, anvil, drain, panes, stepInput, turnInput, typed, world } from './world'

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
  expect(state.get('anvil.panelHidden')).toBe(false)
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
