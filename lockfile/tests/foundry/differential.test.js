import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError } from '../../src/error.js'
import { readConfig } from '../../src/foundry/config.js'
import { gitConfig, hasGit } from './reference.js'

// git's own reader against this one, over documents made at random: the
// fixtures' .gitmodules with edits, and documents put together from what git
// writes and what it does not. Every document read here git reads, to the
// same keys and values in the same order; every one git refuses is refused
// here; and the one thing refused here that git reads is space within a
// value, which git reads one way before 2.45 and another since. The seeds
// are fixed, so a failure names its document and comes back on a rerun.

const FIXTURES = new URL('fixtures/', import.meta.url)
const FILES = readdirSync(FIXTURES).filter((name) => name.endsWith('.gitmodules')).sort()
const TWO_WAYS = /which git reads as a space before 2\.45 and as itself since/u

// A linear congruential generator, its product taken in 32 bits.
function random(seed) {
  let state = seed
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) & 0x7FFF_FFFF) / 2 ** 31
  return { next, pick: (list) => list[Math.floor(next() * list.length)] }
}

const HEADERS = [
  '[submodule "lib/a"]', '[submodule "lib/b"]', '[Submodule "X"]', '[submodule  "q\\"x"]', '[submodule\t"t"]', '[submodule "a\\\\b"]',
  '[submodule "a\\x"]', '[submodule.x]', '[submodule.X.y]', '[core]', '[a-b.c]', '[]', '[ "x"]', '[submodule "x" ]', '[submodule "x"',
  '[submodule x]', '[sub"x"]', '[submodule "x"]path = y', '[submodule "é"]', '[sub_x]', '[.]', '[submodule ""]', '[submodule "a#b"]',
  '[submodule "x"] # c', '[submodule "x"];c', '[submodule "x"]]', '[submodule\n"x"]', '[submodule "x\\', '[SUBMODULE "a"]',
]
const KEYS = ['path', 'url', 'branch', 'PATH', 'Url', 'fetchRecurseSubmodules', 'a-b', 'a_b', '1x', 'x1', 'é', '-x', 'update', 'shallow', 'k']
const SEPS = [' = ', ' = ', ' = ', '=', ' =', '= ', '\t=\t', '', ' ', '  =  ', ' : ', '\t', ' =\t']
const VALUES = [
  'lib/a', 'https://github.com/a/b', 'git@github.com:a/b.git', '"quoted"', '"a b"', 'a b', 'a  b', 'a\tb', '"a\tb"', 'a # c', 'a;c',
  '"a#b"', '"a;b"', 'a\\"b', 'a\\\\b', 'a\\tb', 'a\\nb', 'a\\bb', 'a\\xb', 'a\\', '"unterminated', '"a\\\nb"', 'a \\\n b', 'a\\\nb',
  '""', '', ' ', 'a ', 'a\t', 'é', 'a"b"c', '"a"b', '  lead', 'a\rb', '"a" "b"', '" x "', '"" x', 'x ""', 'a\\ b', '\\"', 'true', '0',
  'a\u00A0b', 'a\u2028b', '"\\\\"', 'a\\\r\nb',
]
const TRAILS = ['', '', '', ' ', '\t', ' # c', ' ; c', '#', ' #\t"', '\\', ' \\']
const EXTRAS = ['# comment', '; comment', '', '   ', '\t# c', 'junk', '=x', '[', ']', '\t', '"x"', '#[submodule "y"]', '1 = 2', '\\']
const ENDS = ['\n', '\n', '\n', '\n', '\r\n', '\r', '']

// Documents put together from lines of each kind, each piece most often one
// of the first of its list, which git reads.
function assemble({ next, pick }) {
  const some = (list, good) => (next() < 0.8 ? list[Math.floor(next() * good)] : pick(list))
  let doc = next() < 0.02 ? '\uFEFF' : ''
  const count = 1 + Math.floor(next() * 8)
  for (let i = 0; i < count; i++) {
    const r = next()
    if (r < 0.25) doc += some(HEADERS, 6)
    else if (r < 0.9) doc += `${pick(['\t', '\t', '', ' ', '  \t'])}${some(KEYS, 6)}${some(SEPS, 7)}${some(VALUES, 15)}${some(TRAILS, 7)}`
    else doc += pick(EXTRAS)
    doc += some(ENDS, 5)
  }
  return doc
}

// Characters in any order, of those that mean something to git.
function scramble({ next, pick }) {
  const chars = ['[', ']', '"', '\\', ' ', '\t', '\n', '\r', '=', '#', ';', '.', 'a', 'b', '-', 'é', 's']
  return Array.from({ length: Math.floor(next() * 24) }, () => pick(chars)).join('')
}

// A fixture with one edit: a character put in, taken out or swapped.
function edit({ next, pick }, text) {
  const pos = Math.floor(next() * (text.length + 1))
  const char = pick([' ', '\t', '\n', '\r', '"', '\\', '#', ';', '=', '[', ']', '.', 'a', 'é', '\r\n'])
  const r = next()
  if (r < 0.4) return `${text.slice(0, pos)}${char}${text.slice(pos)}`
  if (r < 0.7) return `${text.slice(0, pos)}${text.slice(pos + 1)}`
  return `${text.slice(0, pos)}${char}${text.slice(pos + 1)}`
}

const nameOf = ({ section, subsection, key }) => [section, subsection, key].filter((part) => part !== undefined).join('.')

// How many of the documents both read.
function compare(docs) {
  const reference = gitConfig(docs)
  let read = 0
  for (const [index, doc] of docs.entries()) {
    const git = reference[index]
    let mine
    try {
      mine = readConfig(doc, undefined).map((entry) => [nameOf(entry), entry.value])
    } catch (error) {
      assert.ok(error instanceof LockfileError, `${JSON.stringify(doc)}: ${error}`)
      if (TWO_WAYS.test(error.message)) continue
      assert.ok(git.error, `${JSON.stringify(doc)} is refused here, ${error.message}, and git reads it as ${JSON.stringify(git.entries)}`)
      continue
    }
    assert.ok(!git.error, `${JSON.stringify(doc)} is read here as ${JSON.stringify(mine)}, and git refuses it`)
    assert.deepEqual(mine, git.entries, JSON.stringify(doc))
    read++
  }
  return read
}

describe('git config against the reader of .gitmodules', { skip: !hasGit && 'no git' }, () => {
  it('reads the fixtures as git does', () => {
    const docs = FILES.map((name) => readFileSync(new URL(name, FIXTURES), 'utf8'))
    assert.equal(compare(docs), docs.length)
  })

  it('reads the fixtures with an edit as git does, or refuses them as git does', () => {
    const rand = random(0x9175)
    const bases = FILES.map((name) => readFileSync(new URL(name, FIXTURES), 'utf8')).filter((text) => text !== '')
    const docs = Array.from({ length: 1000 }, () => edit(rand, rand.pick(bases)))
    assert.ok(compare(docs) > 300)
  })

  it('reads documents of every piece as git does, or refuses them as git does', () => {
    const rand = random(0x6170)
    const docs = Array.from({ length: 2500 }, () => assemble(rand))
    assert.ok(compare(docs) > 1000)
  })

  it('reads characters in any order as git does, or refuses them as git does', () => {
    const rand = random(0x2e43)
    const docs = Array.from({ length: 1500 }, () => scramble(rand))
    assert.ok(compare(docs) > 100)
  })
})
