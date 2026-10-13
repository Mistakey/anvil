import { expect, test } from 'claude-code/testing'

import { answer } from '../hooks/command'
import type { Subcommand } from '../hooks/command'
import { SESSION, anvil, world } from './world'

test('会话开始时注册 /anvil', async ($, on) => {
  const { commands } = world(on)
  await $.session.start(SESSION)

  expect(commands).toEqual(['anvil'])
})

test('/anvil 不带子命令时列出可用的子命令', async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  const { text } = await $.command.run(anvil(''))
  expect(text).toStartWith('用法：/anvil <子命令>')
})

test('/anvil 带未知子命令时说明并列出可用的子命令', async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  const { text } = await $.command.run(anvil('nope'))
  expect(text).toStartWith('没有子命令 nope。\n用法：/anvil <子命令>')
})

// 列表规则用两个样例子命令验证；真实的子命令说明由各功能模块交出
const SAMPLES: Subcommand[] = [
  { name: 'panel', args: ['hide', 'show'], summary: '在当前会话隐藏或显示 anvil 面板' },
  { name: 'keepalive', args: ['off', 'on'], summary: '在当前会话关闭或恢复缓存保活' },
]

const LIST = [
  '用法：/anvil <子命令>',
  '  /anvil panel hide|show   在当前会话隐藏或显示 anvil 面板',
  '  /anvil keepalive off|on  在当前会话关闭或恢复缓存保活',
].join('\n')

test('不带子命令时按顺序列出子命令和说明', () => {
  expect(answer(SAMPLES, '')).toBe(LIST)
  expect(answer(SAMPLES, '   ')).toBe(LIST)
})

test('没有子命令可用时也说明用法', () => {
  expect(answer([], '')).toBe('用法：/anvil <子命令>\n  暂无可用的子命令')
})

test('未知子命令先说明再列出', () => {
  expect(answer(SAMPLES, 'nope')).toBe(`没有子命令 nope。\n${LIST}`)
  expect(answer(SAMPLES, ' nope hide ')).toBe(`没有子命令 nope。\n${LIST}`)
})

test('功能模块没接走的已知子命令（缺词、词不对、多了词）给出它的用法', () => {
  for (const args of ['panel', 'panel up', ' panel  hide now ']) {
    expect(answer(SAMPLES, args)).toBe('用法：/anvil panel hide|show')
  }
})
