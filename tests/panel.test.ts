import type { On, PromptSubmitInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { hidesPanel } from '../hooks/panel'
import { SESSION, anvil, panes, typed, world } from './world'

const OPEN = { id: 'anvil', title: 'anvil', columns: 70 }

// 提交消息时插件之下的引擎：消息照常进入会话
function engine(on: On) {
  mock.clock(on)
  world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return panes(on)
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

test('/anvil panel hide 关掉面板，本会话不再自动打开；show 重新打开', async ($, on) => {
  const { opens, closes, screen } = engine(on)
  await $.session.start(SESSION)

  const hidden = await $.command.run(anvil('panel hide'))
  expect(hidden.text).toContain('已隐藏 anvil 面板')
  expect(closes).toEqual(['anvil'])

  // 提交消息、重新加载（session.start 再来一次）都不再自动打开
  screen.placed = false
  await $.prompt.submit(typed('继续'))
  await $.session.start(SESSION)
  expect(opens).toHaveLength(1)

  screen.placed = true
  const shown = await $.command.run(anvil(' panel  show '))
  expect(shown.text).toBe('已显示 anvil 面板。')
  expect(opens).toEqual([OPEN, OPEN])
})

test('show 时引擎放不下面板，说明原因', async ($, on) => {
  const { screen } = engine(on)
  screen.placed = false
  await $.session.start(SESSION)

  const shown = await $.command.run(anvil('panel show'))
  expect(shown.text).toBe('anvil 面板暂时放不下：终端 120 列，不到 144 列')
})

// plugin test 的 `$` 没有 ui.close，测试也不能冒充用户关（origin 由引擎盖章，改了会被拒）：
// 关闭来源的判断用纯函数测，接线由交互会话验证
test('用户手动关掉面板等同 hide；anvil 自己关和卸载时的关闭不算', () => {
  expect(hidesPanel({ kind: 'person' })).toBe(true)
  expect(hidesPanel({ kind: 'plugin' })).toBe(false)
  expect(hidesPanel({ kind: 'unload' })).toBe(false)
})

test('/anvil 列出 panel 子命令；panel 后面的词不对时给出用法', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)

  expect((await $.command.run(anvil(''))).text).toBe(
    ['用法：/anvil <子命令>', '  /anvil panel hide|show  在当前会话隐藏或显示 anvil 面板'].join('\n'),
  )
  expect((await $.command.run(anvil('panel up'))).text).toBe('用法：/anvil panel hide|show')
})
