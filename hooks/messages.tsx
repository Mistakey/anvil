// 我的消息列表（spec D8）：序号 + 内容；Enter 让对话滚到这条消息（D11 实测成立，做法照探针 anvil-k0t.12：
// `$.ui.scroll({ to: { requestId }, block: 'start' })`，requestId 是那一行 UserMessage 的消息 id）。
// 偏离探针：探针按 UserMessage 首次绘制记下、从不删除，撤回的消息会留在列表里（anvil-k0t.19 评论）。
// 这里从 `session.append` 记下主输入框发出的消息（uuid 就是消息 id），再拿 `$.session.messages()` 读到的
// 对话核对：撤回、回退掉的不在对话里了，从列表去掉。
// 只放不碰 `$` 的纯逻辑和界面组件；事件接线和读写状态在 register.ts。

import type { ApiContentBlock, Elements, RenderElement, SessionAppendInput, SessionMessage } from 'claude-code'

import type { MyMessage, MyMessages } from '../types'
import type { ListBody, ListItem } from './panel'
import { COLOR } from './style'
import { fit, padStart } from './text'

export const NO_MESSAGES: MyMessages = { items: [], dropped: 0, settled: 0 }

/** 存多少条；更早的丢掉，序号照旧往上数 */
const KEEP = 300

// ---------------------------------------------------------------- 数据

/** 一行消息的文字：文本块连起来（`$.session.messages()` 的 text 也是这么来的） */
export function contentText(content: string | readonly ApiContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')
}

/** 主会话里、用户在主输入框打的那条（不是斜杠命令、插件、任务通知、别的 agent 送来的） */
export const isMyMessage = (e: SessionAppendInput) =>
  e.agentId === undefined && e.message.type === 'user' && e.message.isMeta !== true && e.origin.kind === 'composer'

/** 比较用：去掉全部空白，文本块之间用什么连接都不影响 */
const same = (text: string) => text.replace(/\s+/g, '')

/** 主输入框发出的一条消息进了对话 */
export function addMessage(list: MyMessages, message: MyMessage): MyMessages {
  if (list.items.some(one => one.id === message.id)) return list
  const items = [...list.items, message]
  const cut = Math.max(0, items.length - KEEP)
  return { items: items.slice(cut), dropped: list.dropped + cut, settled: Math.max(0, list.settled - cut) }
}

/** 压缩之后，此前的消息只剩摘要，不再拿对话核对 */
export const settleMessages = (list: MyMessages): MyMessages => ({ ...list, settled: list.items.length })

/** 对话里现存的用户消息的文字，旧的在前；工具结果那种用户行不算 */
export function userTexts(transcript: readonly SessionMessage[]): string[] {
  return transcript.filter(message => message.role === 'user' && message.text !== '').map(message => message.text)
}

/**
 * 拿对话核对：上一次压缩之后的消息按顺序在对话的用户消息里找，找不到的就是撤回、回退掉的，去掉。
 * 同样的话发过几次也能分清：按顺序一一对上，多出来的是撤回的那条。没有变化时原样返回同一个对象。
 */
export function reconcile(list: MyMessages, texts: readonly string[]): MyMessages {
  const wanted = texts.map(same)
  const kept = list.items.slice(0, list.settled)
  let from = 0
  for (const message of list.items.slice(list.settled)) {
    const at = wanted.indexOf(same(message.text), from)
    if (at === -1) continue
    kept.push(message)
    from = at + 1
  }
  return kept.length === list.items.length ? list : { ...list, items: kept }
}

// ---------------------------------------------------------------- 绘制

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** 一行的列宽（设计稿 .ms）：序号 3 | 内容，列间空 1 格 */
const COLUMN = { seq: 3, gap: 1 } as const

/** 右上角："31 条" */
export const messageCount = (list: MyMessages) => [{ text: `${list.items.length} 条` }]

/** 一条消息的那一行：整行是一个 Button，焦点移上去反白，Enter 让对话滚到这条消息 */
function messageRow(els: Els, message: MyMessage, seq: number, inner: number, onPress: () => void): RenderElement {
  const { Box, Button, Text } = els
  const text = fit(message.text.replace(/\s+/g, ' ').trim(), Math.max(1, inner - COLUMN.seq - COLUMN.gap))
  return (
    <Box key={`row:message:${message.id}`} width={inner} flexShrink={0}>
      <Button key={`message:${message.id}`} label={`第 ${seq} 条消息`} plain onPress={onPress}>
        <Text bold>{`${padStart(String(seq), COLUMN.seq)} `}</Text>
        <Text color={COLOR.text}>{text}</Text>
      </Button>
    </Box>
  )
}

/** 交给面板的我的消息列表：占满剩余高度，放不下时顶部写更早的条数 */
export function messageList(els: Els, list: MyMessages, view: { inner: number; onPress: (id: string) => void }): ListBody {
  const items: ListItem[] = list.items.map((message, index) => ({
    key: message.id,
    rows: [messageRow(els, message, list.dropped + index + 1, view.inner, () => view.onPress(message.id))],
  }))
  return { status: messageCount(list), unit: '条', lead: COLUMN.seq, items, limit: 'fill', empty: '本会话还没有发过消息' }
}
