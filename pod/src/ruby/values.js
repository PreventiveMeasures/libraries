// Ruby's values as the evaluator holds them: nil is null, true and false themselves, an Integer a number; the rest
// are objects tagged by `t` -- 'str', 'sym', 'float', 'arr', 'hash', 'range', 'proc', 'regexp', 'obj', 'class'.

// What Ruby the evaluator does not take: refused, never guessed at. `at` is "file:line" where it is known.
export class RubyUnsupported extends Error {
  constructor(message, at) {
    super(at ? `${at}: ${message}` : message)
    this.name = 'RubyUnsupported'
    this.detail = message
    this.at = at
  }
}

const SYMBOLS = new Map()
export const str = (s) => ({ t: 'str', s })
export function sym(name) {
  let symbol = SYMBOLS.get(name)
  if (symbol === undefined) SYMBOLS.set(name, symbol = Object.freeze({ t: 'sym', name }))
  return symbol
}
export const float = (f) => ({ t: 'float', f })
export const arr = (a = []) => ({ t: 'arr', a })
export const range = (b, e, excl = false) => ({ t: 'range', b, e, excl })

export const isStr = (v) => v?.t === 'str'
export const isSym = (v) => v?.t === 'sym'
export const isArr = (v) => v?.t === 'arr'
export const isHash = (v) => v?.t === 'hash'
export const isInt = (v) => typeof v === 'number'
export const isFloat = (v) => v?.t === 'float'
export const isNum = (v) => typeof v === 'number' || v?.t === 'float'
export const isProc = (v) => v?.t === 'proc'
export const isClass = (v) => v?.t === 'class'
export const truthy = (v) => v !== null && v !== false && v !== undefined
export const num = (v) => (typeof v === 'number' ? v : v.f)

let ids = 0
export function idOf(v) {
  if (v.id === undefined) Object.defineProperty(v, 'id', { value: ++ids })
  return v.id
}

// A value as a Hash's key: strings, symbols, numbers and arrays by what they hold, as their eql? and hash have
// them; anything else by itself.
export function keyOf(v) {
  if (v === null) return 'n'
  if (v === true) return 'T'
  if (v === false) return 'F'
  if (typeof v === 'number') return `i${v}`
  if (v.t === 'str') return `s${v.s}`
  if (v.t === 'sym') return `y${v.name}`
  if (v.t === 'float') return `f${v.f}`
  if (v.t === 'arr') return `a${v.a.map((item) => { const key = keyOf(item); return `${key.length}:${key}` }).join('')}`
  return `o${idOf(v)}`
}

export function hash(pairs = []) {
  const h = { t: 'hash', map: new Map(), def: null, defProc: null }
  for (const [k, v] of pairs) hset(h, k, v)
  return h
}
// A String key is copied and frozen, as Hash#[]= does, so that a later change of the string is not one of the key.
export function hset(h, k, v) {
  const key = keyOf(k)
  const entry = h.map.get(key)
  if (entry === undefined) h.map.set(key, [isStr(k) && !k.frozen ? { t: 'str', s: k.s, frozen: true } : k, v])
  else entry[1] = v
  return v
}
export const hget = (h, k) => h.map.get(keyOf(k))?.[1]
export const hhas = (h, k) => h.map.has(keyOf(k))
export function hdel(h, k) {
  const key = keyOf(k)
  const entry = h.map.get(key)
  h.map.delete(key)
  return entry?.[1]
}
export const hpairs = (h) => [...h.map.values()]
export const hkeys = (h) => hpairs(h).map(([k]) => k)
export const hvals = (h) => hpairs(h).map(([, v]) => v)

// What unwinds the evaluator: break, next, return, throw and a raised exception, each a plain object thrown.
export const signal = (sig, value, tag) => ({ sig, value, tag })
export const isSignal = (error, sig) => error !== null && typeof error === 'object' && error.sig === sig
