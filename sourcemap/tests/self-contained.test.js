import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// `sourcemap/` is a package of its own, and minimal: nothing in it may
// reach outside itself, and it declares no dependencies. It runs where
// JavaScript does, so no node: builtin either, but in a .node.js file: the
// one way of loading its one optional peer, oxc-parser, on Node, behind
// the edges.js door; a browser bundle takes oxc.browser.js instead (see
// `browser` in package.json). Reading a map needs no parser.
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
// dynamic import(), CJS require(), and a require() createRequire() made. A
// template literal is read only after `import(` or `require(`, because prose
// quotes a module name in backticks. A keyword in quotes is a string, not
// a statement: this package names its import kinds 'import', 'require' and
// 'export-from'.
const SPECIFIER_RE = /(?<!['"-])(?:\bfrom|\bimport|\brequire|\bcreateRequire\([^()]*\)\s*\()\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const TEMPLATE_RE = /(?:\bimport|\brequire)\s*\(\s*`(?<spec>[^`$\n]+)`/gu

// The bare specifiers a module may import, each an optional peer dependency.
const PEERS = { 'src/oxc.node.js': ['oxc-parser'], 'src/oxc.browser.js': ['oxc-parser'] }

const specifiersOf = (source) => [SPECIFIER_RE, TEMPLATE_RE].flatMap((re) => [...source.matchAll(re)].map((m) => m.groups.spec))

describe('sourcemap/ ships every module it has', () => {
  const shipped = new Set(manifest.files)

  it('lists a plausible set of files', () => {
    assert.ok(shipped.size >= 10, `expected a files allowlist, found ${shipped.size}`)
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

describe('sourcemap/ imports nothing from outside but its peer, and node: on Node alone', () => {
  it('has files to check', () => {
    assert.ok(files.length >= 12, `expected the sourcemap/ modules, found ${files.length}`)
  })

  it('declares no dependencies but optional peers', () => {
    assert.equal(manifest.dependencies, undefined)
    const peers = [...new Set(Object.values(PEERS).flat())].toSorted()
    assert.deepEqual(Object.keys(manifest.peerDependencies).toSorted(), peers)
    for (const peer of peers) assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} is not an optional peer`)
  })

  for (const file of files) {
    const name = file.href.slice(PKG_DIR.href.length)
    it(`${name} imports only within sourcemap/`, () => {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if ((spec.startsWith('node:') && name.endsWith('.node.js')) || PEERS[name]?.includes(spec)) continue
        assert.ok(spec.startsWith('.'), `${name} imports ${spec} — sourcemap/ may only import its own modules, and node: in a .node.js file`)
        assert.ok(new URL(spec, file).href.startsWith(PKG_DIR.href), `${name} imports ${spec}, which is outside sourcemap/`)
      }
    })
  }

  // These doors must not load the parser, nor bring it into a browser
  // bundle: reading a map, and Metro's edges, are for anyone.
  for (const [door, needs] of [['sourcemap.js', 'src/map.js'], ['edges-lite.js', 'src/metro.js']]) {
    it(`${door} reaches no module that loads the parser`, () => {
      const reached = new Set()
      const visit = (url) => {
        const name = url.href.slice(PKG_DIR.href.length)
        if (reached.has(name)) return
        reached.add(name)
        for (const spec of specifiersOf(readFileSync(url, 'utf8'))) if (spec.startsWith('.')) visit(new URL(spec, url))
      }
      visit(new URL(door, PKG_DIR))
      assert.ok(reached.has(needs))
      for (const module of ['src/parser.js', ...Object.keys(PEERS)]) assert.ok(!reached.has(module), `${door} reaches ${module}`)
    })
  }
})
