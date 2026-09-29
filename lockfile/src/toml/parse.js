// A minimal, strict TOML 1.0 reader: the TOML that Cargo.toml, Cargo.lock,
// uv.lock, poetry.lock, pylock.toml and foundry.toml are written in, and
// nothing it does not read the way TOML does. Comments are dropped. What
// is read is value.js's to say; what is refused, it names, rather than
// read in some other way. Tables come back with a null prototype.
//
// A table is written once. `[a.b]` declares a.b, and makes a on the way,
// which a later `[a]` may still declare; `[[a]]` adds a table to the array
// a, and a header through a names that last table. Dotted keys make tables
// of their own, which the lines of their section may add to and no later
// header or dotted key may; a header may still make a table beneath one.
// Nothing adds to an array or an inline table written as a value.

import { TomlError, assert, excerpt } from './error.js'
import { atLineEnd, found, readKey, readKeyValue, setKey, skipComment, skipSpaces, takeNewline } from './value.js'

const isTable = (value) => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null

function kind(state, src, value) {
  if (state.arrays.has(value)) return 'an array of tables'
  if (Array.isArray(value)) return 'an array'
  if (isTable(value)) return src.fixed.has(value) ? 'an inline table' : 'a table'
  return 'a value'
}

const named = (keys) => excerpt(keys.join('.'))

// The tables a header names on its way: made where missing, and the last
// table of an array of tables where it names one.
function walk(state, src, keys) {
  let table = state.root
  for (const key of keys) {
    if (!(key in table)) {
      table[key] = Object.create(null)
      state.implicit.add(table[key])
    }
    const next = state.arrays.has(table[key]) ? table[key].at(-1) : table[key]
    assert(isTable(next) && !src.fixed.has(next), src, () => `${excerpt(key)} is ${kind(state, src, next)}, which a header cannot add to`)
    table = next
  }
  return table
}

function readHeader(state, src) {
  const array = src.text.startsWith('[[', src.pos)
  src.pos += array ? 2 : 1
  skipSpaces(src)
  const keys = readKey(src)
  skipSpaces(src)
  const close = array ? ']]' : ']'
  assert(src.text.startsWith(close, src.pos), src, () => `expected "${close}", found ${found(src)}`)
  src.pos += close.length
  state.pending.clear()
  const parent = walk(state, src, keys.slice(0, -1))
  const key = keys.at(-1)
  if (array) {
    if (!(key in parent)) {
      parent[key] = []
      state.arrays.add(parent[key])
    }
    assert(state.arrays.has(parent[key]), src, () => `${named(keys)} is ${kind(state, src, parent[key])}, not an array of tables`)
    state.current = Object.create(null)
    parent[key].push(state.current)
    return
  }
  if (key in parent) {
    assert(state.implicit.has(parent[key]), src, () => `${named(keys)} is ${kind(state, src, parent[key])} already`)
    state.implicit.delete(parent[key])
  } else {
    parent[key] = Object.create(null)
  }
  state.current = parent[key]
}

// A key/value line's key, dotted or not, in the table of its section.
function putDotted(state, src, keys, value) {
  let table = state.current
  for (const key of keys.slice(0, -1)) {
    if (key in table) {
      const next = table[key]
      assert(isTable(next) && !src.fixed.has(next), src, () => `${excerpt(key)} is ${kind(state, src, next)}, which a dotted key cannot add to`)
      assert(state.implicit.has(next) || state.pending.has(next), src, () => `${excerpt(key)} is a table declared elsewhere, which a dotted key cannot add to`)
      if (state.implicit.delete(next)) state.pending.add(next)
    } else {
      table[key] = Object.create(null)
      state.pending.add(table[key])
    }
    table = table[key]
  }
  setKey(src, table, keys.at(-1), value)
}

// A lone surrogate is no character at all, and a byte order mark is not
// TOML; both are refused where they are. So is U+FFFD, which TOML allows,
// but which a lenient decoder writes where bytes are not UTF-8: a file read
// that way would come back with its damage in its strings, read as text.
const DAMAGE = {
  __proto__: null,
  '\uFEFF': 'a byte order mark is not read',
  '\uFFFD': 'U+FFFD is not supported: a decoder puts it where bytes are not UTF-8',
}

function checkText(text) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const m = /\p{Cs}|^\uFEFF|\uFFFD/u.exec(text)
  if (m === null) return
  const line = text.slice(0, m.index).split('\n').length - 1
  throw new TomlError(DAMAGE[m[0]] ?? 'a lone surrogate is not well-formed Unicode', line)
}

export function parseToml(text) {
  checkText(text)
  const root = Object.create(null)
  const src = { text, pos: 0, line: 0, fixed: new WeakSet() }
  const state = { root, current: root, implicit: new WeakSet(), pending: new Set(), arrays: new WeakSet() }
  while (src.pos < text.length) {
    skipSpaces(src)
    if (text[src.pos] === '[') readHeader(state, src)
    else if (text[src.pos] !== '#' && text[src.pos] !== '\r' && !atLineEnd(src)) {
      const { keys, value } = readKeyValue(src, 0)
      putDotted(state, src, keys, value)
    }
    skipSpaces(src)
    skipComment(src)
    if (takeNewline(src)) continue
    assert(text[src.pos] !== '\r', src, 'a carriage return must be followed by a line feed')
    assert(src.pos === text.length, src, () => `expected the end of the line, found ${found(src)}`)
  }
  return root
}
