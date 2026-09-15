import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `diff/` is a package of its own, and the point of it is that it can be
// dropped into anything: nothing in it may reach outside itself, and nothing
// in it may assume a filesystem, a terminal, a locale or a host of any kind.
// It was lifted whole out of @preventive/terminal, where it sat behind an
// import away from all four — so the boundary is the thing worth guarding,
// not the extraction.
//
// Enforced here rather than left to review because a single `../` is all it
// takes to undo, and it reads as harmless in a diff.
const DIFF_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', DIFF_DIR)

const sourced = (name) => name.endsWith('.js') || name.endsWith('.d.ts')

// The front doors plus the modules behind them. `tests/` is deliberately
// left out: those files are inside the package either way, and a test may
// reach for node:test and whatever else it needs to drive one.
//
// Recursive, so a module that moves into a subdirectory goes on being
// checked rather than silently stopping.
const files = [
  new URL('index.js', DIFF_DIR),
  new URL('index.d.ts', DIFF_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter(sourced)
    .map((name) => new URL(name, SRC_DIR)),
]

const manifest = JSON.parse(readFileSync(new URL('package.json', DIFF_DIR), 'utf8'))

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require() (neither of the last two is used here,
// but a boundary check that only covers today's syntax is one refactor from
// being decorative). A template literal is read only after `import(` or
// `require(`, because prose quotes a module name in backticks — this file's
// own comments do — and `from \`b\`` in a sentence is not an import.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$]+)`/gu

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('diff/ ships every module it imports', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size > 5, `expected a files allowlist, found ${shipped.size}`)
  })

  for (const file of files) {
    const name = file.href.slice(DIFF_DIR.href.length)
    it(`files includes ${name}`, () => {
      assert.ok(shipped.has(name), `${name} is in the package but not in package.json files`)
    })
  }

  // An entry point is what a caller names; one that points at a file the
  // package does not ship fails on install rather than here.
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    it(`the ${subpath} entry point is shipped`, () => {
      for (const path of Object.values(target)) {
        assert.ok(shipped.has(path.replace('./', '')), `${subpath} resolves to ${path}, which is not in package.json files`)
        assert.ok(files.some((file) => file.href.endsWith(path.slice(1))), `${subpath} resolves to ${path}, which does not exist`)
      }
    })
  }
})

describe('diff/ is self-contained', () => {
  it('has files to check', () => {
    // A typo'd directory or an extension this stopped matching would make
    // every assertion below vacuously pass.
    assert.ok(files.length > 5, `expected the diff/ modules, found ${files.length}`)
  })

  // Nothing is declared, so nothing but node: may be named. A dependency
  // added later has to be declared before this passes again, which is the
  // reminder worth having.
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])

  for (const file of files) {
    const name = file.href.slice(DIFF_DIR.href.length)
    it(`${name} imports nothing outside diff/`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) {
          const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
          assert.ok(spec.startsWith('node:') || declared.has(bare), `${name} imports ${spec}, which package.json does not declare`)
          continue
        }
        // Anything relative has to land back inside diff/, wherever within
        // it the importing file happens to sit.
        const target = new URL(spec, file)
        assert.ok(
          target.href.startsWith(DIFF_DIR.href),
          `${name} imports ${spec} — diff/ may only import within itself, node: builtins and declared dependencies`,
        )
      }
    })
  }
})
