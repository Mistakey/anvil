import { expect, mock, test } from 'claude-code/testing'

import { answer } from '../hooks/command'
import type { Listed } from '../hooks/command'
import { SESSION, anvil, panes, world } from './world'

test('会话开始时注册 /anvil', async ($, on) => {
  const { commands } = world(on)
  await $.session.start(SESSION)

  expect(commands).toEqual(['anvil'])
})

test('/anvil 不带参数时列出三个子命令和本会话的当前状态', async ($, on) => {
  mock.clock(on)
  world(on)
  panes(on)
  await $.session.start(SESSION)

  const { text } = await $.command.run(anvil(''))
  expect(text).toBe(
    [
      '用法：/anvil <子命令>，敲一次切换一次，只作用于当前会话',
      '  /anvil panel      显示或隐藏 anvil 面板（现在：显示）',
      '  /anvil translate  显示或隐藏翻译框（现在：显示）',
      '  /anvil keepalive  开启或关闭缓存保活（现在：未启用（低于 50k））',
    ].join('\n'),
  )

  await $.command.run(anvil('panel'))
  await $.command.run(anvil('keepalive'))
  const after = (await $.command.run(anvil(' '))).text ?? ''
  expect(after).toContain('/anvil panel      显示或隐藏 anvil 面板（现在：隐藏）')
  expect(after).toContain('/anvil keepalive  开启或关闭缓存保活（现在：已启用（本会话））')
})

test('/anvil 带未知子命令、旧写法或多余参数时说明并列出子命令', async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  for (const [args, name] of [
    ['nope', 'nope'],
    ['panel hide', 'panel hide'],
    [' translate  show ', 'translate show'],
    ['keepalive off', 'keepalive off'],
    ['keepalive on', 'keepalive on'],
  ]) {
    const { text } = await $.command.run(anvil(args ?? ''))
    expect(text, args).toStartWith(`没有子命令 ${name}。\n用法：/anvil <子命令>`)
  }
})

// 列表规则用两个样例子命令验证；真实的子命令说明由各功能模块交出
const SAMPLES: Listed[] = [
  { name: 'panel', summary: '显示或隐藏 anvil 面板', state: '显示' },
  { name: 'keepalive', summary: '开启或关闭缓存保活', state: '已启用' },
]

const LIST = [
  '用法：/anvil <子命令>，敲一次切换一次，只作用于当前会话',
  '  /anvil panel      显示或隐藏 anvil 面板（现在：显示）',
  '  /anvil keepalive  开启或关闭缓存保活（现在：已启用）',
].join('\n')

test('不带子命令时按顺序列出子命令、说明和当前状态', () => {
  expect(answer(SAMPLES, '')).toBe(LIST)
  expect(answer(SAMPLES, '   ')).toBe(LIST)
})

test('没有子命令可用时也说明用法', () => {
  expect(answer([], '')).toBe('用法：/anvil <子命令>，敲一次切换一次，只作用于当前会话\n  暂无可用的子命令')
})

test('未知子命令、已知子命令带多余的词，都先说明再列出', () => {
  expect(answer(SAMPLES, 'nope')).toBe(`没有子命令 nope。\n${LIST}`)
  expect(answer(SAMPLES, ' nope hide ')).toBe(`没有子命令 nope hide。\n${LIST}`)
  expect(answer(SAMPLES, ' panel  hide now ')).toBe(`没有子命令 panel hide now。\n${LIST}`)
})
