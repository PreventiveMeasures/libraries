import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { describe, it } from 'node:test'

// rn/ ships every module it has, imports nothing but its own modules and
// node: builtins, has no dependencies but optional peers (the bin's, which it
// requires by name), and is printable ASCII. What of it rn-serve has an
// app's bundle run (serve/app/) imports react-native's modules alone, which
// rn-serve resolves as the app's entry imports them. rn-serve's own code
// (serve/) imports src/, which imports nothing of it, so it can be a package
// of its own.
const PKG_DIR = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))
const doors = [...new Set(Object.values(manifest.exports).flatMap((target) => Object.values(target)))].map((door) => door.slice(2))
const filesOf = (dir) => readdirSync(new URL(`${dir}/`, PKG_DIR), { withFileTypes: true }).flatMap((entry) => (entry.isFile() ? [`${dir}/${entry.name}`] : []))
const modules = [...doors, ...['src', 'serve', 'bin'].flatMap(filesOf)]
const appModules = filesOf('serve/app')

// A specifier after from/import/require; not a quoted 'import' or 'require'.
const SPECIFIER_RE = /(?<!['"-])(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu

describe('rn/ is self-contained', () => {
  it('has modules to check', () => assert.ok(modules.length >= 12, `found ${modules.length}`))

  it('declares no dependencies but optional peers', () => {
    assert.deepEqual([manifest.dependencies, manifest.optionalDependencies], [undefined, undefined])
    for (const name of Object.keys(manifest.peerDependencies)) assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, name)
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

  for (const name of modules.filter((each) => !each.startsWith('serve/') && !each.startsWith('bin/'))) {
    it(`has ${name} import nothing of serve/`, () => {
      for (const { groups: { spec } } of readFileSync(new URL(name, PKG_DIR), 'utf8').matchAll(SPECIFIER_RE)) {
        assert.ok(!new URL(spec, new URL(name, PKG_DIR)).href.startsWith(new URL('serve/', PKG_DIR).href), `${name} imports ${spec}`)
      }
    })
  }

  for (const name of appModules) {
    it(`ships ${name}, of an app's bundle, which imports only react-native's modules`, () => {
      assert.ok(manifest.files.includes(name), `${name} is not in package.json files`)
      const specifiers = [...readFileSync(new URL(name, PKG_DIR), 'utf8').matchAll(SPECIFIER_RE)].map(({ groups: { spec } }) => spec)
      assert.ok(specifiers.length > 0)
      for (const spec of specifiers) assert.match(spec, /^react-native\/Libraries\//u, `${name} imports ${spec}`)
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
