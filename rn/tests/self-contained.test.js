import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `rn/` is a package of its own, and a small one: nothing in it may reach
// outside itself but for Node's builtins, and it declares no dependencies. It
// reads React Native's and Metro's behaviour as data and runs none of their
// code, so it needs none of their packages; the tests check it against one.
//
// Enforced here rather than left to review because a single `../` is all it
// takes to undo, and it reads as harmless in a diff.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))

// The front doors are what the manifest exports; the modules behind them are
// src/. `tests/` is left out: a test may reach for whatever it needs.
const doors = [...new Set(Object.values(manifest.exports).flatMap((target) => Object.values(target)))]
const files = [
  ...doors.map((door) => new URL(door, PKG_DIR)),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'))
    .map((name) => new URL(name, SRC_DIR)),
]

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require(). A template literal is read only after
// `import(` or `require(`, because prose quotes a module name in backticks.
// A keyword in quotes is a string, not a statement: the resolver names the
// kinds of import 'import' and 'require'.
const SPECIFIER_RE = /(?<!['"-])(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('rn/ ships every module it has', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size >= 10, `expected a files allowlist, found ${shipped.size}`)
    assert.ok(doors.length >= 6, `expected the entry points and their typings, found ${doors.length}`)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`files includes ${name}`, () => {
      assert.ok(shipped.has(name), `${name} is in the package but not in package.json files`)
    })
  }

  for (const [subpath, target] of Object.entries(manifest.exports)) {
    it(`the ${subpath} entry point is shipped`, () => {
      for (const path of Object.values(target)) {
        assert.ok(shipped.has(path.replace('./', '')), `${subpath} resolves to ${path}, which is not in package.json files`)
        assert.ok(files.some((file) => file.href.endsWith(path.slice(1))), `${subpath} resolves to ${path}, which does not exist`)
      }
    })
  }

  it('names each Metro door for Metro', () => {
    for (const subpath of Object.keys(manifest.exports)) {
      const reads = readFileSync(new URL(subpath, PKG_DIR), 'utf8')
      if (/src\/metro\//u.test(reads)) assert.match(subpath, /^\.\/metro-/u, `${subpath} serves Metro's behaviour but is not named for it`)
    }
  })
})

describe('rn/ imports nothing from outside but Node\'s builtins', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 14, `expected the rn/ modules, found ${files.length}`)
  })

  it('declares no dependencies', () => {
    assert.equal(manifest.dependencies, undefined)
    assert.equal(manifest.peerDependencies, undefined)
    assert.equal(manifest.optionalDependencies, undefined)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only within rn/, or node: builtins`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:')) {
          assert.ok(isBuiltin(spec), `${name} imports ${spec}, which is no builtin`)
          continue
        }
        assert.ok(spec.startsWith('.'), `${name} imports ${spec} -- rn/ may only import its own modules and node: builtins`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside rn/`)
      }
    })
  }
})

// What npm publishes, `files` and package.json, is printable ASCII and
// newlines alone: no tab, no carriage return, no other control, nothing
// past U+007E. A comment says it in ASCII; a string or regexp that needs a
// character writes it as a \u escape.
describe('rn/ ships printable ASCII alone', () => {
  for (const name of ['package.json', ...manifest.files]) {
    it(`${name} is printable ASCII`, () => {
      const text = readFileSync(new URL(name, PKG_DIR), 'utf8')
      const at = text.search(/[^\n -~]/u)
      if (at === -1) return
      const line = text.slice(0, at).split('\n').length
      const column = at - text.lastIndexOf('\n', at - 1)
      const code = text.codePointAt(at).toString(16).toUpperCase().padStart(4, '0')
      assert.fail(`${name}:${line}:${column} has U+${code}: in a comment write it in ASCII, in code as \\u${code}`)
    })
  }
})
