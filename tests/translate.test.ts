import type { HttpInit, HttpResponse, ModelCompleteInput, ModelCompleteResult, On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { apiEndpoint, appendText, countWords, failed, startTranslating, typed, EMPTY_BOX } from '../hooks/translate'
import { COLOR } from '../hooks/style'
import { cells } from '../hooks/text'
import { SESSION, anvil, world } from './world'
import type { WorldOptions } from './world'

const CHINESE = '把这个函数改成异步的'
const ENGLISH = 'Make this function async.'

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answer = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: { ...ZERO, input_tokens: 80, output_tokens: 6 } })

/** 翻译后端的替身：订阅模型和自有 API 的回答都可以在测试中途改 */
type Backend = {
  model: { result: ModelCompleteResult }
  http: { response: HttpResponse | Error }
}

const okBody = (content: string) => JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content } }] })

function engine(on: On, options: WorldOptions = {}) {
  mock.clock(on)
  const w = world(on, options)
  const backend: Backend = {
    model: { result: answer(ENGLISH) },
    http: { response: { status: 200, ok: true, headers: {}, text: okBody(ENGLISH) } },
  }
  const asked: ModelCompleteInput[] = []
  const fetched: { url: string; init?: HttpInit }[] = []
  on('model.complete', ($, e) => {
    asked.push(e)
    return { value: backend.model.result }
  })
  on('http.fetch', ($, e) => {
    fetched.push(e)
    const response = backend.http.response
    if (response instanceof Error) throw response
    return { value: response }
  })
  // 翻译框让出那一栏时，下面没有别人画
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [''] }))
  return { ...w, backend, asked, fetched }
}

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

async function band($: Engine, props: Partial<RenderPropsOf['AbovePrompt']> = {}) {
  return $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, ...props } })
}

type Band = Awaited<ReturnType<typeof band>>

async function field(ui: Band) {
  const input = await ui.find({ type: 'Input' })
  if (!input?.key) throw new Error('翻译框里没有输入框')
  return input
}

async function statusText(ui: Band) {
  return (await ui.find({ key: 'status:translate' }))?.text ?? ''
}

test('没有输入时显示示例和按键提示', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await band($)

  const input = await field(ui)
  expect(input.props.placeholder).toBe('例如：把函数改成异步的')
  expect(await statusText(ui)).toBe('Enter 翻译 · Shift+Enter 换行')
  expect(await ui.find({ text: /中→英/ })).toBeDefined()
})

// 长句能不能折行、光标在哪，要在伪终端里实跑 claude 看（anvil-k0t.30）；这里只看树的结构
test('框里有字时不画按键提示，输入框占满 band 宽；删空后提示回来', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await band($, { bodyColumns: 120 })
  const input = await field(ui)
  expect(await besideField(ui)).toBe(true)

  await ui.input({ key: input.key ?? '', text: '把', kind: 'change' })
  expect(await statusText(ui)).toBe('')
  expect(await ui.find({ text: /Enter 翻译/ })).toBeUndefined()
  expect(await fieldWidth(ui)).toBe(120)
  // 同一个输入框，没有画新的值盖掉正在写的字
  expect((await field(ui)).key).toBe(input.key)
  expect((await field(ui)).props.value).toBeUndefined()

  await ui.input({ key: input.key ?? '', text: '', kind: 'change' })
  expect(await statusText(ui)).toBe('Enter 翻译 · Shift+Enter 换行')
})

test('空框时提示放在示例右侧，要给示例和引擎的提交标签留够地方', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const [columns, beside] of [[40, false], [60, false], [80, true]] as const) {
    const ui = await band($, { bodyColumns: columns })
    expect(await besideField(ui), `${columns} 列`).toBe(beside)
    // 示例 22 格，加上引擎画的「⏎ 翻译」
    expect(Number(await fieldWidth(ui)), `${columns} 列`).toBeGreaterThanOrEqual(30)
    await ui.unmount()
  }
})

// 引擎在提交后清空框、把焦点交回主输入框（2.1.296），成功时照它的做法；焦点在伪终端里实跑确认（anvil-k0t.33）
test('按 Enter：订阅模型（默认 Haiku）翻译，以 append 追加到主输入框，显示词数，不重画中文', async ($, on) => {
  const { asked, fillModes, state } = engine(on)
  await $.session.start(SESSION)
  const ui = await band($)
  const before = await field(ui)

  await ui.input({ key: before.key ?? '', text: CHINESE })

  expect(asked).toHaveLength(1)
  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.prompt).toContain(CHINESE)
  expect(asked[0]?.system).toContain('Output only the English translation')
  expect(fillModes).toEqual([{ text: ENGLISH, mode: 'append' }])
  expect(await statusText(ui)).toBe('\u{F00C} 已追加 4 个词')
  // 好状态只给符号上色：✓ 绿，字次要色；上下两条线和主输入框的线同色
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find(one => one.text === '\u{F00C}')?.props.color).toBe(COLOR.ok)
  expect(texts.find(one => one.text === ' 已追加 4 个词')?.props.color).toBe(COLOR.secondary)
  expect((await ui.find({ key: 'rule:translate' }))?.children?.[0]).toMatchObject({ props: { color: COLOR.promptLine } })
  // 还是同一个输入框、没有画值：不重画中文，也就不调 $.ui.focus 抢焦点（焦点只交给新一代的输入框）
  const after = await field(ui)
  expect(after.key).toBe(before.key)
  expect(after.props.value).toBeUndefined()
  expect(state.get('anvil.translate')).toMatchObject({ phase: 'done', text: CHINESE, words: 4, seed: '', empty: true })
  // 框空着，状态放在示例右侧
  expect(await besideField(ui)).toBe(true)
})

test('主输入框里已有文字、末尾不是换行时，译文另起一行', async ($, on) => {
  const { fillModes, box } = engine(on, { box: { text: 'Please review. ' } })
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(fillModes).toEqual([{ text: `\n${ENGLISH}`, mode: 'append' }])
  expect(box.text).toBe(`Please review. \n${ENGLISH}`)
})

test('主输入框末尾已是换行时，译文直接接上', async ($, on) => {
  const { fillModes, box } = engine(on, { box: { text: 'Please review.\n' } })
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(fillModes).toEqual([{ text: ENGLISH, mode: 'append' }])
  expect(box.text).toBe(`Please review.\n${ENGLISH}`)
})

test('追加之后开始写下一句时去掉"已追加"，只敲空白不算', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await band($)
  const input = await field(ui)
  await ui.input({ key: input.key ?? '', text: CHINESE })

  await ui.input({ key: input.key ?? '', text: ' ', kind: 'change' })
  expect(await statusText(ui)).toContain('已追加 4 个词')

  await ui.input({ key: input.key ?? '', text: ' 再', kind: 'change' })
  // 框里有字：按键提示只剩引擎画的提交标签
  expect(await statusText(ui)).toBe('')
  expect((await field(ui)).key).toBe(input.key)
  expect((await field(ui)).props.value).toBeUndefined()
})

test('翻译成功后写下一句再按 Enter，照常翻译、追加', async ($, on) => {
  const { asked, fillModes } = engine(on)
  await $.session.start(SESSION)
  const ui = await band($)
  const input = await field(ui)
  await ui.input({ key: input.key ?? '', text: CHINESE })

  await ui.input({ key: input.key ?? '', text: '把这个函数改成同步的' })

  expect(asked).toHaveLength(2)
  expect(asked[1]?.prompt).toContain('把这个函数改成同步的')
  expect(fillModes).toHaveLength(2)
  expect(await statusText(ui)).toContain('已追加 4 个词')
})

// 焦点交给画回中文的输入框（$.ui.focus）在 plugin test 里没有实现，伪终端里实跑确认（anvil-k0t.33）
test('后端失败时中文画回框里、显示原因，只有引擎那一处按键提示；按 Enter 重试成功后照常追加', async ($, on) => {
  const { backend, asked, fillModes, state } = engine(on)
  backend.model.result = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
  await $.session.start(SESSION)
  const ui = await band($)
  const input = await field(ui)

  await ui.input({ key: input.key ?? '', text: CHINESE })

  expect(fillModes).toEqual([])
  expect(await statusText(ui)).toBe('\u{F00D} 模型出错（529 overloaded）')
  // 引擎提交后清空了框：换一代输入框，把中文画回去
  const again = await field(ui)
  expect(again.key).not.toBe(input.key)
  expect(again.props.value).toBe(CHINESE)
  expect(again.props.submitLabel).toBe('翻译')
  expect(state.get('anvil.translate')).toMatchObject({ phase: 'failed', empty: false })
  // 按键提示只有引擎画在输入框后面的「⏎ 翻译」
  expect(await ui.find({ text: /Enter/ })).toBeUndefined()
  expect(await besideField(ui)).toBe(false)

  backend.model.result = answer(ENGLISH)
  await ui.input({ key: again.key ?? '', text: CHINESE })
  expect(asked).toHaveLength(2)
  expect(fillModes).toEqual([{ text: ENGLISH, mode: 'append' }])
  expect(await statusText(ui)).toBe('\u{F00C} 已追加 4 个词')
  // 成功后不再画中文
  expect((await field(ui)).key).toBe(again.key)
  expect((await field(ui)).props.value).toBeUndefined()
})

test('超时、空回答各有原因', async ($, on) => {
  const { backend } = engine(on)
  await $.session.start(SESSION)
  const ui = await band($)

  backend.model.result = { isAnswered: false, reason: 'aborted', usage: ZERO }
  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })
  expect(await statusText(ui)).toContain('请求超时或被中断')

  backend.model.result = answer('   ')
  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })
  expect(await statusText(ui)).toContain('模型没有返回译文')
})

test('主输入框不收译文时显示原因，中文画回框里', async ($, on) => {
  engine(on, { fill: { refuse: true } })
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(await statusText(ui)).toContain('写入主输入框被拦下')
  expect((await field(ui)).props.value).toBe(CHINESE)
})

test('框里没字时按 Enter 什么都不做', async ($, on) => {
  const { asked, fillModes } = engine(on)
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: '  \n ' })

  expect(asked).toEqual([])
  expect(fillModes).toEqual([])
  expect(await statusText(ui)).toBe('Enter 翻译 · Shift+Enter 换行')
})

test('/config 选 sonnet 时用 Sonnet', { options: { translateBackend: 'sonnet' } }, async ($, on) => {
  const { asked } = engine(on)
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(asked.map(one => one.model)).toEqual(['sonnet'])
})

const API = { translateBackend: 'api', translateApiUrl: 'https://api.example.com/v1/', translateApiModel: 'deepseek-chat' }

test('/config 选 api 时按 OpenAI 兼容格式请求，带上环境变量里的 key', { options: API }, async ($, on) => {
  const { asked, fetched, fillModes } = engine(on)
  mock.env(on, { ANVIL_TRANSLATE_API_KEY: 'sk-test' })
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(asked).toEqual([])
  expect(fetched).toHaveLength(1)
  const request = fetched[0]
  expect(request?.url).toBe('https://api.example.com/v1/chat/completions')
  expect(request?.init?.method).toBe('POST')
  expect(request?.init?.headers?.authorization).toBe('Bearer sk-test')
  expect(request?.init?.headers?.['content-type']).toBe('application/json')
  const body = JSON.parse(request?.init?.body ?? '{}')
  expect(body.model).toBe('deepseek-chat')
  expect(body.messages[0].role).toBe('system')
  expect(body.messages[0].content).toContain('Output only the English translation')
  expect(body.messages[1].role).toBe('user')
  expect(body.messages[1].content).toContain(CHINESE)
  expect(fillModes).toEqual([{ text: ENGLISH, mode: 'append' }])
})

test('api：没设环境变量时不发请求，说明缺什么', { options: API }, async ($, on) => {
  const { fetched } = engine(on)
  mock.env(on, {})
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(fetched).toEqual([])
  expect(await statusText(ui)).toContain('没有设置环境变量 ANVIL_TRANSLATE_API_KEY')
})

test('api：没填接口地址或模型名时说明缺什么', { options: { translateBackend: 'api' } }, async ($, on) => {
  const { fetched } = engine(on)
  mock.env(on, { ANVIL_TRANSLATE_API_KEY: 'sk-test' })
  await $.session.start(SESSION)
  const ui = await band($)

  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })

  expect(fetched).toEqual([])
  expect(await statusText(ui)).toContain('/config 里没填自有 API 接口地址')
})

test('api：接口出错时显示状态码和它给的原因；连不上时显示错误', { options: API }, async ($, on) => {
  const { backend } = engine(on)
  mock.env(on, { ANVIL_TRANSLATE_API_KEY: 'sk-bad' })
  await $.session.start(SESSION)
  const ui = await band($, { bodyColumns: 160 })

  backend.http.response = { status: 401, ok: false, headers: {}, text: JSON.stringify({ error: { message: 'Invalid API key' } }) }
  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })
  expect(await statusText(ui)).toContain('接口返回 401：Invalid API key')

  backend.http.response = new Error('connect ECONNREFUSED')
  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })
  expect(await statusText(ui)).toContain('请求失败')

  backend.http.response = { status: 200, ok: true, headers: {}, text: '{"choices":[]}' }
  await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })
  expect(await statusText(ui)).toContain('接口返回的内容里没有译文')
})

test('/anvil translate 切换：隐藏后 band 不画翻译框，再敲一次恢复；新会话回到显示', async ($, on) => {
  const { state } = engine(on)
  await $.session.start(SESSION)
  expect(state.get('anvil.translateHidden'), '新会话不带隐藏').toBe(undefined)

  const hidden = await $.command.run(anvil('translate'))
  expect(hidden.text).toBe('翻译框已隐藏（本会话）')
  const off = await band($)
  expect(await off.find({ type: 'Input' })).toBeUndefined()
  await off.unmount()

  const shown = await $.command.run(anvil(' translate '))
  expect(shown.text).toBe('翻译框已显示')
  const on2 = await band($)
  expect(await on2.find({ type: 'Input' })).toBeDefined()
})

test('/config 关掉翻译框：band 不画，/anvil translate 在本会话显示，再敲一次回到隐藏', { options: { showTranslate: false } }, async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const off = await band($)
  expect(await off.find({ type: 'Input' })).toBeUndefined()
  await off.unmount()
  expect((await $.command.run(anvil(''))).text).toContain('/anvil translate  显示或隐藏翻译框（现在：隐藏）')

  expect((await $.command.run(anvil('translate'))).text).toBe('翻译框已显示（本会话）')
  const shown = await band($)
  expect(await shown.find({ type: 'Input' })).toBeDefined()
  await shown.unmount()

  expect((await $.command.run(anvil('translate'))).text).toBe('翻译框已隐藏')
  const again = await band($)
  expect(await again.find({ type: 'Input' })).toBeUndefined()
})

test('/anvil 列出 translate 子命令；旧写法 hide|show 按未知子命令处理', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)

  expect((await $.command.run(anvil(''))).text).toContain('/anvil translate  显示或隐藏翻译框（现在：显示）')
  expect((await $.command.run(anvil('translate hide'))).text).toStartWith('没有子命令 translate hide。')
})

test('有问卷占着那一栏时让出来', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await band($, { hasSurvey: true })

  expect(await ui.find({ type: 'Input' })).toBeUndefined()
})

test('桌面端也画翻译框', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'desktop', component: 'AbovePrompt', props: BAND })

  expect(await ui.find({ type: 'Input' })).toBeDefined()
})

/** 输入框占的宽度 */
async function fieldWidth(ui: Band) {
  return (await ui.find({ key: 'field:translate' }))?.props.width
}

/** 状态是否和输入框在同一行 */
async function besideField(ui: Band) {
  const row = await ui.find({ key: 'row:translate' })
  return JSON.stringify(row?.children ?? []).includes('status:translate')
}

test('各种宽度下框占满 band、不超宽；框里有字时状态在输入框下面，输入框占满 band 宽', async ($, on) => {
  const { backend } = engine(on)
  backend.model.result = { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: ZERO }
  await $.session.start(SESSION)
  // 40 列约是 110 列终端停靠面板后对话那一栏的宽度
  for (const columns of [40, 80, 160]) {
    const ui = await band($, { bodyColumns: columns })
    await ui.input({ key: (await field(ui)).key ?? '', text: CHINESE })
    const frame = await ui.find({ key: 'translate' })
    expect(frame?.props.width).toBe(columns)
    // 只有上下两条边框：引擎按整个 band 宽给 Input 排版，左右边框会让长句放不下
    expect((await ui.find({ key: 'title:translate' }))?.text).toMatch(/^── .*中→英 ─+$/)
    expect(cells((await ui.find({ key: 'title:translate' }))?.text ?? '')).toBe(columns)
    // 标题是正文色加粗，不沿用边框的颜色；失败时上下两条线是危险红
    const title = (await ui.findAll({ type: 'Text' })).find(one => one.text.endsWith('中→英'))
    expect(title?.props.bold).toBe(true)
    expect(title?.props.color).toBeUndefined()
    expect((await ui.find({ key: 'rule:translate' }))?.children?.[0]).toMatchObject({ props: { color: COLOR.danger } })
    expect(cells((await ui.find({ key: 'rule:translate' }))?.text ?? '')).toBe(columns)
    const status = await ui.find({ key: 'status:translate' })
    // 挪到下面时折成几行，原因不截断
    expect(status?.text.replace(/\s/g, '')).toContain('模型出错（500server_error）')
    expect(await besideField(ui), `${columns} 列的失败原因`).toBe(false)
    expect(Number(status?.props.width)).toBeLessThanOrEqual(columns)
    expect(await fieldWidth(ui), `${columns} 列的输入框`).toBe(columns)
    await ui.unmount()
  }
})

test('词数只数英文单词，不数标点', () => {
  expect(countWords(ENGLISH)).toBe(4)
  expect(countWords('Run `npm test` — then fix src/app.ts.')).toBe(6)
  expect(countWords('')).toBe(0)
})

test('追加的分隔：草稿为空或以换行结尾时不补，否则先补一个换行', () => {
  expect(appendText('', 'Hi.')).toBe('Hi.')
  expect(appendText('Done.\n', 'Hi.')).toBe('Hi.')
  expect(appendText('Done.', 'Hi.')).toBe('\nHi.')
  expect(appendText('Done. ', 'Hi.')).toBe('\nHi.')
})

test('接口地址填 base URL 或完整地址都行', () => {
  expect(apiEndpoint('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions')
  expect(apiEndpoint(' https://api.example.com/v1/ ')).toBe('https://api.example.com/v1/chat/completions')
  expect(apiEndpoint('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
})

test('追加之后敲下不只是空白的字才算开始下一句；失败时把送去翻译的中文画回新一代输入框', () => {
  const done = { ...EMPTY_BOX, phase: 'done' as const, text: CHINESE, words: 4 }
  expect(typed(done, ' \n')).toMatchObject({ phase: 'done', empty: false })
  expect(typed(done, '下')).toMatchObject({ phase: 'idle', words: 4, empty: false })
  expect(typed({ ...done, phase: 'idle' }, '')).toBeNull()

  const working = startTranslating(EMPTY_BOX, CHINESE)
  expect(working).toMatchObject({ phase: 'working', text: CHINESE, seed: '', empty: true })
  expect(failed(working, '出错')).toMatchObject({ phase: 'failed', reason: '出错', field: 1, seed: CHINESE, empty: false })
})
