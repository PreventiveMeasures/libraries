import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `upstream/` is a package of its own, and the point of it is that it is
// minimal: nothing in it may reach outside itself but node: builtins, and it
// declares no dependencies — the registry and the API are fetched with the
// platform's fetch, and even semver is borrowed from the npm that ships
// beside node rather than installed. Its one optional peer, semver, is
// required only where there is no npm to borrow it from.
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
    .filter((name) => name.endsWith('.js') || name.endsWith('.cjs') || name.endsWith('.d.ts'))
    .map((name) => new URL(name, SRC_DIR)),
]

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require(). A template literal is read only after
// `import(` or `require(`, because prose quotes a module name in backticks.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

// The bare specifiers a module may require, each an optional peer dependency.
const PEERS = { 'src/semver.cjs': ['semver'] }

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('upstream/ ships every module it has', () => {
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

describe('upstream/ imports nothing from outside but node:', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 8, `expected the upstream/ modules, found ${files.length}`)
  })

  it('declares no dependencies but optional peers', () => {
    assert.equal(manifest.dependencies, undefined)
    const peers = [...new Set(Object.values(PEERS).flat())].toSorted()
    assert.deepEqual(Object.keys(manifest.peerDependencies).toSorted(), peers)
    for (const peer of peers) assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} is not an optional peer`)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only node: and within upstream/`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:') || PEERS[name]?.includes(spec)) continue
        assert.ok(spec.startsWith('.'), `${name} imports ${spec} — upstream/ may only import node: and its own modules`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside upstream/`)
      }
    })
  }
})
