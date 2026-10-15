import { expect, mock, test } from 'claude-code/testing'

import { answer, describe } from '../hooks/command'
import type { Listed } from '../hooks/command'
import { SESSION, anvil, world } from './world'

test('会话开始时注册 /anvil', async ($, on) => {
  const { commands } = world(on)
  await $.session.start(SESSION)

  expect(commands).toEqual(['anvil'])
})

test('补全菜单里 /anvil 的灰字：一句命令说明，参数提示列出全部子命令', async ($, on) => {
  const { registered } = world(on)
  await $.session.start(SESSION)

  expect(registered).toEqual([
    {
      name: 'anvil',
      argumentHint: '[keepalive]',
      description: 'Toggle prompt-cache keepalive for this session; with no argument, list the current state',
    },
  ])
})

test('/anvil 不带参数时列出子命令和本会话的当前状态', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(SESSION)

  const { text } = await $.command.run(anvil(''))
  expect(text).toBe(['Usage: /anvil <subcommand>. Each run toggles it, for this session only', '  /anvil keepalive  Turn prompt-cache keepalive on or off (now: not on (context below 50k))'].join('\n'))

  await $.command.run(anvil('keepalive'))
  const after = (await $.command.run(anvil(' '))).text ?? ''
  expect(after).toContain('/anvil keepalive  Turn prompt-cache keepalive on or off (now: on (this session))')
})

test('/anvil 带未知子命令、已去掉的子命令或多余参数时说明并列出子命令', async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  for (const [args, name] of [
    ['nope', 'nope'],
    ['panel', 'panel'],
    [' translate  show ', 'translate show'],
    ['keepalive off', 'keepalive off'],
    ['keepalive on', 'keepalive on'],
  ]) {
    const { text } = await $.command.run(anvil(args ?? ''))
    expect(text, args).toStartWith(`Unknown subcommand: ${name}\nUsage: /anvil <subcommand>`)
  }
})

// 列表规则用两个样例子命令验证；真实的子命令说明由各功能模块交出
const SAMPLES: Listed[] = [
  { name: 'panel', summary: 'Show or hide the anvil panel', state: 'shown' },
  { name: 'keepalive', summary: 'Turn prompt-cache keepalive on or off', state: 'on' },
]

const LIST = [
  'Usage: /anvil <subcommand>. Each run toggles it, for this session only',
  '  /anvil panel      Show or hide the anvil panel (now: shown)',
  '  /anvil keepalive  Turn prompt-cache keepalive on or off (now: on)',
].join('\n')

test('不带子命令时按顺序列出子命令、说明和当前状态', () => {
  expect(answer(SAMPLES, '')).toBe(LIST)
  expect(answer(SAMPLES, '   ')).toBe(LIST)
})

test('没有子命令可用时也说明用法', () => {
  expect(answer([], '')).toBe('Usage: /anvil <subcommand>. Each run toggles it, for this session only\n  No subcommands available')
})

test('未知子命令、已知子命令带多余的词，都先说明再列出', () => {
  expect(answer(SAMPLES, 'nope')).toBe(`Unknown subcommand: nope\n${LIST}`)
  expect(answer(SAMPLES, ' nope hide ')).toBe(`Unknown subcommand: nope hide\n${LIST}`)
  expect(answer(SAMPLES, ' panel  hide now ')).toBe(`Unknown subcommand: panel hide now\n${LIST}`)
})

test('参数提示按 SUBCOMMANDS 的顺序列出子命令', () => {
  expect(describe(SAMPLES).argumentHint).toBe('[panel|keepalive]')
})
