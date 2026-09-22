import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `zip/` is a package of its own, and the point of it is that it runs
// anywhere: nothing in it may reach outside itself except what package.json
// declares, and nothing in it may reach for node: at all — an archive is
// built and read in the browser as much as anywhere, from Uint8Array up.
//
// Enforced here rather than left to review because a single `../` or one
// `node:buffer` is all it takes to undo, and either reads as harmless in a
// diff.
const ZIP_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', ZIP_DIR)

const sourced = (name) => name.endsWith('.js') || name.endsWith('.d.ts')

// The front door plus the modules behind it. `tests/` and `scripts/` are
// deliberately left out: those are inside the package but never shipped,
// and may reach for node:test, node:fs and whatever else drives them.
const files = [
  new URL('index.js', ZIP_DIR),
  new URL('index.d.ts', ZIP_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter(sourced)
    .map((name) => new URL(name, SRC_DIR)),
]

const manifest = JSON.parse(readFileSync(new URL('package.json', ZIP_DIR), 'utf8'))

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require(). A template literal is read only after
// `import(` or `require(`, because prose quotes a module name in backticks.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('zip/ ships every module it imports', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size > 5, `expected a files allowlist, found ${shipped.size}`)
  })

  for (const file of files) {
    const name = file.href.slice(ZIP_DIR.href.length)
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

describe('zip/ is self-contained and needs no node:', () => {
  it('has files to check', () => {
    assert.ok(files.length > 5, `expected the zip/ modules, found ${files.length}`)
  })

  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])

  for (const file of files) {
    const name = file.href.slice(ZIP_DIR.href.length)
    it(`${name} imports nothing outside zip/ and nothing from node:`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) {
          const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
          assert.ok(!spec.startsWith('node:'), `${name} imports ${spec}: zip/ runs on browser APIs alone`)
          assert.ok(declared.has(bare), `${name} imports ${spec}, which package.json does not declare`)
          continue
        }
        const target = new URL(spec, file)
        assert.ok(target.href.startsWith(ZIP_DIR.href), `${name} imports ${spec} — zip/ may only import within itself and declared dependencies`)
      }
    })
  }

  // Browser globals only: nothing here should touch what only node has,
  // and Buffer is the one that slips in.
  for (const file of files) {
    const name = file.href.slice(ZIP_DIR.href.length)
    it(`${name} never names Buffer or process`, () => {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\b(?:Buffer|process)\b/u)
    })
  }
})
