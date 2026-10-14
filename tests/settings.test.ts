import { expect, test } from 'claude-code/testing'

import { SESSION, world } from './world'

test('没改设置时各项取清单里的默认值', async ($, on) => {
  const { state } = world(on)
  await $.session.start(SESSION)

  expect(state.get('anvil.settings')).toEqual({ threshold: 50000, autoKeepalive: true, guard: true })
})

const GIVEN = { threshold: 80000, autoKeepalive: false, guard: false }

test('给定的设置值经 options 传到模块', { options: GIVEN }, async ($, on) => {
  const { state } = world(on)
  await $.session.start(SESSION)

  expect(state.get('anvil.settings')).toEqual(GIVEN)
})

test('只给一部分设置时，其余取默认值', { options: { threshold: 120000 } }, async ($, on) => {
  const { state } = world(on)
  await $.session.start(SESSION)

  expect(state.get('anvil.settings')).toEqual({ threshold: 120000, autoKeepalive: true, guard: true })
})
