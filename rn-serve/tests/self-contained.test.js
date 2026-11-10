import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// rn-serve/ ships every module it has, imports nothing but its own modules,
// node: builtins and @preventive/rn's exports (rn's src/ that it pins by its
// exact version), and is printable ASCII. What of it an app's bundle runs
// (src/app/) imports react-native's modules alone, which rn-serve resolves as
// the app's entry imports them.
const PKG_DIR = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))
const RN = '@preventive/rn'
const rnDir = pathToFileURL(`${dirname(dirname(fileURLToPath(import.meta.resolve(`${RN}/src/bundle.js`))))}/`)
const rnManifest = JSON.parse(readFileSync(new URL('package.json', rnDir), 'utf8'))
const filesOf = (dir) => readdirSync(new URL(`${dir}/`, PKG_DIR), { withFileTypes: true }).flatMap((entry) => (entry.isFile() ? [`${dir}/${entry.name}`] : []))
const modules = ['src', 'bin'].flatMap(filesOf)
const appModules = filesOf('src/app')

// A specifier after from/import/require; not a quoted 'import' or 'require'.
const SPECIFIER_RE = /(?<!['"-])(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu

describe('rn-serve/ is self-contained', () => {
  it('has modules to check', () => assert.ok(modules.length >= 12, `found ${modules.length}`))

  it('declares no dependency but @preventive/rn, of its own version, and optional peers', () => {
    assert.deepEqual([manifest.dependencies, manifest.optionalDependencies], [{ [RN]: rnManifest.version }, undefined])
    assert.equal(manifest.version, rnManifest.version)
    for (const name of Object.keys(manifest.peerDependencies)) assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, name)
  })

  for (const name of modules) {
    it(`ships ${name}, which imports only rn-serve/, rn's exports and node: builtins`, () => {
      assert.ok(manifest.files.includes(name), `${name} is not in package.json files`)
      for (const { groups: { spec } } of readFileSync(new URL(name, PKG_DIR), 'utf8').matchAll(SPECIFIER_RE)) {
        if (spec.startsWith('node:')) assert.ok(isBuiltin(spec), `${name} imports ${spec}`)
        else if (spec.startsWith(`${RN}/`)) assert.ok(Object.hasOwn(rnManifest.exports, `.${spec.slice(RN.length)}`), `${name} imports ${spec}, which rn doesn't export`)
        else assert.ok(spec.startsWith('.') && new URL(spec, new URL(name, PKG_DIR)).href.startsWith(PKG_DIR.href), `${name} imports ${spec}`)
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
