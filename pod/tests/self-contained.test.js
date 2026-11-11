import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { describe, it } from 'node:test'

// pod/ ships every file it has, imports nothing but its own modules, node: builtins and the packages it depends
// on, and is printable ASCII, the scripts it writes into Pods/ too.
const PKG_DIR = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', PKG_DIR), 'utf8'))
const filesOf = (dir) => readdirSync(new URL(`${dir}/`, PKG_DIR), { recursive: true }).map((path) => `${dir}/${path}`).filter((path) => statSync(new URL(path, PKG_DIR)).isFile()).sort()
const files = ['src', 'bin'].flatMap(filesOf)
const modules = files.filter((name) => name.endsWith('.js'))
const SPECIFIER_RE = /(?<!['"#-])(?:\bfrom|\bimport)\s*\(?\s*(?<quote>['"])(?<spec>[^'"\n]+)\k<quote>/gu
const specifiersOf = (name) => [...readFileSync(new URL(name, PKG_DIR), 'utf8').matchAll(SPECIFIER_RE)].map(({ groups: { spec } }) => spec)
// The module a relative specifier of `name` names, by its path from pod/.
const targetOf = (name, spec) => new URL(spec, new URL(name, PKG_DIR)).href.slice(PKG_DIR.href.length)

// The stages, each a directory of src/, and their entries, <stage>/<stage>.js.
const STAGES = ['podspec', 'sources', 'prepare', 'generate']
const stageOf = (path) => STAGES.find((stage) => path.startsWith(`src/${stage}/`))

describe('pod/ is self-contained', () => {
  it('has modules to check', () => assert.ok(modules.length >= 20, `found ${modules.length}`))

  for (const name of files) {
    it(`ships ${name}`, () => assert.ok(manifest.files.includes(name), `${name} is not in package.json files`))
  }

  for (const name of modules) {
    it(`${name} imports only pod/, node: builtins and its dependencies`, () => {
      for (const spec of specifiersOf(name)) {
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

describe('the stages of src/ are isolated', () => {
  it('has each stage', () => assert.deepEqual(STAGES.filter((stage) => modules.includes(`src/${stage}/${stage}.js`)), STAGES))

  for (const name of modules.filter((one) => one.startsWith('src/'))) {
    const stage = stageOf(name)
    it(stage === undefined ? `${name} imports a stage by its entry alone` : `${name} imports no other stage`, () => {
      for (const target of specifiersOf(name).filter((spec) => spec.startsWith('.')).map((spec) => targetOf(name, spec))) {
        const other = stageOf(target)
        if (stage !== undefined) assert.ok(other === undefined || other === stage, `${name} imports ${target}, of the ${other} stage`)
        else if (other !== undefined) assert.equal(target, `src/${other}/${other}.js`, `${name} imports ${target}, past the ${other} stage's entry`)
      }
    })
  }
})
