// A minimal, strict TOML 1.0 reader: the TOML that Cargo.toml, Cargo.lock,
// uv.lock, poetry.lock, pylock.toml and foundry.toml are written in, and
// nothing it does not read the way TOML does. Comments are dropped. What
// a line holds is value.js's to read, and where it goes is said here; what
// is refused, either names, rather than read in some other way. Tables come
// back with a null prototype.
//
// A table is written once. `[a.b]` declares a.b, and makes a on the way,
// which a later `[a]` may still declare; `[[a]]` adds a table to the array
// a, and a header through a names that last table. Dotted keys make tables
// of their own, which the lines of their section may add to and no later
// header or dotted key may; a header may still make a table beneath one.
// Nothing adds to an array or an inline table written as a value.

import { TomlError, assert, excerpt } from './error.js'
import { endLine, readLine, setKey } from './value.js'

const isTable = (value) => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null

function kind(state, value) {
  if (state.arrays.has(value)) return 'an array of tables'
  if (Array.isArray(value)) return 'an array'
  if (isTable(value)) return state.fixed.has(value) ? 'an inline table' : 'a table'
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
    assert(isTable(next) && !state.fixed.has(next), src, () => `${excerpt(key)} is ${kind(state, next)}, which a header cannot add to`)
    table = next
  }
  return table
}

function putHeader(state, src, keys, array) {
  state.pending.clear()
  const parent = walk(state, src, keys.slice(0, -1))
  const key = keys.at(-1)
  if (array) {
    if (!(key in parent)) {
      parent[key] = []
      state.arrays.add(parent[key])
    }
    assert(state.arrays.has(parent[key]), src, () => `${named(keys)} is ${kind(state, parent[key])}, not an array of tables`)
    state.current = Object.create(null)
    parent[key].push(state.current)
    return
  }
  if (key in parent) {
    assert(state.implicit.has(parent[key]), src, () => `${named(keys)} is ${kind(state, parent[key])} already`)
    state.implicit.delete(parent[key])
  } else {
    parent[key] = Object.create(null)
  }
  state.current = parent[key]
}

// A key/value line's key, dotted or not, in the table of its section. An
// inline table written there is fixed: nothing adds to it later.
function putDotted(state, src, keys, value) {
  let table = state.current
  for (const key of keys.slice(0, -1)) {
    if (key in table) {
      const next = table[key]
      assert(isTable(next) && !state.fixed.has(next), src, () => `${excerpt(key)} is ${kind(state, next)}, which a dotted key cannot add to`)
      assert(state.implicit.has(next) || state.pending.has(next), src, () => `${excerpt(key)} is a table declared elsewhere, which a dotted key cannot add to`)
      if (state.implicit.delete(next)) state.pending.add(next)
    } else {
      table[key] = Object.create(null)
      state.pending.add(table[key])
    }
    table = table[key]
  }
  setKey(src, table, keys.at(-1), value)
  if (isTable(value)) state.fixed.add(value)
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
  const src = { text, pos: 0, line: 0 }
  // The tables a header made on its way, which a later one may declare;
  // those dotted keys made or entered in this section; the arrays of
  // tables; and the inline tables written as a line's value.
  const state = { root, current: root, implicit: new Set(), pending: new Set(), arrays: new Set(), fixed: new Set() }
  while (src.pos < text.length) {
    const line = readLine(src)
    if (line?.value !== undefined) putDotted(state, src, line.keys, line.value)
    else if (line !== undefined) putHeader(state, src, line.keys, line.array)
    endLine(src)
  }
  return root
}
