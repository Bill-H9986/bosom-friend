import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  assertNever,
  deepEqualJson,
  deepFreeze,
  isJsonValue,
  snapshotJsonValue,
} from '../src/index.ts'

/**
 * 跨 realm JSON 校验、深冻结与快照的核心行为。
 *
 * 这个包被 llm / session / compaction 等核心包依赖，但此前**没有任何测试**；
 * 它处理的恰恰是最容易出微妙回归的部分：跨 realm 原型判定、循环引用检测、
 * -0/NaN/Infinity 拒绝、snapshot 与原对象解耦、AbortSignal 豁免。
 */

describe('isJsonValue', () => {
  it('接受 JSON 的全部标量', () => {
    for (const value of [null, true, false, 0, 1.5, -1, '', 'text'])
      expect(isJsonValue(value), JSON.stringify(value)).toBe(true)
  })

  it('拒绝非有限数与负零（JSON 往返会丢信息）', () => {
    expect(isJsonValue(Number.NaN)).toBe(false)
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isJsonValue(Number.NEGATIVE_INFINITY)).toBe(false)
    expect(isJsonValue(-0)).toBe(false)
    expect(isJsonValue(0)).toBe(true)
  })

  it('拒绝 undefined / 函数 / symbol / bigint', () => {
    expect(isJsonValue(undefined)).toBe(false)
    expect(isJsonValue(() => {})).toBe(false)
    expect(isJsonValue(Symbol('s'))).toBe(false)
    expect(isJsonValue(1n)).toBe(false)
  })

  it('拒绝循环引用（含自引用数组）', () => {
    const object: Record<string, unknown> = { a: 1 }
    object.self = object
    expect(isJsonValue(object)).toBe(false)
    const array: unknown[] = [1]
    array.push(array)
    expect(isJsonValue(array)).toBe(false)
  })

  it('接受嵌套结构，拒绝稀疏数组', () => {
    expect(isJsonValue({ a: [1, { b: null }] })).toBe(true)
    expect(isJsonValue([1, , 3])).toBe(false)
  })

  it('接受另一个 realm 的 Array / Object（跨 realm 不误判）', () => {
    const foreignArray = runInNewContext('[1, 2, 3]') as unknown
    const foreignObject = runInNewContext('({ a: 1 })') as unknown
    expect(isJsonValue(foreignArray)).toBe(true)
    expect(isJsonValue(foreignObject)).toBe(true)
    expect(isJsonValue({ list: foreignArray, map: foreignObject })).toBe(true)
  })

  it('拒绝伪装成数组/对象的原型', () => {
    const forged = Object.create(Array.prototype) as unknown[]
    expect(isJsonValue(forged)).toBe(false)
    class Sub extends Array {}
    expect(isJsonValue(new Sub())).toBe(false)
  })
})

describe('snapshotJsonValue', () => {
  it('返回与原对象解耦的深拷贝', () => {
    const original = { a: 1, nested: { b: [1, 2] } }
    const snap = snapshotJsonValue(original)!
    expect(snap).toEqual(original)
    expect(snap).not.toBe(original)
    expect(snap.nested).not.toBe(original.nested)
    original.a = 2
    original.nested.b.push(3)
    expect(snap.a).toBe(1)
    expect(snap.nested.b).toEqual([1, 2])
  })

  it('不可序列化的值返回 undefined（不抛错）', () => {
    expect(snapshotJsonValue(Number.NaN)).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(snapshotJsonValue(cyclic)).toBeUndefined()
  })

  it('快照结果自身也是合法 JSON 值', () => {
    const snap = snapshotJsonValue({ a: [1, { b: 'x' }] })
    expect(isJsonValue(snap)).toBe(true)
  })
})

describe('deepEqualJson', () => {
  it('按 JSON 结构比较而非引用', () => {
    expect(deepEqualJson({ a: [1, 2] }, { a: [1, 2] })).toBe(true)
    expect(deepEqualJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    // 键的数量参与比较：undefined 不是 JSON 值，多出一个键就是不同结构
    expect(deepEqualJson({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqualJson([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqualJson(null, null)).toBe(true)
    expect(deepEqualJson(null, {})).toBe(false)
  })
})

describe('deepFreeze', () => {
  it('递归冻结并可重复调用（循环引用不炸）', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.child = { name: 'leaf' }
    node.self = node
    deepFreeze(node)
    expect(Object.isFrozen(node)).toBe(true)
    expect(Object.isFrozen(node.child)).toBe(true)
    expect(() => deepFreeze(node)).not.toThrow()
  })

  it('豁免 AbortSignal（冻结会让它失去取消能力）', () => {
    const controller = new AbortController()
    const holder = { signal: controller.signal }
    deepFreeze(holder)
    expect(Object.isFrozen(holder)).toBe(true)
    expect(Object.isFrozen(controller.signal)).toBe(false)
    expect(() => { controller.abort() }).not.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })

  it('标量与 null 原样返回', () => {
    expect(deepFreeze(1)).toBe(1)
    expect(deepFreeze(null)).toBeNull()
    expect(deepFreeze('x')).toBe('x')
  })
})

describe('assertNever', () => {
  it('抛错并带上站点标签', () => {
    expect(() => assertNever('unexpected' as never, 'switch-site')).toThrow(/unreachable variant in switch-site/)
    expect(() => assertNever('x' as never)).toThrow(/unreachable variant: "x"/)
  })
})

/**
 * 剩下的分支出在"**不信任的输入**"这一侧：这些守卫是 `isJsonValue` 敢收外部值的依据，
 * 而它们各自只有一条路径——没有对应的畸形输入，就等于没人验过（逐文件 100% 覆盖率门禁要的就是这个）。
 */
describe('畸形输入上的守卫（逐文件 100% 覆盖的剩余分支）', () => {
  it('原型链上有一个"没有 constructor 的对象"时判否，而不是抛错', () => {
    // Object.create(null) 没有 constructor；把它当原型的那一层会让 hasIntrinsicConstructor 走 typeof !== 'function'
    const noConstructor = Object.create(null) as object
    expect(isJsonValue(Object.create(noConstructor))).toBe(false)
  })

  it('原型上的 constructor 是个已撤销的 Proxy 时判否（读 name 会抛，守卫要接住）', () => {
    const { proxy, revoke } = Proxy.revocable(function Array() {}, {})
    revoke()
    const fakeArrayPrototype: unknown[] = []
    Object.defineProperty(fakeArrayPrototype, 'constructor', { value: proxy, enumerable: true, configurable: true, writable: true })
    const value = [1, 2]
    Object.setPrototypeOf(value, fakeArrayPrototype)
    // 撤销的 Proxy：typeof 仍是 function、toString 回 native code，读 .name 才抛——守卫必须接住
    expect(() => isJsonValue(value)).not.toThrow()
    expect(isJsonValue(value)).toBe(false)
  })

  it('符号键与非枚举自有属性都判否（JSON 会静默丢掉它们）', () => {
    expect(isJsonValue({ a: 1, [Symbol('hidden')]: 2 })).toBe(false)
    const withHidden = Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false })
    expect(isJsonValue(withHidden)).toBe(false)
  })

  it('走到一半才被删掉的数组下标判否（逐项读取，不在开头一次判完）', () => {
    // 取第 0 项时删掉第 1 项：开头那次 ownKeys 计数是对的，走到第 1 项才发现它没了
    const value = [1, 2]
    Object.defineProperty(value, 0, {
      // 用 Reflect 而不是 delete 运算符：删的确实是数组元素，但 oxlint 的 no-array-delete 只认运算符
      get() { Reflect.deleteProperty(value, 1); return 1 },
      enumerable: true,
      configurable: true,
    })
    expect(isJsonValue(value)).toBe(false)
  })

  it('assertNever 拿到 JSON.stringify 会丢掉的值时，用 String 兜住消息', () => {
    expect(() => assertNever(undefined as never)).toThrow(/unreachable variant: undefined/)
  })
})
