import { assert } from '#assert'

// What a tool is allowed to answer with, and how that reaches the wire. Its own module because the
// rule is this layer's rather than any format's: every adapter takes a string, and the choice to
// let a tool hand back structure — and to keep that structure in the cache — is made above them.

// A tool may answer with plain data rather than a string — a directory listing, a row set — and
// the cache keeps that as structure, which is worth far more to read than the same thing escaped
// inside a string. Plain is literal: an object or an array, nothing carrying a prototype of its
// own, since a Map or a class instance has a shape JSON.stringify quietly loses.
function isPlainData(value) {
  if (value === null || value === undefined) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === Array.prototype
}

const isScalar = (value) => value === null || ['boolean', 'number', 'string'].includes(typeof value)

function nameOf(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return Object.getPrototypeOf(value)?.constructor?.name ?? 'an object with no prototype'
}

// The rule at the top of a result, in one place so the two callers say the same sentence.
function assertPlainData(value, what) {
  assert(isPlainData(value), `${what} must be a string or plain data (an object or an array), got ${nameOf(value)}`)
}

// The same rule all the way down, for a value as a tool just handed it over: one level of nesting
// loses exactly as much as the top level does, and as silently — `{ rows: new Map() }` reaches the
// model as `{"rows":{}}`, a Date as its ISO string, a key holding undefined not at all. The walk
// rides JSON.stringify's own traversal, which is also what turns a cycle into a thrown TypeError
// rather than a hang, and `this[key]` is the value before any toJSON hook rewrote it — which is
// how a Date is still a Date here. The string it builds is thrown away; what reaches the wire is
// built by toWireResult, possibly in another process, off the copy the cache kept.
export function assertToolResult(value, what) {
  if (typeof value === 'string') return
  assertPlainData(value, what)
  JSON.stringify(value, function node(key, encoded) {
    const raw = this[key]
    assert(isPlainData(raw) || isScalar(raw), `${what} holds ${nameOf(raw)} at \`${key}\`, which JSON does not carry whole`)
    return encoded
  })
}

// The string the wire gets — every adapter takes one, so this is the last point that is still the
// layer and not the wire. A value off disk went through JSON.parse and is plain by construction,
// which is why the deep check is not repeated here; this is the conversion, plus a backstop for a
// stored value written before that check existed.
export function toWireResult(result) {
  if (typeof result === 'string') return result
  assertPlainData(result, 'A tool result')
  return JSON.stringify(result)
}
