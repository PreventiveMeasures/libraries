import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError, linkCargo, parseCargoLock, parseCargoManifest, readCargoVendor, resolveCargoFeatures } from '../../cargo.js'

// A workspace cargo locked and vendored, and what cargo made of it, from
// scripts/record-cargo.js: which vendored directory each package is read
// from, the graph with each edge's kinds and platforms, and what each
// package is built with, for a few command lines under resolver 1 and 2.

const DIR = new URL('fixtures/workspace/', import.meta.url)
const read = (path) => readFileSync(new URL(path, DIR), 'utf8')
const expected = JSON.parse(readFileSync(new URL('fixtures/workspace.json', import.meta.url), 'utf8'))

const lock = parseCargoLock(read('Cargo.lock'))
const vendor = Object.fromEntries(readdirSync(new URL('vendor/', DIR)).map((name) => [
  name,
  { manifest: read(`vendor/${name}/Cargo.toml`), checksum: read(`vendor/${name}/.cargo-checksum.json`) },
]))
const vendored = readCargoVendor(lock, vendor)

// The root's text with a resolver named, as the recording has it.
function load(resolver) {
  const text = read('Cargo.toml')
  const root = parseCargoManifest(resolver === undefined ? text : text.replace('[workspace]\n', `[workspace]\nresolver = "${resolver}"\n`))
  const manifests = {}
  for (const [key, path] of Object.entries(expected.manifests)) {
    manifests[key] = path === 'Cargo.toml' ? root : parseCargoManifest(read(path), path.startsWith('crates/') && key !== 'extra 0.3.0' ? root : undefined)
  }
  for (const [key, { directory }] of Object.entries(vendored)) manifests[key] = parseCargoManifest(vendor[directory].manifest)
  return linkCargo(lock, manifests, { workspace: root, members: expected.members })
}

const norm = (list) => list.map((item) => item.replaceAll(' ', '')).sort()

describe('a workspace cargo locked and vendored', () => {
  it('reads each package from the directory cargo does', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(vendored).map(([key, { directory }]) => [key, directory])), expected.vendored)
  })

  it('tells apart three copies of itoa, by the version inside', () => {
    const graph = load()
    const app = graph.packages['app 0.1.0']
    const copy = (name) => vendored[app.dependencies.find((dep) => dep.name === name).resolved].directory
    assert.deepEqual([copy('itoa'), copy('itoa04'), copy('itoa-git')], ['itoa', 'itoa-0.4.8', 'itoa-1.0.0'])
  })

  it('gives each vendored file its checksum', () => {
    const memchr = Object.entries(vendored).find(([key]) => key.startsWith('memchr '))[1]
    assert.match(memchr.files['Cargo.toml'], /^[\da-f]{64}$/u)
  })

  it('lays the manifests over the lockfile as cargo does', () => {
    const graph = load()
    const ours = {}
    for (const [key, pkg] of Object.entries(graph.packages)) {
      ours[key] = {}
      for (const dep of pkg.dependencies.filter((d) => d.active)) {
        ;(ours[key][dep.resolved] ??= []).push(`${dep.kind} ${dep.target ?? '*'}`)
      }
    }
    for (const [key, deps] of Object.entries(expected.graph)) {
      assert.deepEqual(Object.keys(ours[key]).sort(), Object.keys(deps).sort(), key)
      for (const [dep, kinds] of Object.entries(deps)) assert.deepEqual(norm(ours[key][dep]), norm(kinds), `${key} -> ${dep}`)
    }
  })

  it('reads the resolver and root of the workspace', () => {
    assert.deepEqual([load().resolver, load('1').resolver, load().root], [2, 1, 'app 0.1.0'])
  })

  for (const [resolver, builds] of Object.entries(expected.features)) {
    for (const build of builds) {
      const target = build.target ?? expected.host
      const title = `resolver ${resolver}: ${build.packages === 'all' ? '--workspace' : build.packages.map((p) => `-p ${p}`).join(' ')} ${JSON.stringify({ ...build, packages: undefined, built: undefined })}`
      it(`turns on what cargo builds with, ${title}`, () => {
        const graph = load(resolver)
        const keys = (names) => names.map((name) => graph.members.find((key) => key.startsWith(`${name} `)))
        const options = {
          packages: build.packages === 'all' ? graph.members : keys(build.packages),
          features: build.features,
          allFeatures: build.allFeatures,
          noDefaultFeatures: build.noDefaultFeatures,
          dev: build.dev,
          host: { name: expected.host, cfg: expected.cfg[expected.host] },
          targets: [{ name: target, cfg: expected.cfg[target] }],
        }
        if (build.built === null) {
          assert.throws(() => resolveCargoFeatures(graph, options), LockfileError)
          return
        }
        const resolved = resolveCargoFeatures(graph, options)
        for (const [unit, features] of Object.entries(build.built)) {
          const [key, fk] = [unit.slice(0, unit.lastIndexOf(' ')), unit.slice(unit.lastIndexOf(' ') + 1)]
          assert.deepEqual(resolved[key]?.[fk], features, unit)
        }
        // Nothing it lists goes unbuilt, but a proc-macro member for the
        // target, which cargo resolves in case the member has more targets.
        for (const [key, kinds] of Object.entries(resolved)) {
          for (const fk of ['normal', 'host'].filter((kind) => kinds[kind] !== undefined)) {
            if (!(`${key} ${fk}` in build.built)) assert.deepEqual([key, fk], ['macros 0.1.0', 'normal'])
          }
        }
      })
    }
  }
})
