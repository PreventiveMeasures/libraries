import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { describe, it } from 'node:test'

// pod/ ships every module it has, imports nothing but its own modules, node: builtins and the packages it
// depends on, and is printable ASCII, the scripts it writes into Pods/ too.
const PKG_DIR = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))
const filesOf = (dir) => readdirSync(new URL(`${dir}/`, PKG_DIR), { withFileTypes: true }).flatMap((entry) => (entry.isFile() ? [`${dir}/${entry.name}`] : []))
const modules = ['src', 'bin'].flatMap(filesOf)
const SPECIFIER_RE = /(?<!['"#-])(?:\bfrom|\bimport)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu

describe('pod/ is self-contained', () => {
  it('has modules to check', () => assert.ok(modules.length >= 20, `found ${modules.length}`))

  for (const name of [...modules, ...filesOf('src/scripts')]) {
    it(`ships ${name}`, () => assert.ok(manifest.files.includes(name), `${name} is not in package.json files`))
  }

  for (const name of modules) {
    it(`${name} imports only pod/, node: builtins and its dependencies`, () => {
      for (const { groups: { spec } } of readFileSync(new URL(name, PKG_DIR), 'utf8').matchAll(SPECIFIER_RE)) {
        if (spec.startsWith('node:')) assert.ok(isBuiltin(spec), `${name} imports ${spec}`)
        else if (spec.startsWith('.')) assert.ok(new URL(spec, new URL(name, PKG_DIR)).href.startsWith(PKG_DIR.href), `${name} imports ${spec}`)
        else assert.ok(Object.keys(manifest.dependencies).some((dependency) => spec === dependency || spec.startsWith(`${dependency}/`)), `${name} imports ${spec}`)
      }
    })
  }

  for (const name of ['package.json', ...manifest.files]) {
    it(`${name} is printable ASCII`, () => {
      const text = readFileSync(new URL(name, PKG_DIR), 'utf8')
      const at = text.search(/[^\t\n -~]/u)
      assert.equal(at, -1, `${name} has ${JSON.stringify(text[at])} at ${at}`)
    })
  }
})
