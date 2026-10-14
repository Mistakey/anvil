// 读 `$.state` 时合并到默认值上（照 flightdeck 的 normalize，https://github.com/scasella/claude-flightdeck，
// MIT License, Copyright (c) 2026 Stephen Casella）：热重载不清 `$.state`，上一次加载按旧形状写下的值、
// 缺字段的值，读出来都补成现在的形状，钩子不因此抛错（anvil-k0t.53）。register.ts 读写 atom 时经 normalized / normalizing。
//
// 形状照默认值写：对象按字段合并（多出来的旧字段留着），数字、字符串、布尔类型不对就取默认，
// 默认值是 null 的字段什么都收；数组默认什么项都收。要细到每一项的，用 maybe、listOf、recordOf、fit。

import { EMPTY_TALLY } from './speed'
import type { Atom } from 'claude-code'

const MARK = Symbol('shape')

type Marked =
  | { [MARK]: 'maybe'; shape: unknown }
  | { [MARK]: 'list'; shape: unknown }
  | { [MARK]: 'record'; shape: unknown }
  | { [MARK]: 'fit'; fit: (stored: unknown) => unknown }

/** null，或按里面的形状合并的对象 */
export const maybe = (shape: object): Marked => ({ [MARK]: 'maybe', shape })
/** 每一项按形状合并；类型不对的项丢掉 */
export const listOf = (shape: unknown): Marked => ({ [MARK]: 'list', shape })
/** 键随意、每个值按形状合并的对象；不是对象的值丢掉 */
export const recordOf = (shape: object): Marked => ({ [MARK]: 'record', shape })
/** 自己认：给存着的值，返回现在的形状 */
export const fit = (fn: (stored: unknown) => unknown): Marked => ({ [MARK]: 'fit', fit: fn })

/** 几个取值之一，认不出就取第一个 */
export const oneOf = (values: readonly string[]): Marked => fit(stored => (typeof stored === 'string' && values.includes(stored) ? stored : values[0]))

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isMarked = (v: unknown): v is Marked => isObject(v) && MARK in v

/** 存着的值和形状是不是同一类：对象对对象，其余比 typeof */
function isKind(shape: unknown, stored: unknown): boolean {
  const plain = isMarked(shape) && shape[MARK] !== 'fit' ? shape.shape : shape
  if (isObject(plain)) return isObject(stored)
  return typeof stored === typeof plain && stored !== null
}

/** 把存着的值合并到形状给的默认值上；读不到（undefined）时就是默认值 */
export function conform(shape: unknown, stored: unknown): unknown {
  if (isMarked(shape)) {
    switch (shape[MARK]) {
      case 'maybe':
        return isObject(stored) ? conform(shape.shape, stored) : null
      case 'list':
        return Array.isArray(stored) ? stored.filter(item => isKind(shape.shape, item)).map(item => conform(shape.shape, item)) : []
      case 'record':
        return isObject(stored)
          ? Object.fromEntries(Object.entries(stored).filter(([, value]) => isObject(value)).map(([key, value]) => [key, conform(shape.shape, value)]))
          : {}
      case 'fit':
        return shape.fit(stored)
    }
  }
  if (shape === null) return stored === undefined ? null : stored
  if (Array.isArray(shape)) return Array.isArray(stored) ? stored : shape
  if (isObject(shape)) {
    const from = isObject(stored) ? stored : {}
    const merged: Record<string, unknown> = { ...from }
    for (const [key, value] of Object.entries(shape)) merged[key] = conform(value, from[key])
    return merged
  }
  return typeof stored === typeof shape ? stored : shape
}

// ---------------------------------------------------------------- 各 atom 的形状（types/index.d.ts）

const GIT = {
  repo: '',
  worktree: null,
  sub: '',
  branch: null,
  commit: null,
  noUpstream: false,
  ahead: 0,
  behind: 0,
  conflicts: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  stashes: 0,
  lines: maybe({ added: 0, deleted: 0 }),
  operation: maybe({ name: '' }),
}

/** 形状会变、要细到每一项的 atom（按 `$.state` 里的键）；其余按 atom 的初始值合并 */
const SHAPES: Record<string, unknown> = {
  usage: { rateLimits: listOf({ kind: '', percentUsed: 0 }), costUsd: null },
  place: { dir: '', git: maybe(GIT) },
  keepalive: { stopped: maybe({ kind: oneOf(['error', 'limit', 'reading']), reason: '' }), renewing: false, inFlight: false },
  runningAgents: listOf(''),
  turnSpeeds: {
    current: maybe({ turnId: '', tally: EMPTY_TALLY, firstTokenMs: 0 }),
    lines: recordOf({ tally: EMPTY_TALLY, firstTokenMs: 0, doneAt: 0, waitingAgents: 0 }),
  },
}

/** `$.state` 里 anvil 的一个键读到的值，合并成现在的形状；initial 是 atom 的初始值 */
export function conformState(key: string, initial: unknown, stored: unknown): unknown {
  return conform(Object.hasOwn(SHAPES, key) ? SHAPES[key] : initial, stored)
}

/** 读到的值合并成现在的形状：`normalized(place, await read($, place))`（`read` 要在调用处直接写 atom，扫描才认） */
export function normalized<T>(target: Atom<T>, value: T): T {
  return conformState(target.ref.key, target.initial, value) as T
}

/** update 的改法先拿到合并后的值：`update($, place, normalizing(place, current => …))` */
export function normalizing<T>(target: Atom<T>, change: (value: T) => T): (value: T) => T {
  return value => change(normalized(target, value))
}
