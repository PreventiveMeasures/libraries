import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseComposerLock } from '../../composer.js'
import { decodeJson, encodeJson, phpFloat, readJson } from '../../src/composer/json.js'
import { compareKeys, compareStrings, compareVersions } from '../../src/composer/php.js'
import { contentHashOf, readComposerJson } from '../../src/composer/root.js'
import { allows, constraintString, matches, normalize, normalizeBranch, parseConstraints, parseNumericAliasPrefix, parseStability } from '../../src/composer/semver.js'
import { random } from '../random.js'
import { fixture } from './fixtures.js'
import { composer, hasComposer } from './reference.js'

// Composer itself, from the phar reference.js finds, against the ports
// here, over inputs made at random from pieces at fixed seeds: versions,
// constraints and how they meet, version_compare, sort and ksort, the
// numbers and the text json_encode writes, composer.json as Composer
// decodes and hashes it. Then the fixture of Composer 2.10, edited at
// random: what is read here, Composer writes back as it is, package by
// package, and installs from, with require-dev and without; and what
// Composer would, is read here, but for what is refused here on purpose,
// named below. Composer 2.7 and later only, which write php-ext.

const S = Object.freeze({ seed: 0x43_4F_4D_50 })

// A character put in or taken out, half the time; by code point, as PHP
// takes nothing with a lone surrogate.
function flaw(text, { next, pick }, pieces) {
  if (next() < 0.5) return text
  const chars = [...text]
  const at = Math.floor(next() * (chars.length + 1))
  const cut = next() < 0.4
  return [...chars.slice(0, at), cut ? '' : pick(pieces), ...chars.slice(at + (cut ? 1 : 0))].join('')
}

const PREFIX = ['', '', 'v', 'V', '~', '^', '>=', '<', '<=', '>', '!=', '==', '=', '<>', '~>']
const NUMBERS = ['0', '1', '2', '10', '01', '1.0', '1.2', '0.1', '1.2.3', '1.2.3.4', '0.0.1', '1.x', '1.*', '2.0.x', '*', 'x', '2026.01.02', '20260102', '1.2.3.4.5']
const SUFFIX = ['', '', '', '-dev', '-beta', '-beta1', 'beta.2', '-RC1', 'rc', '-alpha', 'a1', 'b2', '-patch1', 'pl3', 'p', '-stable', '.x-dev', '-x-dev', '@dev', '@beta', '@stable', '+build', '-dev#abc', ' as 1.0', 'STABLE', '-ſtable', '@ſtable']
const BRANCHES = ['dev-main', 'dev-master', 'master', 'trunk', 'dev-feature/x', 'feature-dev', '1.0.x-dev', 'dev-1.0', 'foo', '']
const SEPARATORS = [' ', ',', ', ', ' || ', '|', ' - ']
const PIECES = ['.', '-', ' ', ',', '|', '*', 'x', '@', '#', '1', 'v', '  ', ' - ', '||', 'é', 'ſ', '\u212A']

const one = ({ next, pick }) => (next() < 0.15 ? pick(BRANCHES) : `${pick(PREFIX)}${pick(NUMBERS)}${pick(SUFFIX)}`)

function constraintText(generator) {
  let text = one(generator)
  for (let i = Math.floor(generator.next() * 3); i > 0; i--) text += `${generator.pick(SEPARATORS)}${one(generator)}`
  return flaw(text, generator, PIECES)
}

// A part past a 64-bit integer, which Composer reads as a float and writes
// out as one, `1.0E+20`; refused here.
const PAST_INT = /\d{20}/u

const valueOf = (result) => (result.error === undefined ? result.value : undefined)

describe('against Composer', { skip: !hasComposer() && 'no php, or no Composer phar' }, () => {
  const VERSION = composer([['version']])[0].value
  const generator = random(S.seed)
  const versions = Array.from({ length: 3000 }, () => flaw(generator.next() < 0.5 ? one(generator) : `${generator.pick(NUMBERS)}${generator.pick(SUFFIX)}`, generator, PIECES))
  const constraints = Array.from({ length: 3000 }, () => constraintText(generator))

  it('versions: normalized, their stability, branches and alias prefixes alike', () => {
    const kinds = ['normalize', 'stability', 'branch', 'prefix']
    const results = composer(versions.flatMap((text) => kinds.map((kind) => [kind, text])))
    for (const [index, text] of versions.entries()) {
      const [normal, stability, branch, prefix] = results.slice(index * 4, index * 4 + 4).map(valueOf)
      assert.equal(normalize(text), normal, `normalize ${JSON.stringify(text)}`)
      assert.equal(parseStability(text), stability, `parseStability ${JSON.stringify(text)}`)
      assert.equal(normalizeBranch(text), branch, `normalizeBranch ${JSON.stringify(text)}`)
      assert.equal(parseNumericAliasPrefix(text) ?? false, prefix, `parseNumericAliasPrefix ${JSON.stringify(text)}`)
    }
  })

  it('constraints: read alike, and to the same constraint', () => {
    const results = composer(constraints.map((text) => ['constraints', text]))
    let read = 0
    for (const [index, text] of constraints.entries()) {
      const parsed = parseConstraints(text)
      if (parsed !== undefined) read++
      const expected = valueOf(results[index])
      if (parsed === undefined && expected !== undefined && PAST_INT.test(text)) continue
      assert.equal(parsed === undefined ? undefined : constraintString(parsed), expected, JSON.stringify(text))
    }
    assert.ok(read > 500, `only ${read} read`)
  })

  it('constraints meet one another, and versions, alike', () => {
    const valid = constraints.filter((text) => parseConstraints(text) !== undefined)
    const normals = versions.map(normalize).filter((version) => version !== undefined)
    const pairs = Array.from({ length: 4000 }, () => [generator.pick(valid), generator.pick(valid)])
    const allowed = Array.from({ length: 4000 }, () => [generator.pick(valid), generator.pick(normals)])
    const results = composer([...pairs.map(([a, b]) => ['matches', a, b]), ...allowed.map(([a, version]) => ['allows', a, version])])
    for (const [index, [a, b]] of pairs.entries()) assert.equal(matches(parseConstraints(a), parseConstraints(b)), results[index].value, JSON.stringify([a, b]))
    for (const [index, [a, version]] of allowed.entries()) assert.equal(allows(parseConstraints(a), version), results[pairs.length + index].value, JSON.stringify([a, version]))
  })

  // PHP before 8.4 keeps a separator at the end of a version as an empty
  // part, which the port drops, as 8.4 and later do: a pair with one is
  // compared there alone.
  it('version_compare alike', () => {
    const before84 = composer([['php']])[0].value < 80400
    const words = ['1', '2', '10', '0', '00', '99999999999999999999', '.', '..', '-', '_', '+', 'a', 'b', 'alpha', 'beta', 'RC', 'rc', 'dev', 'pl', 'p', 'patch', '#', 'x', 'stable', ' ', '#N#', 'é']
    const word = () => Array.from({ length: Math.floor(generator.next() * 6) }, () => generator.pick(words)).join('')
    const pairs = Array.from({ length: 4000 }, () => [word(), generator.next() < 0.3 ? generator.pick(versions) : word()])
    const results = composer(pairs.map(([a, b]) => ['compare', a, b]))
    for (const [index, [a, b]] of pairs.entries()) {
      if (before84 && [a, b].some((text) => /[^A-Za-z\d]$/u.test(text))) continue
      assert.equal(compareVersions(a, b), results[index].value, JSON.stringify([a, b]))
    }
  })

  it('sort and ksort order strings and keys alike', () => {
    const keys = ['a', 'b', '10', '9', '1e3', '1000', ' 5', '5', '-1', '0', '00', '1.5', 'ext-a', 'php', 'a/b', 'A/b', 'é', 'z', '9223372036854775807', '9223372036854775808', '1e400', '.5', '5.', '-0', '+1']
    const sets = Array.from({ length: 400 }, () => Array.from({ length: 2 + Math.floor(generator.next() * 7) }, () => generator.pick(keys)))
    const results = composer([...sets.map((set) => ['ksort', [...new Set(set)]]), ...sets.map((set) => ['sort', set])])
    for (const [index, set] of sets.entries()) {
      assert.deepEqual([...new Set(set)].sort(compareKeys), results[index].value, JSON.stringify(set))
      assert.deepEqual([...set].sort(compareStrings), results[sets.length + index].value, JSON.stringify(set))
    }
  })

  it('json_encode writes a number alike', () => {
    const numbers = Array.from({ length: 3000 }, () => {
      const magnitude = 10 ** Math.floor(generator.next() * 60 - 30)
      const value = (generator.next() - 0.5) * magnitude
      return generator.next() < 0.2 ? Math.round(value) : value
    })
    const texts = [...numbers.map(String), '1e17', '1e16', '0.0001', '0.00001', '-0.0', '1E2', '9223372036854775807', '9223372036854775808', '-9223372036854775809', '5e-324']
    const results = composer(texts.map((text) => ['float', text]))
    for (const [index, text] of texts.entries()) {
      const value = Number(text)
      const integer = /^-?\d+$/u.test(text) && BigInt(text) < 2n ** 63n && BigInt(text) >= -(2n ** 63n)
      assert.equal(integer ? BigInt(text).toString() : phpFloat(value), results[index].value, text)
    }
  })

  it('the text: read where json_encode writes back what PHP decodes of it', () => {
    const base = fixture('composer-2.10.3-tabs.lock').replaceAll('\t', '    ')
    const pieces = [' ', '\n', '\t', '{', '}', '[', ']', ',', '"', '\\', '\\/', '\\u00e9', 'é', '1', '1.0', '1e2', '-0', '.', ':', 'true', 'null', '\u2028', '\\u2028']
    const texts = Array.from({ length: 2000 }, () => flaw(flaw(base, generator, pieces), generator, pieces))
    const results = composer(texts.map((text) => ['json', text]))
    let both = 0
    for (const [index, text] of texts.entries()) {
      let error
      try {
        readJson(text)
      } catch (caught) {
        error = caught.message
      }
      // json_encode of the objects PHP decodes keeps `{}` and an object of
      // keys 0 to n, which Composer, of the arrays it decodes, writes back
      // as `[]` and as a list: refused here.
      if (error !== undefined && /an empty object|keys 0 to/u.test(error)) continue
      assert.equal(error === undefined, results[index].value === true, `${JSON.stringify(text)}: ${error}`)
      if (error === undefined) both++
    }
    assert.ok(both > 100, `only ${both} read`)
  })

  it('composer.json: decoded, encoded and hashed alike', () => {
    const keys = ['"name"', '"require"', '"require-dev"', '"extra"', '"config"', '"platform"', '"0"', '"1"', '"a/b"', '"é/ü"', '"x"', '"repositories"', '"minimum-stability"']
    const values = ['"a/b"', '"^1.0"', '{}', '[]', '1', '1.0', '1e2', '-0', 'true', 'null', '"\\u00e9"', '"/x/"', '"😀"', '[1,2]', '9223372036854775808', '1e400', '-1e400', '1e-400']
    const value = (depth) => (depth > 2 || generator.next() < 0.5 ? generator.pick(values) : `{${Array.from({ length: Math.floor(generator.next() * 4) }, () => `${generator.pick(keys)}: ${value(depth + 1)}`).join(', ')}}`)
    const texts = Array.from({ length: 1500 }, () => flaw(`{${Array.from({ length: 1 + Math.floor(generator.next() * 5) }, () => `${generator.pick(keys.filter((key) => key !== '"name"'))}: ${value(1)}`).join(',\n  ')}}`, generator, [' ', ',', '{', '}', '"', ':', '\\']))
    const results = composer(texts.flatMap((text) => [['decode', text], ['hash', text]]))
    for (const [index, text] of texts.entries()) {
      let encoded
      try {
        encoded = encodeJson(decodeJson(text, 'composerJson'))
      } catch (error) {
        assert.equal(error.name, 'LockfileError', error.stack)
      }
      const [decoded, hash] = [valueOf(results[index * 2]), valueOf(results[index * 2 + 1])]
      assert.equal(encoded, decoded, JSON.stringify(text))
      if (encoded !== undefined && hash !== undefined) assert.equal(contentHashOf(text), hash, JSON.stringify(text))
    }
  })

  // The fields of the fixture's composer.json held to the schema here,
  // each set to a value of another shape, or taken out, its repositories
  // made a map, named or not, and its name and the names it links to set
  // to ones RootPackageLoader may refuse: refused alike. A package
  // repository's package is set no field but its name and version.
  it('composer.json: refused alike by Composer 2.10\'s schema and RootPackageLoader', { skip: compareVersions(VERSION, '2.10.0') < 0 && `Composer ${VERSION}, of another schema` }, () => {
    const PATHS = [
      ['version'], ['minimum-stability'], ['prefer-stable'], ['extra'], ['config'], ['config', 'platform'], ['config', 'platform', 'php'], ['config', 'platform', 'ext-x'], ['repositories'],
      ...[0, 1, 2, 3].flatMap((index) => [[index], ...['type', 'url', 'name', 'canonical', 'only', 'exclude', 'options', 'filter', 'no-api', 'trunk-path', 'package', 'vendor-alias', 'depot', 'x'].map((key) => [index, key])]),
      ...['reference', 'symlink', 'relative', 'versions', 'x'].map((key) => [0, 'options', key]), [0, 'filter', 'x'], [2, 'package', 'name'], [2, 'package', 'version'], [2, 'package', 0],
    ]
    const VALUES = [
      'stable', 'RC', 'Stable', 'dev', 'composer', 'vcs', 'git', 'forgejo', 'path', 'package', 'artifact', 'pear', 'nope', 'none', 'auto', 'https://example.com', '', '1.0.0', 'v2.0-beta1', '1.x-dev', 'master', 'dev-main', 'dev-x as 1.0', '1.0@beta', '1.0.0-foo',
      true, false, null, 3, 1.5, [], {}, ['a'], [1], { a: true }, { a: 1 }, { name: 'a/b', version: '1.0' }, [{ name: 'a/b', version: '1.0' }], [{ name: 'a/b' }], { type: 'path', url: 'x' }, { 'packagist.org': false },
    ]
    const CONSTRAINTS = ['*', '*', '*', 'dev-main as 1.0', 'dev-main as 1.0 || ^2.0', '^2.0 || dev-main as 1.0', '^2.0 | 1.0 as 1.1', '>=1, 1.0 as 1.1', 'dev-main#abc as 1.0', 'dev-main as foo', 'foo as 1.0', 'dev-main as 1.0 as 2.0', '^1 as 2', 'dev-main  as  1.0', 'dev-main as 1.0 || foo as 2.0', 'dev-main as 1.0@dev', '^2.0 || nope']
    const NAMES = ['a/b', 'A/B', 'Fixture/Project', 'BAD NAME', 'a/b.json', 'nul/x', 'a/con', 'PHP', 'ext-FOO', 'lib-x', 'php-64bit', 'composer-plugin-api', '__root__', 'fixture/project', 'guzzlehttp/guzzle', '123', 'a//b', 'a/b-', 'a/b--c', 'a/b---c', 'é/x', 'ſ/x', 'a/\u212A', 'ext-ſ', '']
    const BASE = JSON.parse(fixture('composer-2.10.3.json'))
    const edit = (doc) => {
      if (generator.next() < 0.25) {
        const [type, name, constraint] = [generator.pick(['name', 'require', 'require-dev', 'conflict', 'provide', 'replace']), generator.pick(NAMES), generator.pick(CONSTRAINTS)]
        if (type === 'name') doc.name = name
        else (doc[type] ??= {})[name] = constraint
        return type === 'name' ? `name = ${JSON.stringify(name)}` : `${type}[${JSON.stringify(name)}] = ${JSON.stringify(constraint)}`
      }
      const path = generator.pick(PATHS)
      const where = typeof path[0] === 'number' ? ['repositories', ...path] : path
      let holder = doc
      for (const key of where.slice(0, -1)) {
        if (typeof holder !== 'object' || holder === null) return 'none'
        holder = holder[key] ??= {}
      }
      if (typeof holder !== 'object' || holder === null) return 'none'
      const key = where.at(-1)
      if (generator.next() < 0.2) {
        if (Array.isArray(holder) && typeof key === 'number') holder.splice(key, 1)
        else delete holder[key]
        return `${where.join('.')} taken out`
      }
      holder[key] = structuredClone(generator.pick(VALUES))
      return `${where.join('.')} = ${JSON.stringify(holder[key])}`
    }
    const docs = Array.from({ length: 1500 }, () => {
      const doc = structuredClone(BASE)
      const what = Array.from({ length: 1 + Math.floor(generator.next() * 2) }, () => edit(doc))
      if (generator.next() < 0.15 && Array.isArray(doc.repositories)) {
        const named = generator.next() < 0.5
        doc.repositories = Object.fromEntries([...doc.repositories.entries()].map(([index, repository]) => [`r${index}`, named && typeof repository === 'object' && repository !== null ? { ...repository, name: `r${index}` } : repository]))
        what.push(`repositories by name${named ? ', each named' : ''}`)
      }
      return { what, text: JSON.stringify(doc) }
    })
    // And what the edits above come to but seldom.
    const path = (options) => ({ repositories: [{ type: 'path', url: 'x', options }] })
    for (const doc of [path({ symlink: null }), path({ symlink: 'x' }), path({ reference: 'auto', versions: { 'a/b': '1.0' } }), path({ versions: { 'a/b': 1 } }), { repositories: { x: { type: 'git', url: 'x' }, y: false } }, { repositories: [{ a: false, b: false }] }]) {
      docs.push({ what: [JSON.stringify(doc)], text: JSON.stringify(doc) })
    }
    const results = composer(docs.map(({ text }) => ['root', text]))
    const tally = { both: 0, neither: 0 }
    for (const [index, { what, text }] of docs.entries()) {
      let refusal
      try {
        readComposerJson(text)
      } catch (error) {
        assert.equal(error.name, 'LockfileError', error.stack)
        refusal = error.message
      }
      assert.equal(refusal === undefined, results[index].value === true, `${what.join('; ')}: ${refusal ?? 'read'}; Composer: ${JSON.stringify(results[index])}`)
      tally[refusal === undefined ? 'both' : 'neither']++
    }
    assert.ok(tally.both > 300 && tally.neither > 300, JSON.stringify(tally))
  })

  describe('the fixture, edited', { skip: compareVersions(VERSION, '2.7.0') < 0 && `Composer ${VERSION}, which writes no php-ext` }, () => {
    const BASE = fixture('composer-2.10.3.lock')
    const encode = (value) => `${JSON.stringify(value, null, 4).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}\n`
    const edits = editor(generator)
    const docs = Array.from({ length: 700 }, () => {
      const doc = JSON.parse(BASE)
      const what = Array.from({ length: 1 + Math.floor(generator.next() * 2) }, () => edits(doc))
      return { doc, what, text: encode(doc) }
    })

    // What is refused here, and not by Composer's loader and dumper or its
    // solver, on purpose: the root's aliases and versions as Composer never
    // writes them, a type of source or dist, a sha1, a mirror or a URL it
    // fetches nothing from, `{}` where it writes `[]`, which it decodes
    // alike, and a list of suggestions, whose keys are no names. Composer
    // before 2.10 does not refuse a name, a URL or a
    // reference it would not install either.
    const DELIBERATE = [
      /^aliases\[0\]/u, /is not a version Composer locks a package at/u, /\.(?:source|dist)\.type: expected/u, /dist\.shasum: /u,
      /is not an http\(s\) URL/u, /fetches nothing/u, /starts with "-"/u, /mirrors/u, /an empty object, which Composer writes as/u,
      /expected a sequence, found a mapping/u, /is not a URL \w+ fetches from/u, /an absolute path/u, /not a relative path in normal form/u, /is a URL, of [\d+.A-Za-z-]+:, and not a path/u,
      /not a branch or tag name git takes/u, /is not a package name/u, /\.suggest: expected a mapping, found a sequence/u,
    ]

    it('read only where Composer writes each package back and installs from it, and refused only on purpose where not', () => {
      const cases = docs.flatMap(({ doc, text }) => [['install', text], ...[...doc.packages, ...doc['packages-dev']].map((pkg) => ['package', JSON.stringify(pkg)])])
      const results = composer(cases)
      let next = 0
      const tally = { both: 0, neither: 0, deliberate: 0 }
      for (const { doc, what, text } of docs) {
        const install = results[next].value
        const count = doc.packages.length + doc['packages-dev'].length
        const written = results.slice(next + 1, next + 1 + count).every((result) => result.value === true)
        next += 1 + count
        const accepted = written && install?.[0] === 'ok' && install?.[1] === 'ok'
        let refusal
        try {
          // A root of nothing, as the reference installs against.
          parseComposerLock(text, { composerJson: '{}' })
        } catch (error) {
          assert.equal(error.name, 'LockfileError', error.stack)
          refusal = error.message
        }
        const context = `${what.join('; ')}: ${refusal ?? 'read'}; Composer: ${JSON.stringify(install)}, written back ${written}`
        if (refusal === undefined) assert.ok(accepted, context)
        else if (accepted) assert.ok(DELIBERATE.some((pattern) => pattern.test(refusal)), context)
        tally[refusal === undefined ? 'both' : accepted ? 'deliberate' : 'neither']++
      }
      assert.ok(tally.both > 100 && tally.neither > 100, JSON.stringify(tally))
    })
  })
})

// Edits of a lockfile Composer wrote, each a step toward one it would not
// write, or would not install from, or both: a link added, changed or
// taken out, a version, a field set to a value of another shape or taken
// out, a branch alias, a source or a dist changed, a time, the root's
// alias, the stability flags and minimum-stability, a package moved
// between packages and packages-dev, and a package copied under a name
// another has or replaces.
function editor({ next, pick }) {
  const NAMES = ['psr/log', 'psr/log-implementation', 'monolog/monolog', 'fixture/vcs', 'fixture/local', 'rhumsaa/uuid', 'ramsey/uuid', 'php', 'ext-json', 'ext-mbstring', 'nobody/none', 'Psr/Log', 'symfony/polyfill-mbstring', 'doctrine/cache', 'psr/http-message', 'symfony/var-dumper', 'brick/math', 'a', '123']
  const CONSTRAINTS = ['*', '^1.0', '^3.0', '^2.0 || ^3.0', '>=1', '<1', 'self.version', 'dev-main', 'dev-master', '1.0.x-dev', '1.1.0', '^1.1', '^99', '1.0.0', 'nope', '', ' ^1.0', '~1.0', '3.0.2', '>=3.0.0 <4', '!=3.0.2', 'dev-main as 1.0', '^3.0@dev', '^2.0', '7.15.5', '<7.0', '>7.99']
  const VERSIONS = ['1.0', 'v2.0.0', '1.0.0', 'dev-main', 'dev-master', '1.0.x-dev', '0', '1.0 as 2.0', 'abc', '9999999-dev', 'dev-feature/x', '1.0.0-beta1', '1.0.0-RC2', '2.x-dev', ' 1.0', '1.0@dev', '3.0.2', 'v3.0.2']
  const VALUES = ['', '0', 'x', 'library', 'Library', 1, 0, true, false, null, [], ['x'], { a: 'b' }, { a: {} }]
  const FIELDS = ['name', 'version', 'target-dir', 'source', 'dist', 'require', 'conflict', 'provide', 'replace', 'require-dev', 'suggest', 'default-branch', 'bin', 'type', 'extra', 'autoload', 'autoload-dev', 'notification-url', 'include-path', 'php-ext', 'archive', 'scripts', 'license', 'authors', 'description', 'homepage', 'keywords', 'support', 'funding', 'abandoned', 'transport-options', 'time', 'repositories', 'version_normalized', 'installation-source']
  const URLS = ['git', 'zip', 'path', 'https://example.com/x.zip', '-oops', 'abc', '0123456789abcdef0123456789abcdef01234567', 'ABCDEF0123456789abcdef0123456789abcdef01', [{ url: 'https://m/%package%', preferred: true }]]
  const TIMES = ['2026-02-30T00:00:00+00:00', '2026-01-01T00:00:00Z', '2026-01-01T24:00:00+00:00', '2026-01-01T00:00:00+05:30', '2026-01-01 00:00:00', '1700000000', '2026-01-01T00:00:00+99:00', '2026-01-01T00:00:00+24:59', '2024-02-29T00:00:00+00:00', '2023-02-29T00:00:00+00:00']
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const sortedKeys = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)))

  return (doc) => {
    const list = next() < 0.8 ? doc.packages : doc['packages-dev']
    const pkg = list[Math.floor(next() * list.length)]
    const r = next()
    if (r < 0.35) {
      const type = pick(['require', 'conflict', 'provide', 'replace', 'require-dev'])
      const target = pick([...NAMES, ...Object.keys(pkg[type] ?? {})])
      const links = { ...pkg[type] }
      if (next() < 0.2) delete links[target]
      else links[target] = pick(CONSTRAINTS)
      if (Object.keys(links).length === 0) delete pkg[type]
      else pkg[type] = next() < 0.85 ? sortedKeys(links) : links
      return `link ${type} ${target}`
    }
    if (r < 0.45) {
      pkg.version = pick(VERSIONS)
      return `version ${pkg.version}`
    }
    if (r < 0.55) {
      const field = pick(FIELDS)
      if (next() < 0.4) delete pkg[field]
      else pkg[field] = pick(VALUES)
      return `field ${field}`
    }
    if (r < 0.62) {
      const extra = typeof pkg.extra === 'object' && pkg.extra !== null && !Array.isArray(pkg.extra) ? pkg.extra : {}
      pkg.extra = { ...extra, 'branch-alias': { [pick(['dev-main', 'dev-master', pkg.version, 'dev-x'])]: pick(['1.0.x-dev', '2.x-dev', '9999999-dev', 'foo-dev', '1.0', 5, '3.x-dev']) } }
      return 'branch alias'
    }
    if (r < 0.66) {
      pkg['default-branch'] = pick([true, false])
      return 'default branch'
    }
    if (r < 0.72) {
      const which = pick(['source', 'dist'])
      if (pkg[which] === undefined) return `no ${which}`
      const key = pick(['type', 'url', 'reference', 'shasum', 'mirrors'])
      pkg[which] = { ...pkg[which], [key]: pick([...VALUES, ...URLS]) }
      return `${which}.${key}`
    }
    if (r < 0.77) {
      pkg.time = pick(TIMES)
      return `time ${pkg.time}`
    }
    if (r < 0.82) {
      const key = pick(['package', 'version', 'alias', 'alias_normalized'])
      doc.aliases = [{ ...doc.aliases[0], [key]: pick(['fixture/vcs', 'psr/log', 'dev-main', '9999999-dev', '1.0.9999999.9999999-dev', 'dev-master', '1.1.0', '1.1.0.0', '2.0', '2.0.0.0', 'nope']) }]
      // As require and require-dev both alias it.
      if (next() < 0.3) doc.aliases.push({ ...doc.aliases[0], alias: '0.5.0', alias_normalized: '0.5.0.0' })
      return `alias ${key}`
    }
    if (r < 0.87) {
      const flags = { ...doc['stability-flags'], [pick(['fixture/vcs', 'symfony/var-dumper', 'psr/log', 'doctrine/cache'])]: pick([0, 5, 10, 15, 20]) }
      if (next() < 0.3) delete flags[pick(Object.keys(flags))]
      doc['stability-flags'] = sortedKeys(flags)
      if (next() < 0.3) doc['minimum-stability'] = pick(['stable', 'RC', 'beta', 'alpha', 'dev'])
      return 'stability'
    }
    if (r < 0.92) {
      const [from, to] = next() < 0.5 ? ['packages', 'packages-dev'] : ['packages-dev', 'packages']
      const [moved] = doc[from].splice(Math.floor(next() * doc[from].length), 1)
      doc[to].push(moved)
      doc[to].sort(byName)
      return `${moved.name} to ${to}`
    }
    const copy = { ...structuredClone(pkg), name: pick(['rhumsaa/uuid', 'psr/log-implementation', 'psr/log', 'other/pkg']) }
    doc.packages.push(copy)
    doc.packages.sort(byName)
    return `copy as ${copy.name}`
  }
}
