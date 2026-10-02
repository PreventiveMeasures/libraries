import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePodfileLock } from '../../cocoapods.js'
import { checkDescription } from '../../src/cocoapods/external.js'
import { layout } from '../../src/cocoapods/layout.js'
import { psychRead } from '../../src/cocoapods/psych.js'
import { readExternalSource } from '../../src/cocoapods/sources.js'
import { parseCocoaYaml } from '../../src/cocoapods/yaml.js'
import { random } from '../random.js'
import { FIXTURES } from './fixtures.js'
import { cocoapods, coreVersion } from './reference.js'

// cocoapods-core, which writes and reads every Podfile.lock, against the
// reader here: over the fixtures, which Pod::Lockfile reads as the reader
// here does; and over inputs made at random from pieces: trees of the
// values a Podfile.lock holds, which YAMLHelper writes and Psych reads
// back; plain scalars, which Psych types; and external sources, which
// Dependency#to_s describes. Skipped where ruby or cocoapods-core is
// missing; GEM_PATH may say where cocoapods-core is. The seeds are fixed.

const VERSION = coreVersion()
const SKIP = VERSION === undefined && 'no ruby with cocoapods-core'
const [, MINOR] = (VERSION ?? '1.0').split('.').map(Number)
const RULES = { yesNo: MINOR >= 10, dates: MINOR >= 13 }

const SECTIONS = ['PODS', 'DEPENDENCIES', 'SPEC REPOS', 'EXTERNAL SOURCES', 'CHECKOUT OPTIONS', 'SPEC CHECKSUMS', 'PODFILE CHECKSUM', 'COCOAPODS']

// Pieces of strings: what YAMLHelper writes plain, what it quotes, and
// what Psych types; no control or format character, which the reader
// refuses outright.
const PIECES = [
  'Alamofire', 'a', 'B', 'z', '1', '0', '9', '.', '-', '_', ' ', ':', ': ', '/', '(', ')', '~', '<', '>', '=', '`', ',',
  '+', '!', '#', '#{', '#$', '@', '&', '*', '?', '%', '|', "'", '"', '\\', '[', ']', '{', '}', ';', '^',
  'é', '日本', '😀', ' ', 'Σ', 'ǅ', 'İ', 'K',
  'yes', 'No', 'ON', 'off', 'true', 'False', 'null', 'nUll', '~', '1.0', '1,000', '1_0', '1:30', '0x1F', '017', '1e5', '.inf',
  '2026-10-02', '2026-1-2 3:04:05', '(~> 1.0)', ' (from `../a`)', 'https://example.com/a.git',
]
const SYMBOLS = ['git', 'path', 'tag', 'commit', 'branch', 'http', 'type', 'podspec', 'a_b', 'x1']

function string({ next, pick }) {
  const count = Math.floor(next() * 4)
  return Array.from({ length: count }, () => pick(PIECES)).join('')
}

const s = (text) => ({ s: text })
const scalar = (generator) => (generator.next() < 0.8 ? s(string(generator)) : { y: generator.pick(SYMBOLS) })

// Distinct keys, each tagged as the tree is.
function keys(generator, count, symbols) {
  const seen = new Set()
  const list = []
  for (let i = 0; i < count * 2 && list.length < count; i++) {
    const key = symbols && generator.next() < 0.5 ? { y: generator.pick(SYMBOLS) } : s(string(generator) || 'k')
    const id = JSON.stringify(key)
    if (!seen.has(id)) {
      seen.add(id)
      list.push(key)
    }
  }
  return list
}

// A tree of what a Podfile.lock holds, an empty collection among it, as
// `:headers => []` is; of no sequence in a sequence, no boolean in a
// sequence, and no empty mapping in one, none of which it holds, and the
// last two of which YAMLHelper fails to sort.
function made(generator, depth) {
  const roll = generator.next()
  if (depth >= 3 || roll < 0.4) return generator.next() < 0.1 ? { b: generator.next() < 0.5 } : scalar(generator)
  if (roll < 0.45) return generator.next() < 0.5 ? { a: [] } : { m: [] }
  if (roll < 0.7) return { a: Array.from({ length: 1 + Math.floor(generator.next() * 3) }, () => listed(generator, depth + 1)) }
  return { m: keys(generator, 1 + Math.floor(generator.next() * 3), true).map((key) => [key, made(generator, depth + 1)]) }
}

function listed(generator, depth) {
  if (depth >= 3 || generator.next() < 0.6) return scalar(generator)
  return { m: keys(generator, generator.next() < 0.7 ? 1 : 2, true).map((key) => [key, made(generator, depth + 1)]) }
}

function tree(generator) {
  const names = SECTIONS.filter(() => generator.next() < 0.4)
  if (generator.next() < 0.2) names.push(string(generator) || 'OTHER')
  const unique = [...new Set(names.length === 0 ? ['COCOAPODS'] : names)]
  return { m: unique.map((name) => [s(name), made(generator, 1)]) }
}

// What yaml.js read, tagged as the reference tags it.
function tagged(node) {
  if (node.kind === 'seq') return { a: node.items.map(tagged) }
  if (node.kind === 'map') return { m: node.entries.map(({ key, value }) => [tagged(key), tagged(value)]) }
  return { string: { s: node.value }, symbol: { y: node.value }, boolean: { b: node.value } }[node.type]
}

// The document, or the refusal's message.
function parsed(text) {
  try {
    return parseCocoaYaml(text)
  } catch (error) {
    assert.equal(error.name, 'LockfileError', error.stack)
    return error.message
  }
}

// A value the Psych of a Ruby before 3.1 reads as a number, or one Psych
// reads as a string only where it is no date or time, as `2026-13-45`, is
// refused, as the Psych here reads it otherwise.
const CAUTIOUS = /^"[^"]*", which Psych reads as (?:an integer|a float|a number|a date|a time),/u

describe('against cocoapods-core', { skip: SKIP }, () => {
  it('a tree YAMLHelper writes is read as Psych reads it, and taken, laid out as written, where Psych reads it as it was', () => {
    const generator = random(0xC0C0A)
    const trees = Array.from({ length: 3000 }, () => tree(generator))
    const results = cocoapods(trees.map((item) => ['emit', item]))
    let [taken, cautious] = [0, 0]
    for (const [index, result] of results.entries()) {
      if (result.error !== undefined) continue
      const { text, read, same } = result.value
      const doc = parsed(text)
      if (typeof doc !== 'string') assert.deepEqual(tagged(doc.root), read, `read otherwise than Psych reads it:\n${text}`)
      if (!same) continue
      if (typeof doc === 'string' && CAUTIOUS.test(doc)) {
        cautious++
        continue
      }
      assert.ok(typeof doc !== 'string', `refused, where Psych reads back what was written: ${doc}\n${text}\n${JSON.stringify(trees[index])}`)
      assert.equal(layout(doc.root, RULES), text)
      taken++
    }
    assert.ok(taken > 1000 && cautious < taken / 20, `${taken} taken, ${cautious} refused as cautious`)
  })

  it('a plain scalar is a string or a boolean where Psych reads it as one', () => {
    const generator = random(0x5CA1A)
    const texts = Array.from({ length: 6000 }, () => string(generator)).filter((text) => /^\w[\w/ ()~<>=.:`,-]*$/u.test(text))
    const results = cocoapods(texts.map((text) => ['psych', text]))
    const loose = { 'a date': ['Date', 'String'], 'a time': ['Time', 'String'], 'an integer': ['Integer', 'String'], 'a float': ['Float', 'String'], 'a number': ['Integer', 'Float'] }
    for (const [index, text] of texts.entries()) {
      const ruby = results[index].value
      const ours = psychRead(text).type
      if (ours === 'string') assert.equal(ruby, 'String', JSON.stringify(text))
      else if (ours === 'boolean') assert.ok(ruby === 'TrueClass' || ruby === 'FalseClass', JSON.stringify(text))
      else if (ours === 'null') assert.equal(ruby, 'NilClass', JSON.stringify(text))
      else assert.ok(loose[ours].includes(ruby), `${JSON.stringify(text)}: ${ours} here, ${ruby} to Psych`)
      if (ruby === 'String') assert.ok(ours === 'string' || loose[ours]?.includes('String'), JSON.stringify(text))
    }
  })

  it('the fixtures read as Pod::Lockfile reads them', () => {
    const texts = Object.values(FIXTURES).map((fixture) => fixture.lock)
    const results = cocoapods(texts.map((text) => ['lockfile', text]))
    for (const [index, text] of texts.entries()) {
      const lock = parsePodfileLock(text)
      const expected = results[index].value
      const roots = Object.values(lock.roots)
      const option = (key) => (key === 'fileType' ? 'type' : key)
      const checkout = (root) => (root.checkout === undefined ? null : Object.fromEntries(Object.entries(root.checkout).filter(([key, item]) => key !== 'type' && item !== undefined).map(([key, item]) => (key === 'url' ? [root.checkout.type, item] : [option(key), item]))))
      assert.deepEqual({
        pods: Object.fromEntries(Object.values(lock.pods).map((pod) => [pod.name, pod.version])),
        dependencies: lock.dependencies.map((dependency) => [dependency.name, dependency.external ? null : dependency.requirements.join(', ') || '>= 0', dependency.external]),
        repos: Object.fromEntries(roots.map((root) => [root.name, root.repo ?? null])),
        checksums: Object.fromEntries(roots.map((root) => [root.name, root.checksum])),
        checkouts: Object.fromEntries(roots.map((root) => [root.name, checkout(root)])),
        cocoapods: lock.cocoapods,
      }, expected)
    }
  })

  it('an external source is described as Dependency#to_s describes it', () => {
    const generator = random(0xDE5C)
    const { next, pick } = generator
    const maybe = (entry) => (next() < 0.5 ? [entry] : [])
    const sources = Array.from({ length: 1500 }, () => {
      const kind = pick(['git', 'git', 'path', 'podspec', 'hg', 'svn', 'http', 'http'])
      const url = pick(['https://example.com/a.git', 'git@example.com:a/b.git', 'https://example.com/a+b', 'https://example.com/"a"'])
      const entries = {
        git: () => [['git', s(url)], ...maybe(['commit', s('abc1234')]), ...maybe(['branch', s(pick(['main', 'a/b', 'yes']))]), ...maybe(['tag', s('v1.0')]), ...maybe(['submodules', { b: true }])],
        path: () => [['path', s(pick(['../a', 'LocalPods/A b', 'é/#{x}']))], ...maybe(['tag', s('t')])],
        podspec: () => [['podspec', s(pick(['specs/A.podspec', 'https://example.com/A.podspec']))], ...maybe(['tag', s('hermes')])],
        hg: () => [['hg', s(url)], ...maybe(['revision', s('abc')])],
        svn: () => [['svn', s(url)], ...maybe(['tag', s('1.0')]), ...maybe(['folder', s('trunk')])],
        http: () => [['http', s(pick(['https://example.com/a.zip', 'https://example.com/a b"#{c}.zip']))], ...maybe(['type', s('zip')]), ...maybe(['flatten', { b: next() < 0.5 }]), ...maybe(['sha256', s('a'.repeat(64))]), ...maybe(['headers', { a: [s('Accept: */*'), s('X-A: "b"')] }])],
      }[kind]()
      return entries.sort(() => next() - 0.5).map(([key, item]) => [{ y: key }, item])
    })
    const results = cocoapods(sources.map((entries) => ['describe', ['A', { m: entries }]]))
    for (const [index, entries] of sources.entries()) {
      const node = { kind: 'map', entries: entries.map(([key, item]) => ({ key: { kind: 'scalar', type: 'symbol', value: key.y }, value: item.a === undefined ? { kind: 'scalar', type: item.b === undefined ? 'string' : 'boolean', value: item.s ?? item.b } : { kind: 'seq', items: item.a.map((header) => ({ kind: 'scalar', type: 'string', value: header.s })) } })) }
      let source
      try {
        source = readExternalSource(node, 'here')
      } catch {
        continue
      }
      const description = results[index].value.replace(/^A \((.*)\)$/su, '$1')
      checkDescription(description, source, 'here')
      assert.throws(() => checkDescription(`${description.slice(0, -2)}x${description.slice(-1)}`, source, 'here'), /as CocoaPods describes the external source/u)
    }
  })
})
