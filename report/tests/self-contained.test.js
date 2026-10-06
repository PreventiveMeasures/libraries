import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `report/` is text in, data out — and data in, text out. It runs in the
// triage viewer as much as under node, so it imports its own modules plus
// markdown-it, a browser-compatible tokenizer, and no node: builtin. Keep that
// exception explicit: an unrelated package or parent-directory import must
// still fail this boundary check.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))

// The front door plus the modules behind it. `tests/` is deliberately left
// out: those files are never shipped, and a test may reach for node:test
// and whatever else it needs to drive one.
//
// Recursive, so a module that moves into a subdirectory goes on being
// checked rather than silently stopping.
const files = [
  new URL('index.js', PKG_DIR),
  new URL('index.d.ts', PKG_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'))
    .map((name) => new URL(name, SRC_DIR)),
]

// npm, unlike pnpm, packs a LICENSE-MIT only when `files` names it.
const LICENSES = new Set(['LICENSE-APACHE', 'LICENSE-MIT'])

// A template literal is read only after `import(` or `require(`, because
// prose quotes a module name in backticks. Line comments are dropped before
// reading: index.js shows a caller's import line as an example.
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

const specifiersOf = (source) => {
  const code = source.replaceAll(/^\s*\/\/.*$/gmu, '')
  return [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...code.matchAll(re)].map((m) => m.groups.spec))
}

describe('report/ ships every module it has', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size > 20, `expected a files allowlist, found ${shipped.size}`)
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

  // npm ignores an entry naming nothing, so a rename would leave the module
  // unpublished with the list still looking full.
  for (const name of shipped.difference(LICENSES)) {
    it(`${name} is a module it has`, () => {
      assert.ok(files.some((file) => file.href === new URL(name, PKG_DIR).href), `${name} is in package.json files but not in the package`)
    })
  }

  // One way in: index.js names the whole surface, so everything behind it
  // may move or be renamed without breaking a caller.
  it('exports index.js and nothing deeper', () => {
    assert.deepEqual(Object.keys(manifest.exports).toSorted(), ['.', './package.json'])
    assert.deepEqual(manifest.exports['.'], { types: './index.d.ts', default: './index.js' })
  })
})

describe('report/ keeps its browser-compatible dependency boundary', () => {
  it('has files to check', () => {
    // A typo'd directory or an extension this stopped matching would make
    // every assertion below vacuously pass.
    assert.ok(files.length > 20, `expected the report/ modules, found ${files.length}`)
  })

  it('declares only the Markdown tokenizer dependency', () => {
    assert.deepEqual(Object.keys(manifest.dependencies), ['markdown-it'])
    assert.equal(manifest.peerDependencies, undefined)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only local modules or its declared Markdown tokenizer`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (name === 'src/parse-generic-md.js' && spec === 'markdown-it') continue
        assert.ok(spec.startsWith('.'), `${name} imports ${spec}: report/ imports only its own modules`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside report/`)
      }
    })
  }
})
