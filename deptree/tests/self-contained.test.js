import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `deptree/` builds a tree in memory from what it is handed, and reaches
// the network only through @preventive/upstream: nothing in it may import
// anything but its own modules and the packages it declares — no node:
// builtin, and so no filesystem of its own.
//
// Enforced here rather than left to review because a single `../` or
// `node:fs` is all it takes to undo, and it reads as harmless in a diff.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))

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

// A bare specifier's package: `@scope/name` or `name`, less any subpath.
const packageOf = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

describe('deptree/ ships every module it has', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size >= 10, `expected a files allowlist, found ${shipped.size}`)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`files includes ${name}`, () => {
      assert.ok(shipped.has(name), `${name} is in the package but not in package.json files`)
    })
  }

  for (const name of shipped) {
    it(`${name} is a module it has`, () => {
      assert.ok(files.some((file) => file.href === new URL(name, PKG_DIR).href), `${name} is in package.json files but not in the package`)
    })
  }
})

describe('deptree/ imports nothing from outside but what it declares', () => {
  const declared = new Set(Object.keys(manifest.dependencies))

  it('declares no peer dependencies', () => {
    assert.equal(manifest.peerDependencies, undefined)
  })

  // The manifest is published as written: a pre-release is pinned, as the
  // next one may change its API, and a release takes a caret; but for
  // semver, pinned to the release yarn 1.22 bundles, as yarn's ranges are
  // read as that one reads them.
  const PINNED = new Map([['semver', '5.5.0']])
  it('pins a pre-release, and takes a release with a caret', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (PINNED.has(name)) {
        assert.equal(spec, PINNED.get(name), `${name} is ${spec}, not the release it is pinned to`)
        continue
      }
      const m = /^(\^?)\d+\.\d+\.\d+(-[\d.A-Za-z-]+)?$/u.exec(spec)
      assert.ok(m !== null, `${name} is ${spec}, not a version or a caret on one`)
      const [, caret, prerelease] = m
      if (prerelease === undefined) assert.equal(caret, '^', `${name} is ${spec}: a release takes a caret`)
      else assert.equal(caret, '', `${name} is ${spec}: a pre-release is pinned`)
    }
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only within deptree/ or a declared dependency`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside deptree/`)
        } else {
          assert.ok(declared.has(packageOf(spec)), `${name} imports ${spec}, which is not a declared dependency`)
        }
      }
    })
  }
})
