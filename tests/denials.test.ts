import type { ClassicEventOf, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { clockTime, denialContent, fitPath, sourceText } from '../hooks/denials'
import { cells } from '../hooks/text'
import { SESSION, drain, flat, pane, spawnInput, stepInput, world } from './world'

const NOW = 10 * 3_600_000

type DeniedInput = ClassicEventOf['classic.PermissionDenied']

let uses = 0
/** 自动模式的分类器拒绝了一次调用；agent_id 有值时是子 agent 的 */
const denied = (tool: string, input: unknown, over: Partial<DeniedInput> = {}): DeniedInput => ({
  session_id: 's1',
  transcript_path: '/work/s1.jsonl',
  cwd: '/work',
  hook_event_name: 'PermissionDenied',
  tool_name: tool,
  tool_input: input,
  tool_use_id: `deny${++uses}`,
  reason: 'classifier',
  ...over,
})

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock }
}

// ---------------------------------------------------------------- 纯逻辑

test('完整内容：命令、路径、网址原样遮掉密钥，其余工具写参数', () => {
  expect(denialContent({ command: 'curl -H "Authorization: Bearer abcdefgh12345" https://x' })).toEqual({
    kind: 'command',
    // 遮密钥照 flightdeck 的规则：Authorization 后面连着的整段都遮掉
    text: 'curl -H "Authorization: Bearer ••• https://x',
  })
  expect(denialContent({ file_path: 'C:\\Users\\me\\.ssh\\id_ed25519' })).toEqual({ kind: 'path', text: 'C:\\Users\\me\\.ssh\\id_ed25519' })
  expect(denialContent({ url: 'https://example.com/a' }).kind).toBe('url')
  expect(denialContent({ query: 'token=abcdef123456' })).toEqual({ kind: 'input', text: '{"query":"token=•••' })
})

test('路径放不下时留开头一段和结尾几段', () => {
  expect(fitPath('C:\\Users\\33137\\AppData\\Local\\Programs\\Claude\\claude.exe', 16)).toBe('C:\\…\\claude.exe')
  expect(fitPath('C:\\Users\\33137\\AppData\\Local\\Programs\\Claude\\claude.exe', 24)).toBe('C:\\…\\Claude\\claude.exe')
  expect(fitPath('/home/me/a.txt', 30)).toBe('/home/me/a.txt')
  expect(cells(fitPath('C:\\averyveryverylongname\\x', 8))).toBeLessThanOrEqual(8)
})

test('来源：主会话；子 agent 写序号、任务和第几步', () => {
  expect(sourceText({ kind: 'main' })).toBe('主会话')
  expect(sourceText({ kind: 'agent', seq: 2, description: '调研 Spinner 首字时刻', step: 6 })).toBe('子 agent 2「调研 Spinner 首字时刻」第 6 步')
  expect(sourceText({ kind: 'agent', seq: null, description: '', step: null })).toBe('子 agent')
})

// ---------------------------------------------------------------- 事件接线与绘制

test('主会话和子 agent 各被拒一次：列表行是时间、工具、摘要，密钥被遮，右上角计数', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('调研 Spinner 首字时刻'))
  await drain($.turn.step(stepInput({ agentId: 'ag1' })))
  await drain($.turn.step(stepInput({ agentId: 'ag1' })))

  await $.classic.PermissionDenied(denied('Bash', { command: 'export API_TOKEN=supersecret123 && npm publish' }, { tool_use_id: 'd-main' }))
  await clock.advance(60_000)
  await $.classic.PermissionDenied(
    denied('Read', { file_path: 'C:\\Users\\33137\\.ssh\\id_ed25519' }, { tool_use_id: 'd-agent', agent_id: 'ag1', agent_type: 'general-purpose' }),
  )

  const ui = await $.ui.mount(pane(false))
  const box = flat(await ui.find({ key: 'section:denials' }))
  expect(box).toContain('2 条')
  const main = flat(await ui.find({ key: 'denial:d-main' }))
  expect(main).toMatch(new RegExp(`^${clockTime(NOW)} Bash  export API_TOKEN=••• && npm publish$`))
  expect(main).not.toContain('supersecret123')
  const agent = flat(await ui.find({ key: 'denial:d-agent' }))
  expect(agent).toBe(`${clockTime(NOW + 60_000)} Read  C:\\Users\\33137\\.ssh\\id_ed25519`)
  // 收起时没有详情
  expect(await ui.find({ key: 'detail:denial:d-main:source:0' })).toBeUndefined()
  await ui.unmount()
})

test('选中一条按 Enter：显示完整内容和来源（主会话，或子 agent 及第几步）；再按收起', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('调研 Spinner 首字时刻'))
  for (let n = 0; n < 6; n += 1) await drain($.turn.step(stepInput({ agentId: 'ag1' })))

  const long = `curl -X POST https://api.example.com/deploy -H "Authorization: Bearer abcdefgh12345" -d @payload.json ${'--verbose '.repeat(6)}`
  await $.classic.PermissionDenied(denied('Bash', { command: long }, { tool_use_id: 'd-main' }))
  await $.classic.PermissionDenied(
    denied('Read', { file_path: 'C:\\Users\\33137\\AppData\\Local\\Programs\\Claude\\claude.exe' }, { tool_use_id: 'd-agent', agent_id: 'ag1' }),
  )

  const ui = await $.ui.mount(pane(true))
  await ui.press({ key: 'list:denials' })
  await ui.press({ key: 'denial:d-agent' })
  // 完整路径比一行长，折成两行
  const path = [flat(await ui.find({ key: 'detail:denial:d-agent:text:0' })), flat(await ui.find({ key: 'detail:denial:d-agent:text:1' }))]
  expect(path).toEqual(['路径C:\\Users\\33137\\AppData\\Local\\Programs\\Claude\\clau', 'de.exe'])
  expect(flat(await ui.find({ key: 'detail:denial:d-agent:source:0' }))).toBe('来源子 agent 1「调研 Spinner 首字时刻」第 6 步')

  // 换一条：同时只展开一条；长命令折成几行，密钥照样遮掉
  await ui.press({ key: 'denial:d-main' })
  expect(await ui.find({ key: 'detail:denial:d-agent:source:0' })).toBeUndefined()
  const lines = (await ui.findAll({})).filter(found => String(found.key ?? '').startsWith('detail:denial:d-main:text:'))
  expect(lines.length).toBeGreaterThan(1)
  const text = lines.map(found => flat(found)).join(' ')
  expect(text.startsWith('命令curl -X POST')).toBe(true)
  expect(text).toContain('Bearer •••')
  expect(text).not.toContain('abcdefgh12345')
  expect(flat(await ui.find({ key: 'detail:denial:d-main:source:0' }))).toBe('来源主会话')

  await ui.press({ key: 'denial:d-main' })
  expect(await ui.find({ key: 'detail:denial:d-main:source:0' })).toBeUndefined()
  await ui.unmount()
})

test('收起时只留最新的两条，顶部写更早的条数；同一次调用只记一条', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (let n = 1; n <= 5; n += 1) await $.classic.PermissionDenied(denied('Bash', { command: `rm -rf dir${n}` }, { tool_use_id: `d${n}` }))
  await $.classic.PermissionDenied(denied('Bash', { command: 'rm -rf dir5' }, { tool_use_id: 'd5' }))

  const ui = await $.ui.mount(pane(false))
  expect(flat(await ui.find({ key: 'section:denials' }))).toContain('5 条')
  expect(flat(await ui.find({ key: 'row:earlier:denials' }))).toBe('    ▴ 更早的 3 条 · 按 d 展开')
  expect(await ui.find({ key: 'denial:d3' })).toBeUndefined()
  expect(await ui.find({ key: 'denial:d4' })).toBeDefined()
  expect(await ui.find({ key: 'denial:d5' })).toBeDefined()
  await ui.unmount()
})

test('没有拒绝时框里写一行说明', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount(pane(false))
  const box = flat(await ui.find({ key: 'section:denials' }))
  expect(box).toContain('本会话还没有自动模式拒绝')
  expect(box).toContain('0 条')
  await ui.unmount()
})
