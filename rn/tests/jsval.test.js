import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { jsval } from '../src/jsval.js'

// The value the code jsval() gives evaluates to.
const evaluated = (value) => runInNewContext(`(${jsval(value)})`)

describe('jsval', () => {
  it('gives constants as JavaScript has them, JSON having none of some', () => {
    assert.deepEqual([Infinity, -Infinity, Number.NaN, undefined, null, true, 0, -1.5].map(jsval), ['Infinity', '-Infinity', 'NaN', 'undefined', 'null', 'true', '0', '-1.5'])
  })

  it('gives a key __proto__ as an object of its own has it: JSON.stringify() of it, in code, sets the prototype', () => {
    const own = JSON.parse('{"__proto__":1,"a":{"__proto__":[{"__proto__":2}]}}')
    assert.equal(jsval(own), '{["__proto__"]:1,"a":{["__proto__"]:[{["__proto__"]:2}]}}')
    const value = evaluated(own)
    // Its prototype Object.prototype (of the context it is evaluated in), whose own is null.
    assert.deepEqual([Object.hasOwn(value, '__proto__'), value.__proto__, Object.getPrototypeOf(Object.getPrototypeOf(value))], [true, 1, null])
    assert.equal(Object.hasOwn(runInNewContext(`(${JSON.stringify(own)})`), '__proto__'), false)
    // Not in a string.
    assert.equal(jsval({ a: '"__proto__":' }), '{"a":"\\"__proto__\\":"}')
  })

  it('escapes U+2028 and U+2029, which end a string literal in JavaScript before ES2019', () => {
    const text = 'a\u2028b\u2029c'
    assert.equal(jsval(text), '"a\\u2028b\\u2029c"')
    assert.equal(jsval({ [text]: text }), '{"a\\u2028b\\u2029c":"a\\u2028b\\u2029c"}')
    assert.equal(evaluated(text), text)
  })

  it('takes plain data alone', () => {
    for (const value of [() => {}, Symbol('s'), 1n, new Map(), new Date(0), Object.create(null), /a/u, new (class {})()]) assert.throws(() => jsval(value), /Unexpected/u, String(typeof value))
  })
})
