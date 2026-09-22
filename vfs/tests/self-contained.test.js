import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `vfs/` is a package of its own, and the point of it is that it can be
// dropped into anything: nothing in it may reach outside itself, and nothing
// in it may assume a filesystem, a terminal, a locale or a host of any kind.
// A filesystem held in memory has no reason to reach for node: builtins, and
// one that carries untrusted trees has one more reason than most to have no
// dependencies at all.
//
// Enforced here rather than left to review because a single `../` is all it
// takes to undo, and it reads as harmless in a diff.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))

// The front doors are what the manifest exports; the modules behind them are
// src/. `tests/` is deliberately left out: those files are inside the package
// either way, and a test may reach for node:test and whatever else it needs.
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
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('vfs/ ships every module it has', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size >= 6, `expected a files allowlist, found ${shipped.size}`)
    assert.ok(doors.length >= 4, `expected the entry points and their typings, found ${doors.length}`)
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

describe('vfs/ imports nothing at all from outside', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 8, `expected the vfs/ modules, found ${files.length}`)
  })

  it('declares no dependencies', () => {
    assert.equal(manifest.dependencies, undefined)
    assert.equal(manifest.peerDependencies, undefined)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only within vfs/`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        assert.ok(spec.startsWith('.'), `${name} imports ${spec} — vfs/ may only import its own modules`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside vfs/`)
      }
    })
  }
})
