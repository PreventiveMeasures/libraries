import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `compare/` is a package of its own, standing on two others: nothing in it
// may reach outside itself but for @preventive/diff and @exodus/bytes, and
// oxc-parser and oxc-minify, optional peers names.js loads, in the modules
// that load them alone (#oxc). It
// reads no disk and runs where JavaScript does, so no node: builtin or Node
// global either -- but in a .node.js module, which package.json imports
// gives Node alone, in place of a portable twin. tests/ and scripts/ are
// git's side of things, and may.
//
// Enforced here rather than left to review because a single `../` is all it
// takes to undo, and it reads as harmless in a diff.
const PKG_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', PKG_DIR)

const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))

// The front doors are what the manifest exports; the modules behind them are
// src/, recursively, so a module that moves into a subdirectory goes on
// being checked rather than silently stopping.
const doors = [...new Set(Object.values(manifest.exports).flatMap((target) => Object.values(target)))]
const imports = manifest.imports ?? {}
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
const nameOf = (file) => file.href.slice(PKG_DIR.href.length)
const forNode = (name) => name.endsWith('.node.js')
const NODE_GLOBALS = /\b(?:Buffer|process)\s*\.|\brequire\s*\(|\b__(?:dirname|filename)\b/u
const shipped = new Set(manifest.files)

describe('compare/ ships every module it has', () => {
  it('lists a plausible set of files', () => {
    assert.ok(shipped.size >= 10, `expected a files allowlist, found ${shipped.size}`)
  })

  for (const file of files) {
    it(`files includes ${nameOf(file)}`, () => {
      assert.ok(shipped.has(nameOf(file)), `${nameOf(file)} is in the package but not in package.json files`)
    })
  }

  it('lists nothing that is not there', () => {
    const there = new Set(files.map(nameOf))
    for (const name of shipped) if (name.endsWith('.js') || name.endsWith('.d.ts')) assert.ok(there.has(name), `${name} is in package.json files but not in the package`)
  })
})

describe('compare/ is self-contained', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 10, `expected the compare/ modules, found ${files.length}`)
  })

  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
  const loaders = new Set(Object.values(imports['#oxc'] ?? {}).map((path) => path.slice(2)))

  it('declares @preventive/diff and @exodus/bytes alone', () => {
    assert.deepEqual([...declared], ['@exodus/bytes', '@preventive/diff'])
  })

  it('takes oxc-minify and oxc-parser as optional peers alone, loaded by #oxc', () => {
    assert.deepEqual([...peers], ['oxc-minify', 'oxc-parser'])
    for (const peer of peers) assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} is optional`)
    assert.deepEqual([...loaders], ['src/oxc.node.js', 'src/oxc.js'])
  })

  for (const file of files) {
    it(`${nameOf(file)} imports nothing outside compare/ but what it declares`, () => {
      const source = readFileSync(file, 'utf8')
      for (const spec of specifiersOf(source)) {
        if (spec.startsWith('.')) {
          const target = new URL(spec, file)
          assert.ok(target.href.startsWith(PKG_DIR.href), `${nameOf(file)} imports ${spec}, outside compare/`)
          assert.ok(forNode(nameOf(file)) || !forNode(nameOf(target)), `${nameOf(file)} imports ${spec}, which Node alone runs`)
          continue
        }
        if (spec.startsWith('#')) {
          assert.ok(Object.hasOwn(imports, spec), `${nameOf(file)} imports ${spec}, which package.json imports lacks`)
          continue
        }
        if (spec.startsWith('node:')) {
          assert.ok(forNode(nameOf(file)), `${nameOf(file)} imports ${spec}, which only a .node.js module may`)
          continue
        }
        const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        assert.ok(declared.has(bare) || (peers.has(bare) && loaders.has(nameOf(file))), `${nameOf(file)} imports ${spec}, which is no dependency of compare/`)
      }
      if (!forNode(nameOf(file)) && file.href.endsWith('.js')) assert.doesNotMatch(source, NODE_GLOBALS, `${nameOf(file)} names a Node global`)
    })
  }

  // A browser bundle of compare.js alone needs no oxc peer installed: only
  // names.js leads to #oxc, whose portable module imports both as it loads.
  it('compare.js reaches no #oxc module', () => {
    const queue = [new URL('compare.js', PKG_DIR)], seen = new Set()
    while (queue.length > 0) {
      const file = queue.pop()
      if (seen.has(file.href)) continue
      seen.add(file.href)
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        assert.notEqual(spec, '#oxc', `${nameOf(file)}, which compare.js loads, imports #oxc`)
        if (spec.startsWith('.')) queue.push(new URL(spec, file))
      }
    }
    assert.ok(seen.size >= 10, `compare.js loads ${seen.size} modules`)
  })

  for (const [spec, target] of Object.entries(imports)) {
    it(`${spec} leads to a .node.js module on Node alone, and a portable one elsewhere`, () => {
      assert.deepEqual(Object.keys(target), ['node', 'default'])
      assert.ok(forNode(target.node) && !forNode(target.default), `${spec}: ${target.node}, ${target.default}`)
      for (const path of Object.values(target)) assert.ok(path.startsWith('./') && shipped.has(path.slice(2)), `${spec}: ${path} is not a shipped file of compare/`)
    })
  }
})

// What npm publishes, `files` and package.json, is printable ASCII and
// newlines alone. A comment says it in ASCII; a string or regexp that needs
// a character writes it as a \u escape.
describe('compare/ ships printable ASCII alone', () => {
  for (const name of ['package.json', ...manifest.files]) {
    it(`${name} is printable ASCII`, () => {
      const text = readFileSync(new URL(name, PKG_DIR), 'utf8')
      const at = text.search(/[^\n\u0020-\u007E]/u)
      if (at === -1) return
      const line = text.slice(0, at).split('\n').length
      const code = text.codePointAt(at).toString(16).toUpperCase().padStart(4, '0')
      assert.fail(`${name}:${line} has U+${code}: in a comment write it in ASCII, in code as \\u${code}`)
    })
  }
})
