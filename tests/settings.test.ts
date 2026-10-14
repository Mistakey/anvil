import { expect, test } from 'claude-code/testing'

import { SESSION, world } from './world'

test('没改设置时各项取清单里的默认值', async ($, on) => {
  const { state } = world(on)
  await $.session.start(SESSION)

  expect(state.get('anvil.settings')).toEqual({
    showPanel: true,
    showTranslate: true,
    threshold: 50000,
    autoKeepalive: true,
    guard: true,
    translateBackend: 'haiku',
    translateApiUrl: '',
    translateApiModel: '',
  })
})

const GIVEN = {
  showPanel: false,
  showTranslate: false,
  threshold: 80000,
  autoKeepalive: false,
  guard: false,
  translateBackend: 'api',
  translateApiUrl: 'https://api.example.com/v1',
  translateApiModel: 'deepseek-chat',
}

test('给定的设置值经 options 传到模块', { options: GIVEN }, async ($, on) => {
  const { state } = world(on)
  await $.session.start(SESSION)

  expect(state.get('anvil.settings')).toEqual(GIVEN)
})

test('只给一部分设置时，其余取默认值', { options: { threshold: 120000, translateBackend: 'sonnet' } }, async ($, on) => {
  const { state } = world(on)
  await $.session.start(SESSION)

  expect(state.get('anvil.settings')).toEqual({
    showPanel: true,
    showTranslate: true,
    threshold: 120000,
    autoKeepalive: true,
    guard: true,
    translateBackend: 'sonnet',
    translateApiUrl: '',
    translateApiModel: '',
  })
})
