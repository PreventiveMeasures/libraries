import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `deptree/` builds its tree in memory and reaches the network only
// through @preventive/upstream, so it imports only its own modules and the
// packages it declares: no node: builtin, and so no filesystem of its own.
// A test, as one `../` or `node:fs` undoes it and reads as harmless.
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

// npm, unlike pnpm, packs a LICENSE-MIT only when `files` names it.
const LICENSES = new Set(['LICENSE-APACHE', 'LICENSE-MIT'])

// A template literal is read only after `import(` or `require(`, because
// prose quotes a module name in backticks.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

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

  for (const name of LICENSES) {
    it(`files includes ${name}`, () => {
      assert.ok(shipped.has(name), `${name} is not in package.json files, so npm would publish without it`)
      assert.ok(existsSync(new URL(name, PKG_DIR)), `${name} is in package.json files but not in the package`)
    })
  }

  for (const name of shipped.difference(LICENSES)) {
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

  // Published as written; the next pre-release may change its API.
  it('pins a pre-release, and takes a release with a caret', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
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
