import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `lockfile/` is a package of its own that reads untrusted files, and the
// point of it is that it can be dropped into anything: nothing in it may
// reach outside itself but for the dependencies it declares — the YAML
// parser beneath it — and nothing in it may assume a filesystem, a
// terminal, a locale or a host of any kind, so not even a node: builtin.
//
// Enforced here rather than left to review because a single `../` is all it
// takes to undo, and it reads as harmless in a diff.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const sourced = (name) => name.endsWith('.js') || name.endsWith('.d.ts')

// The front doors plus the modules behind them. `tests/` and `scripts/` are
// left out: neither ships, and each may reach for whatever drives it.
const files = [
  new URL('pnpm.js', PKG_DIR),
  new URL('pnpm.d.ts', PKG_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter(sourced)
    .map((name) => new URL(name, SRC_DIR)),
]

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))
const declared = new Set(Object.keys(manifest.dependencies))

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require(). A template literal is read only after
// `import(` or `require(`, because prose quotes a module name in backticks.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('lockfile/ ships every module it has', () => {
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

  for (const [subpath, target] of Object.entries(manifest.exports)) {
    it(`the ${subpath} entry point is shipped`, () => {
      for (const path of Object.values(target)) {
        assert.ok(shipped.has(path.replace('./', '')), `${subpath} resolves to ${path}, which is not in package.json files`)
      }
    })
  }
})

describe('lockfile/ imports nothing from outside but what it declares', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 10, `expected the lockfile/ modules, found ${files.length}`)
  })

  it('declares the YAML parser, and nothing else', () => {
    assert.deepEqual([...declared], ['@preventive/yaml'])
    assert.equal(manifest.peerDependencies, undefined)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only within lockfile/ or a declared dependency`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (declared.has(spec)) continue
        assert.ok(spec.startsWith('.'), `${name} imports ${spec} — lockfile/ may only import its own modules and ${[...declared].join(', ')}`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside lockfile/`)
      }
    })
  }
})
