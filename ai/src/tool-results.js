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

// What JSON carries as itself. `Number.isFinite` rather than `typeof === 'number'`: JSON has no
// spelling for NaN or either Infinity and renders all three `null`, which is the same silent loss a
// Map or a Date is refused for one line below — a tool averaging over an empty set or dividing by a
// zero denominator would otherwise hand the model `null` with nothing saying the number was lost,
// and the cache would keep the `null` as the answer.
const SCALARS = new Set(['boolean', 'string'])
const isScalar = (value) => value === null
  || SCALARS.has(typeof value)
  || (typeof value === 'number' && Number.isFinite(value))

function nameOf(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  // NaN / Infinity / -Infinity name themselves; `Number` would say nothing about what is wrong.
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
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
// how a Date is still a Date here.
//
// Returns the JSON it built rather than dropping it. The caller needs that string anyway — parsed
// back, it is the snapshot the entry stores, which is what keeps the cached answer a value of this
// turn alone instead of a reference into whatever the handler still holds. A string answer is its
// own JSON and comes straight back.
export function assertToolResult(value, what) {
  if (typeof value === 'string') return value
  assertPlainData(value, what)
  return JSON.stringify(value, function node(key, encoded) {
    const raw = this[key]
    // Tested before the message is built rather than handed to `assert` as its second argument:
    // that argument is evaluated at every node whether or not it is needed, so a large result paid
    // for a template concat and a nameOf() prototype walk per key to describe a failure it did not
    // have.
    if (!isPlainData(raw) && !isScalar(raw)) {
      assert(false, `${what} holds ${nameOf(raw)} at \`${key}\`, which JSON does not carry whole`)
    }
    return encoded
  })
}

// The string the wire gets — every adapter takes one, so this is the last point that is still the
// layer and not the wire. A value off disk went through JSON.parse and is plain by construction,
// which is why the deep check is not repeated here; this is the conversion, plus a backstop for a
// stored value written before that check existed.
//
// Which is why a scalar passes here and not in assertToolResult: a build before that check let a
// handler return a number, or nothing at all, and those are on disk as `42` and `null`. Refusing
// them here refuses to REPLAY a partial that has already been paid for — resumeFrom reads the throw
// as an unusable history, retires it, and the conversation is bought again — while `42` on the wire
// is what those builds sent anyway. The live path never reaches this leniency: assertToolResult has
// already judged the value the handler just returned.
export function toWireResult(result) {
  if (typeof result === 'string') return result
  assert(
    isPlainData(result) || isScalar(result),
    `A stored tool result must be a string, plain data (an object or an array) or a scalar, got ${nameOf(result)}`,
  )
  return JSON.stringify(result)
}
