import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `ai/` is the model layer — the registry, the provider adapters and the
// wire formats they are assembled from, the request transport, the
// conversation loop, and the response cache. It is meant to stand on its
// own: nothing in it may reach into the pipeline that uses it (src/), the
// shared helpers (common/), or the server, so the layer can be read,
// tested and lifted out without dragging the rest of the repo behind it.
// Dependencies run one way — src/ imports ai/, never the reverse.
//
// Enforced here rather than left to review because a single `../` is all
// it takes to undo, and it reads as harmless in a diff.
//
// The other half of the boundary — that nothing outside reaches PAST
// index.js into the modules behind it — is tests/ai-surface.test.js.
const AI_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', AI_DIR)

const sourced = (name) => name.endsWith('.js') || name.endsWith('.d.ts')

// The front door plus the modules behind it. `tests/` is deliberately left
// out: these files are inside the layer either way, and a test may reach for
// node:test and whatever else it needs to drive one.
//
// Recursive, because src/ has subdirectories — a flat read silently stops
// checking any module that moves into one.
const files = [
  new URL('index.js', AI_DIR),
  new URL('index.d.ts', AI_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter(sourced)
    .map((name) => new URL(name, SRC_DIR)),
]

// Every way a module specifier can be written: static import/export-from,
// dynamic import(), and CJS require() (none of which this repo uses, but a
// boundary check that only covers today's syntax is one refactor from
// being decorative).
const SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"`])(?<spec>[^'"`]+)\k<quote>/gu

function specifiersOf(source) {
  return [...source.matchAll(SPECIFIER_RE)].map((m) => m.groups.spec)
}

// Everything the package can reach at run time has to be IN the package.
// src/ollama.js was absent from `files` for a whole PR: providers.js imports
// it unconditionally, so an install would have failed on every provider, and
// the boundary checks below all read the filesystem rather than the manifest.
describe('ai/ ships every module it imports', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', AI_DIR), 'utf8'))
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size > 5, `expected a files allowlist, found ${shipped.size}`)
  })

  for (const file of files) {
    const name = file.href.slice(AI_DIR.href.length)
    it(`files includes ${name}`, () => {
      assert.ok(shipped.has(name), `${name} is in src/ but not in package.json files`)
    })
  }
})

describe('ai/ is self-contained', () => {
  it('has files to check, including the nested ones', () => {
    // A typo'd directory or an extension this stopped matching would make
    // every assertion below vacuously pass.
    assert.ok(files.length > 5, `expected the ai/ modules, found ${files.length}`)
    // And a subdirectory has to be reached, or the check silently shrinks to
    // whatever happens to sit at the top of src/.
    const names = files.map((file) => file.href.slice(AI_DIR.href.length))
    assert.ok(names.some((name) => name.split('/').length > 2), `expected a nested module, found ${names.join(', ')}`)
  })

  for (const file of files) {
    const name = file.href.slice(AI_DIR.href.length)
    it(`${name} imports nothing outside ai/`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        // A bare specifier is node: or an npm dependency — both fine, they
        // travel with the package rather than with this repo's layout.
        if (!spec.startsWith('.')) continue
        // Anything relative has to land back inside ai/, wherever within it
        // the importing file happens to sit.
        const target = new URL(spec, file)
        assert.ok(
          target.href.startsWith(AI_DIR.href),
          `${name} imports ${spec} — ai/ may only import within itself, node: builtins and npm packages`,
        )
      }
    })
  }
})

// What npm publishes, `files` and package.json, is printable ASCII and
// newlines alone: no tab, no carriage return, no other control, nothing
// past U+007E. No file then needs an encoding to be read, and none can hide
// a bidirectional override or a lookalike letter. A comment says it in
// ASCII; a string or regexp that needs a character writes it as a \u escape.
describe('ai/ ships printable ASCII alone', () => {
  const dir = new URL('../', import.meta.url)
  const published = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')).files

  for (const name of ['package.json', ...published]) {
    it(`${name} is printable ASCII`, () => {
      const text = readFileSync(new URL(name, dir), 'utf8')
      const at = text.search(/[^\n\u0020-\u007E]/u)
      if (at === -1) return
      const line = text.slice(0, at).split('\n').length
      const column = at - text.lastIndexOf('\n', at - 1)
      const code = text.codePointAt(at).toString(16).toUpperCase().padStart(4, '0')
      assert.fail(`${name}:${line}:${column} has U+${code}: in a comment write it in ASCII, in code as \\u${code}`)
    })
  }
})
