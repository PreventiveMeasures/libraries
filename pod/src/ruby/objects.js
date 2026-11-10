// What every value answers alike: to_s, inspect, ==, <=> and its truth, as Ruby 3.3 has them.

import { classOf, findMethod } from './classes.js'
import { hpairs, isNum, num } from './values.js'

const ESCAPES = { '"': String.raw`\"`, '\\': '\\\\', '\n': String.raw`\n`, '\t': String.raw`\t`, '\r': String.raw`\r`, '\u001B': String.raw`\e`, '\u0007': String.raw`\a`, '\b': String.raw`\b`, '\f': String.raw`\f`, '\v': String.raw`\v` }
// String#inspect: what a double-quoted literal would need escaped, and an interpolation's `#`.
export function inspectStr(s) {
  const body = s.replaceAll(/["\\\p{Cc}]|#(?=[{$@])/gu, (char) => {
    if (char === '#') return String.raw`\#`
    return ESCAPES[char] ?? (char === '\u007F' ? String.raw`\x7F` : `\\u${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  })
  return `"${body}"`
}

const PLAIN_SYMBOL = /^(?:[A-Za-z_][A-Za-z_0-9]*[?!=]?|\[\]=?|[+\-*/%<>!~^&|]|\*\*|<=>|===?|=~|![=~]|<=|>=|<<|>>|[+\-!~]@|\$[A-Za-z_0-9]+|@@?[A-Za-z_][A-Za-z_0-9]*)$/u
export const inspectSym = (name) => (PLAIN_SYMBOL.test(name) ? `:${name}` : `:${inspectStr(name)}`)

// Float#to_s: the shortest digits that read back, always with a fraction, and an exponent from 1e16 or below 1e-4.
export function floatToS(f) {
  if (Number.isNaN(f)) return 'NaN'
  if (!Number.isFinite(f)) return f > 0 ? 'Infinity' : '-Infinity'
  if (Object.is(f, -0)) return '-0.0'
  const abs = Math.abs(f)
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    const [mantissa, exponent] = f.toExponential().split('e')
    const sign = exponent.startsWith('-') ? '-' : '+'
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${sign}${exponent.replace(/^[+-]/u, '').padStart(2, '0')}`
  }
  const text = String(f)
  return text.includes('.') ? text : `${text}.0`
}

const userMethod = (it, v, name) => {
  const method = findMethod(it, v, name)
  return method !== undefined && !method.base ? method : undefined
}

export function inspect(it, v) {
  if (v === null) return 'nil'
  if (v === true || v === false || typeof v === 'number') return String(v)
  switch (v.t) {
    case 'str': return inspectStr(v.s)
    case 'sym': return inspectSym(v.name)
    case 'float': return floatToS(v.f)
    case 'arr': return `[${v.a.map((item) => inspect(it, item)).join(', ')}]`
    case 'hash': return v.map.size === 0 ? '{}' : `{${hpairs(v).map(([k, value]) => `${inspect(it, k)}=>${inspect(it, value)}`).join(', ')}}`
    case 'range': return `${inspect(it, v.b)}${v.excl ? '...' : '..'}${v.e === null ? '' : inspect(it, v.e)}`
    case 'regexp': return `/${v.src}/${v.flags}`
    case 'class': return v.name
    case 'proc': return v.lambda ? '#<Proc (lambda)>' : '#<Proc>'
    default: return userMethod(it, v, 'inspect') ? it.send(v, 'inspect').s : inspectObj(it, v)
  }
}
function inspectObj(it, v) {
  if (userMethod(it, v, 'to_s')) return it.send(v, 'to_s').s
  const ivars = [...v.iv].map(([name, value]) => ` ${name}=${inspect(it, value)}`).join(',')
  return `#<${classOf(it, v).name}${ivars}>`
}

// to_s as an interpolation takes it.
export function tos(it, v) {
  if (v === null) return ''
  if (v === true || v === false || typeof v === 'number') return String(v)
  switch (v.t) {
    case 'str': return v.s
    case 'sym': return v.name
    case 'float': return floatToS(v.f)
    case 'class': return v.name
    case 'obj': {
      const text = it.send(v, 'to_s')
      return text?.t === 'str' ? text.s : `#<${classOf(it, v).name}>`
    }
    default: return inspect(it, v)
  }
}

export function eq(it, a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a === 'boolean' || typeof b === 'boolean') return false
  if (isNum(a)) return isNum(b) && num(a) === num(b)
  if (typeof b !== 'object') return false
  switch (a.t) {
    case 'str': return b.t === 'str' && a.s === b.s
    case 'arr': return b.t === 'arr' && a.a.length === b.a.length && a.a.every((item, i) => eq(it, item, b.a[i]))
    case 'hash': return b.t === 'hash' && a.map.size === b.map.size && [...a.map].every(([key, [, value]]) => b.map.has(key) && eq(it, value, b.map.get(key)[1]))
    case 'range': return b.t === 'range' && a.excl === b.excl && eq(it, a.b, b.b) && eq(it, a.e, b.e)
    case 'obj': return userMethod(it, a, '==') ? it.truthy(it.send(a, '==', [b])) : false
    default: return false
  }
}

// Strings by their code points, which is the order of their UTF-8 bytes.
export function cmpStr(a, b) {
  if (a === b) return 0
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i].codePointAt(0) < y[i].codePointAt(0) ? -1 : 1
  return Math.sign(x.length - y.length)
}

// <=>, or undefined where the two do not compare.
export function cmp(it, a, b) {
  if (isNum(a) && isNum(b)) return Math.sign(num(a) - num(b))
  if (a?.t === 'str' && b?.t === 'str') return cmpStr(a.s, b.s)
  if (a?.t === 'sym' && b?.t === 'sym') return cmpStr(a.name, b.name)
  if (a?.t === 'arr' && b?.t === 'arr') {
    for (let i = 0; i < a.a.length && i < b.a.length; i++) {
      const order = cmp(it, a.a[i], b.a[i])
      if (order !== 0) return order
    }
    return Math.sign(a.a.length - b.a.length)
  }
  if (a?.t === 'obj' && findMethod(it, a, '<=>')) {
    const order = it.send(a, '<=>', [b])
    return order === null ? undefined : order
  }
  return a === b ? 0 : undefined
}
export function compare(it, a, b) {
  const order = cmp(it, a, b)
  if (order === undefined) it.raise('ArgumentError', `comparison of ${classOf(it, a).name} with ${b === null ? 'nil' : classOf(it, b).name} failed`)
  return order
}
