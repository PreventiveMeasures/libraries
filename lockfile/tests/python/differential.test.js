import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parsePylock } from '../../pylock.js'
import { parseSdistName, parseWheelName } from '../../src/python/files.js'
import { checkSpecifiers, normalVersion, parseVersion, versionKey } from '../../src/python/pep440.js'
import { checkMarker, checkRequirementText, isName, normalName } from '../../src/python/pep508.js'
import { random } from '../random.js'
import { hasPackaging, hasPylock, packaging } from './reference.js'

// Python's packaging, which pip, uv's tests and PDM hold themselves to,
// against the PEP 440 and PEP 508 readers here, over inputs made at random
// from pieces, half of them with a character put in or taken out. A
// version reads the same in both, to the same normal form, and two
// versions are equal in both or in neither. A specifier set, a marker and
// a requirement read here are read by packaging, and of those made whole
// from their pieces, one packaging reads is read here too: the readers here
// are stricter only where named below. The seeds are fixed.

const accepts = (check) => (text) => {
  try {
    check(text, 'here')
    return true
  } catch (error) {
    assert.equal(error.name, 'LockfileError', error.stack)
    return false
  }
}

function flaw(text, { next, pick }) {
  if (next() < 0.5) return { text, whole: true }
  const at = Math.floor(next() * (text.length + 1))
  const cut = next() < 0.5
  return { text: `${text.slice(0, at)}${cut ? '' : pick(['.', '-', '_', ' ', '*', '!', '+', ',', "'", '"', '(', ')', ';', '=', '<', 'a', '1', '@'])}${text.slice(at + (cut ? 1 : 0))}`, whole: false }
}

const VERSION = {
  prefix: ['', '', 'v', 'V'],
  epoch: ['', '', '', '1!', '0!', '01!', '2026!'],
  release: ['1', '1.0', '01.2', '1.0.0', '2026.7.22', '0', '1.2.3.4.5', '10.00'],
  pre: ['', '', 'a1', 'a', '-alpha.2', 'b0', '.beta_3', 'rc1', 'c2', 'pre4', '-preview', 'RC1', 'A01'],
  post: ['', '', '.post1', '-1', 'post', '.r2', '-rev3', '_post_4', '.POST'],
  dev: ['', '', '.dev1', 'dev', '-dev_2', '.DEV0', 'dev01'],
  local: ['', '', '+abc', '+1.2', '+ubuntu-1', '+A_b.01', '+0', '+a..b'],
}

const version = ({ pick }) => Object.values(VERSION).map(pick).join('')

describe('against packaging', { skip: !hasPackaging() && 'no python3 with packaging' }, () => {
  it('versions: the same read, and the same normal form', () => {
    const generator = random(0x44_0E_B1)
    const texts = Array.from({ length: 4000 }, () => flaw(version(generator), generator).text)
    const results = packaging(texts.map((text) => ['version', text]))
    let both = 0
    for (const [index, text] of texts.entries()) {
      const parsed = parseVersion(text)
      // packaging strips whitespace around a version, which is refused here.
      const expected = text.trim() === text ? results[index].value : undefined
      assert.equal(parsed === undefined ? undefined : normalVersion(parsed), expected, JSON.stringify(text))
      if (parsed !== undefined) both++
    }
    assert.ok(both > 1500 && both < 3900, `${both}`)
  })

  it('versions: equal in both, or in neither', () => {
    const generator = random(0x0E_00_A1)
    const pairs = Array.from({ length: 3000 }, () => {
      const a = version(generator)
      return [a, generator.next() < 0.3 ? a.replace(/(\d)(?=$|\+)/u, '$1.0') : version(generator)]
    }).filter(([a, b]) => parseVersion(a) !== undefined && parseVersion(b) !== undefined)
    const results = packaging(pairs.map((pair) => ['same', pair]))
    let equal = 0
    for (const [index, [a, b]] of pairs.entries()) {
      const same = versionKey(parseVersion(a)) === versionKey(parseVersion(b))
      assert.equal(same, results[index].value, `${a} ${b}`)
      if (same) equal++
    }
    assert.ok(equal > 50, `${equal}`)
  })

  it('specifier sets: read here, read by packaging; whole, read by packaging, read here', () => {
    const generator = random(0x5B_EC_11)
    const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '~=', '===']
    const clause = ({ pick, next }) => `${pick(['', ' '])}${pick(OPERATORS)}${pick(['', ' ', '\t'])}${next() < 0.2 ? `${pick(VERSION.release)}.*` : version(generator)}${pick(['', ' '])}`
    const made = Array.from({ length: 4000 }, () => flaw(Array.from({ length: 1 + Math.floor(generator.next() * 3) }, () => clause(generator)).join(','), generator))
    const results = packaging(made.map(({ text }) => ['specifiers', text]))
    let both = 0
    for (const [index, { text, whole }] of made.entries()) {
      const here = accepts(checkSpecifiers)(text)
      if (here) assert.equal(results[index].value, true, `${JSON.stringify(text)} is read here, and refused by packaging`)
      // packaging skips an empty clause, which is refused here.
      if (whole && results[index].value === true) assert.ok(here, `${JSON.stringify(text)} is read by packaging, and refused here`)
      if (here) both++
    }
    assert.ok(both > 500, `${both}`)
  })

  it('markers: read here, read by packaging; whole, read by packaging, read here', () => {
    const generator = random(0x3A_4E_E5)
    const VARIABLES = ['python_version', 'python_full_version', 'os_name', 'sys_platform', 'platform_release', 'platform_system', 'platform_version', 'platform_machine', 'platform_python_implementation', 'implementation_name', 'implementation_version', 'extra']
    const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '~=', '===', 'in', 'not in']
    const space = () => generator.pick(['', ' ', ' ', '\t', '  '])
    const quoted = () => generator.pick(["'3.12'", '"win32"', "'linux'", '""', "'a b'", '"x"', "'3.*'"])
    const comparison = () => {
      const [left, right] = generator.next() < 0.8 ? [generator.pick(VARIABLES), quoted()] : [quoted(), generator.pick(VARIABLES)]
      const op = generator.pick(OPERATORS)
      return `${left}${/^[a-z]/u.test(op) ? ' ' : space()}${op}${/^[a-z]/u.test(op) ? ' ' : space()}${right}`
    }
    const expression = (depth) => {
      const r = generator.next()
      if (depth < 3 && r < 0.2) return `(${space()}${expression(depth + 1)}${space()})`
      if (depth < 3 && r < 0.5) return `${expression(depth + 1)} ${generator.pick(['and', 'or'])} ${expression(depth + 1)}`
      return comparison()
    }
    const made = Array.from({ length: 4000 }, () => flaw(expression(0), generator))
    const results = packaging(made.map(({ text }) => ['marker', text]))
    let both = 0
    for (const [index, { text, whole }] of made.entries()) {
      const here = accepts(checkMarker)(text)
      if (here) assert.equal(results[index].value, true, `${JSON.stringify(text)} is read here, and refused by packaging`)
      if (whole) assert.equal(here, results[index].value === true, JSON.stringify(text))
      if (here) both++
    }
    assert.ok(both > 2000, `${both}`)
  })

  it('requirements: read here, read by packaging; whole, read by packaging, read here', () => {
    const generator = random(0x7E_0B_21)
    const { pick, next } = generator
    const made = Array.from({ length: 3000 }, () => {
      const name = pick(['requests', 'PySocks', 'a', 'zope.interface', 'typing_extensions', 'x-y'])
      const extras = pick(['', '', '[socks]', '[a, b]', '[ a ]', '[]'])
      const spec = next() < 0.2 ? ` @ ${pick(['https://example.com/a-1.0.tar.gz', 'file:///tmp/a.whl', 'git+https://github.com/a/b@v1'])}` : pick(['', '>=1.0', ' (>=1.0,<2)', '==2.*', ' ~=1.4.2', '(!=1.5.7)'])
      const marker = pick(['', '', " ; python_version < '3.12'", '; extra == "x"', " ; sys_platform == 'win32' and python_version >= '3'"])
      return flaw(`${name}${extras}${spec}${spec.startsWith(' @') && marker.startsWith(';') ? ' ' : ''}${marker}`, generator)
    })
    const results = packaging(made.map(({ text }) => ['requirement', text]))
    let both = 0
    for (const [index, { text, whole }] of made.entries()) {
      const here = accepts(checkRequirementText)(text)
      if (here) assert.equal(results[index].value, true, `${JSON.stringify(text)} is read here, and refused by packaging`)
      if (whole) assert.equal(here, results[index].value === true, JSON.stringify(text))
      if (here) both++
    }
    assert.ok(both > 1200, `${both}`)
  })

  // packaging's is_normalized_name takes `x--y`, its lookahead a character
  // late, though canonicalize_name makes `x-y` of it: canonicalize_name is
  // the reference.
  it('names: the same normal form', () => {
    const generator = random(0x4A_3E_55)
    const texts = Array.from({ length: 2000 }, () => flaw(generator.pick(['requests', 'PySocks', 'zope.interface', 'typing_extensions', 'a', 'x--y', 'A_B.c-D', 'z9']), generator).text)
    const results = packaging(texts.map((text) => ['name', text]))
    for (const [index, text] of texts.entries()) {
      if (!isName(text)) continue
      assert.equal(normalName(text), results[index].value[0], text)
    }
  })

  it('wheel and sdist file names: the same name and version', () => {
    const generator = random(0x0F_11_E5)
    const { pick } = generator
    const made = Array.from({ length: 3000 }, () => {
      const wheel = generator.next() < 0.6
      const name = pick(['requests', 'PySocks', 'zope.interface', 'typing_extensions', 'charset_normalizer', 'a__b'])
      const tags = pick(['py3-none-any', 'cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64', 'py2.py3-none-any', 'cp312-abi3-win_amd64'])
      const build = wheel && generator.next() < 0.2 ? pick(['-1', '-2b', '-x']) : ''
      return flaw(wheel ? `${name}-${version(generator)}${build}-${tags}.whl` : `${name}-${version(generator)}${pick(['.tar.gz', '.zip'])}`, generator).text
    })
    const results = packaging(made.map((text) => [text.endsWith('.whl') ? 'wheel' : 'sdist', text]))
    let both = 0
    for (const [index, text] of made.entries()) {
      const parsed = text.endsWith('.whl') ? parseWheelName(text) : parseSdistName(text)
      const expected = results[index].value
      if (parsed !== undefined) {
        assert.deepEqual([parsed.name, normalVersion(parsed.version)], expected, text)
        both++
      } else if (expected !== undefined && !/\s/u.test(text)) {
        // Refused here for its tags alone, which packaging before 26.3
        // takes of any characters, and 26.3 with a python tag that is not
        // an identifier; or for a space around the version, which
        // packaging strips.
        const retagged = text.replace(/(?:-[^-]*){3}\.whl$/u, '-py3-none-any.whl')
        assert.ok(text.endsWith('.whl') && parseWheelName(retagged) !== undefined, `${text} is a file name packaging reads, refused here`)
      }
    }
    assert.ok(both > 1000, `${both}`)
  })
})

// packaging.pylock, from packaging 25.1, against the reader here, over the
// fixtures, each with one line taken out or one value changed: a lockfile
// read here is read by packaging, and one it refuses is refused here.
const FIXTURES = new URL('../pylock/fixtures/', import.meta.url)
const PYLOCKS = readdirSync(FIXTURES).map((name) => readFileSync(new URL(name, FIXTURES), 'utf8'))

function editPylock(text, { next, pick }) {
  const lines = text.split('\n')
  const at = Math.floor(next() * lines.length)
  const r = next()
  if (r < 0.4) lines.splice(at, 1)
  else if (r < 0.7) lines[at] = lines[at].replace(/"[^"]*"/u, pick(['"x"', '""', '"1.0"', '"Name"', '"sha256"', '"../x"', '"/abs"', '"https://example.com/a-1.0-py3-none-any.whl"']))
  else lines.splice(at, 0, pick(['version = "2.0"', 'marker = "python_version < \'3\'"', 'name = "other"', 'editable = true', 'index = "https://pypi.org/simple"', 'size = 1', 'upload-time = 2026-01-01T00:00:00Z']))
  return lines.join('\n')
}

describe('against packaging.pylock', { skip: !hasPylock() && 'no python3 with packaging 25.1 or later' }, () => {
  it('the fixtures, and the fixtures with one edit', () => {
    const generator = random(0x75_10_C4)
    const texts = [...PYLOCKS, ...Array.from({ length: 600 }, () => editPylock(generator.pick(PYLOCKS), generator))]
    const results = packaging(texts.map((text) => ['pylock', text]))
    const counts = { both: 0, neither: 0, stricter: 0 }
    for (const [index, text] of texts.entries()) {
      let here = true
      try {
        parsePylock(text)
      } catch (error) {
        assert.ok(error.name === 'LockfileError' || error.name === 'TomlError', error.stack)
        here = false
      }
      if (here) assert.equal(results[index].value, true, `read here, and refused by packaging: ${results[index].error}\n${text}`)
      counts[here ? 'both' : results[index].value === true ? 'stricter' : 'neither']++
    }
    assert.ok(counts.both > 100 && counts.neither > 50, JSON.stringify(counts))
  })
})
