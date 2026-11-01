import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { describe, it } from 'node:test'

// rn/ ships every module it has, imports nothing but its own modules and
// node: builtins, declares no dependencies, and is printable ASCII.
const PKG_DIR = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))
const doors = [...new Set(Object.values(manifest.exports).flatMap((target) => Object.values(target)))].map((door) => door.slice(2))
const modules = [...doors, ...readdirSync(new URL('src/', PKG_DIR)).map((name) => `src/${name}`)]

// A specifier after from/import/require; not a quoted 'import' or 'require'.
const SPECIFIER_RE = /(?<!['"-])(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu

describe('rn/ is self-contained', () => {
  it('has modules to check', () => assert.ok(modules.length >= 12, `found ${modules.length}`))

  it('declares no dependencies', () => {
    assert.deepEqual([manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies], [undefined, undefined, undefined])
  })

  for (const name of modules) {
    it(`ships ${name}, which imports only rn/ and node: builtins`, () => {
      assert.ok(manifest.files.includes(name), `${name} is not in package.json files`)
      for (const { groups: { spec } } of readFileSync(new URL(name, PKG_DIR), 'utf8').matchAll(SPECIFIER_RE)) {
        if (spec.startsWith('node:')) assert.ok(isBuiltin(spec), `${name} imports ${spec}`)
        else assert.ok(spec.startsWith('.') && new URL(spec, new URL(name, PKG_DIR)).href.startsWith(PKG_DIR.href), `${name} imports ${spec}`)
      }
    })
  }

  for (const name of ['package.json', ...manifest.files]) {
    it(`${name} is printable ASCII`, () => {
      const text = readFileSync(new URL(name, PKG_DIR), 'utf8')
      const at = text.search(/[^\n -~]/u)
      assert.equal(at, -1, `${name}:${text.slice(0, at).split('\n').length} has U+${text.codePointAt(at)?.toString(16).toUpperCase().padStart(4, '0')}`)
    })
  }
})
