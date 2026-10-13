import type { On, SessionAppendInput, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { NO_MESSAGES, addMessage, reconcile, settleMessages } from '../hooks/messages'
import { COLOR } from '../hooks/style'
import { cells } from '../hooks/text'
import { SESSION, flat, pane, turnInput, world } from './world'

const NOW = 10 * 3_600_000

let rows = 0
/** 一行进了对话；默认是主输入框发出、主会话的用户消息 */
const appended = (text: string, over: Partial<SessionAppendInput> = {}): SessionAppendInput =>
  ({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: `u${++rows}`,
    ...over,
  }) as SessionAppendInput

const said = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const answered = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })

/** 引擎的对话：每条用户消息后跟一条回答 */
const conversation = (...texts: string[]) => texts.flatMap(text => [said(text), answered('好')])

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const transcript = { messages: [] as SessionMessage[] }
  const { state } = world(on, { transcript })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, transcript, state }
}

/** 用户在主输入框发一条：先进对话，引擎再把它存进 transcript */
async function send($: Engine, transcript: { messages: SessionMessage[] }, text: string) {
  const row = appended(text)
  const stored = await $.session.append(row)
  transcript.messages = [...transcript.messages, said(text), answered('好')]
  return stored.uuid ?? row.uuid
}

// ---------------------------------------------------------------- 纯逻辑

test('核对：对话里找不到的（撤回、回退掉的）去掉；同样的话发过几次也按顺序对上', () => {
  let list = NO_MESSAGES
  for (const [id, text] of [['a', '继续'], ['b', '改一下'], ['c', '继续']] as const) list = addMessage(list, { id, text })
  expect(reconcile(list, ['继续', '改一下', '继续'])).toBe(list)
  expect(reconcile(list, ['继续', '改一下']).items.map(one => one.id)).toEqual(['a', 'b'])
  expect(reconcile(list, ['继续']).items.map(one => one.id)).toEqual(['a'])
  // 空白不同不算不同
  expect(reconcile(addMessage(NO_MESSAGES, { id: 'x', text: '第一行\n第二行' }), ['第一行 第二行']).items).toHaveLength(1)
  // 压缩之前的不再核对：对话里只剩摘要
  const settled = addMessage(settleMessages(list), { id: 'd', text: '新的' })
  expect(reconcile(settled, ['摘要', '新的']).items.map(one => one.id)).toEqual(['a', 'b', 'c', 'd'])
})

// ---------------------------------------------------------------- 事件接线与绘制

test('用户提交的消息按顺序进入我的消息：序号 + 内容；斜杠命令、插件和子 agent 的不算', async ($, on) => {
  const { transcript } = engine(on)
  await $.session.start(SESSION)
  await send($, transcript, '候选功能有问题，有很多应该常驻的吧？')
  await send($, transcript, '继续')
  await $.session.append(appended('/anvil panel', { door: 'command' }))
  await $.session.append(appended('插件送来的', { origin: { kind: 'plugin', plugin: 'other' } as never }))
  await $.session.append(appended('子 agent 的任务', { agentId: 'ag1' }))
  await send($, transcript, '不对，你没理解')

  const ui = await $.ui.mount(pane(false))
  const box = flat(await ui.find({ key: 'section:messages' }))
  expect(box).toContain('3 条')
  const shown = (await ui.findAll({})).filter(found => String(found.key ?? '').startsWith('message:')).map(found => flat(found))
  expect(shown).toEqual(['  1 候选功能有问题，有很多应该常驻的吧？', '  2 继续', '  3 不对，你没理解'])
  await ui.unmount()
})

test('序号次要色、右对齐成一列；长消息最多两行，第二行和正文对齐，超出截断；条与条之间不空行', async ($, on) => {
  const { transcript } = engine(on)
  await $.session.start(SESSION)
  const long = '把缓存框和用量框的排版改一下，'.repeat(10)
  const ids = [await send($, transcript, '继续'), await send($, transcript, long)]
  for (let n = 3; n <= 10; n += 1) ids.push(await send($, transcript, `第 ${n} 条`))

  // 面板 70 列：框内 66 格，序号 3 格加 1 格空，正文 62 格
  const ui = await $.ui.mount(pane(false))
  const seqs = (await ui.findAll({ type: 'Text' })).filter(one => /^ *\d+ $/.test(one.text))
  expect(seqs.map(one => one.text)).toEqual(['  1 ', '  2 ', '  3 ', '  4 ', '  5 ', '  6 ', '  7 ', '  8 ', '  9 ', ' 10 '])
  expect(seqs.every(one => one.props.color === COLOR.secondary)).toBe(true)

  expect(flat(await ui.find({ key: `message:${ids[0]}` }))).toBe('  1 继续')
  expect((await ui.find({ key: `row:message:${ids[0]}` }))?.props.height).toBe(1)
  const [first = '', second = '', ...more] = flat(await ui.find({ key: `message:${ids[1]}` })).split('\n')
  expect(more).toEqual([])
  expect(first).toBe(`  2 ${'把缓存框和用量框的排版改一下，'.repeat(3).slice(0, 31)}`)
  expect(cells(first)).toBe(66)
  // 第二行和正文对齐（悬挂缩进），放不下的截断
  expect(second.startsWith('    ')).toBe(true)
  expect(second.slice(4, 5)).not.toBe(' ')
  expect(second.endsWith('…')).toBe(true)
  expect(cells(second) <= 66).toBe(true)
  expect((await ui.find({ key: `row:message:${ids[1]}` }))?.props.height).toBe(2)

  // 条与条之间不空行：消息一条接一条，空行只在最后
  const rows = ((await ui.find({ key: 'box:messages' }))?.children ?? []).map(one => String((one as { props?: { key?: string } }).props?.key ?? ''))
  expect(rows.slice(0, 10)).toEqual(ids.map(id => `row:message:${id}`))
  expect(rows.slice(10).every(key => key.startsWith('pad:'))).toBe(true)
  await ui.unmount()
})

test('选中一条按 Enter：让对话滚到这条消息', async ($, on) => {
  const { transcript, state } = engine(on)
  await $.session.start(SESSION)
  const first = await send($, transcript, '第一条')
  await send($, transcript, '第二条')

  const ui = await $.ui.mount(pane(true))
  await ui.press({ key: `message:${first}` })
  // plugin test 里引擎没有 ui.scroll 的实现，会拒绝；这里只核对按下去请求滚到的是哪一条
  expect((state.get('anvil.scrolled') as { id: string } | undefined)?.id).toBe(first)
  // 消息还在对话里，不因为测试里滚不过去就从列表去掉
  expect(await ui.find({ key: `message:${first}` })).toBeDefined()
  await ui.unmount()
})

test('撤回的消息从列表去掉：回合结束时、进面板时、回退后重发时都按对话核对', async ($, on) => {
  const { clock, transcript } = engine(on)
  await $.session.start(SESSION)
  const ids = [await send($, transcript, '一'), await send($, transcript, '二'), await send($, transcript, '三')]
  const shownIds = async (focused: boolean) => {
    const ui = await $.ui.mount(pane(focused))
    await clock.settle()
    const found = (await ui.findAll({})).map(one => String(one.key ?? '')).filter(key => key.startsWith('message:'))
    await ui.unmount()
    return found
  }

  // 按 Esc 打断，引擎把"三"撤回主输入框：回合结束时核对
  transcript.messages = conversation('一', '二')
  await $.turn.complete(turnInput({ reason: 'aborted' as never, isAborted: true }))
  expect(await shownIds(false)).toEqual([`message:${ids[0]}`, `message:${ids[1]}`])

  // 回退到"一"之后：没有事件，用户进面板时核对
  transcript.messages = conversation('一')
  expect(await shownIds(false), '没进面板时还没核对').toHaveLength(2)
  expect(await shownIds(true)).toEqual([`message:${ids[0]}`])

  // 回退后重发同样的话：旧的那条已不在对话里，列表里只有新的
  transcript.messages = conversation('一')
  const again = await send($, transcript, '二')
  expect(await shownIds(false)).toEqual([`message:${ids[0]}`, `message:${again}`])
})
