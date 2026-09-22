import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `yaml/` is a package of its own, and the point of it is that it can be
// dropped into anything: nothing in it may reach outside itself, and nothing
// in it may assume a filesystem, a terminal, a locale or a host of any kind.
// A parser that reads untrusted files has one more reason than most to have
// no dependencies at all — not even node: builtins, which it does not need.
//
// Enforced here rather than left to review because a single `../` is all it
// takes to undo, and it reads as harmless in a diff.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const sourced = (name) => name.endsWith('.js') || name.endsWith('.d.ts')

// The front doors plus the modules behind them. `tests/` is deliberately
// left out: those files are inside the package either way, and a test may
// reach for node:test and whatever else it needs to drive one.
const files = [
  new URL('index.js', PKG_DIR),
  new URL('index.d.ts', PKG_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter(sourced)
    .map((name) => new URL(name, SRC_DIR)),
]

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require(). A template literal is read only after
// `import(` or `require(`, because prose quotes a module name in backticks.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('yaml/ ships every module it has', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size >= 5, `expected a files allowlist, found ${shipped.size}`)
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
})

describe('yaml/ imports nothing at all from outside', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 5, `expected the yaml/ modules, found ${files.length}`)
  })

  it('declares no dependencies', () => {
    assert.equal(manifest.dependencies, undefined)
    assert.equal(manifest.peerDependencies, undefined)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only within yaml/`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        assert.ok(spec.startsWith('.'), `${name} imports ${spec} — yaml/ may only import its own modules`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside yaml/`)
      }
    })
  }
})
