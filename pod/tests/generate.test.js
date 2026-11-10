import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { generate } from '../src/generate.js'
import { load } from '../src/load.js'
import { parseAscii } from '../src/plist.js'

// Each fixture is a project CocoaPods 1.16.2 itself has installed: `project` what it read, and what pod reads,
// `expected` what it generated in Pods/. See fixtures/export.mjs.
const FIXTURES = new URL('fixtures/', import.meta.url).pathname
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))

// A project file as the objects it holds, each in place of its id, so that two with other ids compare; what
// names an object that holds it, or a target, is its name.
function treeOf(text) {
  const { objects, rootObject, ...rest } = parseAscii(text, 'project.pbxproj')
  const NAMED = new Set(['remoteGlobalIDString', 'target'])
  const expand = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => expand(item, key))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expand(item, name)]))
    if (key === 'containerPortal') return 'project'
    if (!Object.hasOwn(objects, value)) return value
    return NAMED.has(key) ? objects[value].name : expand(objects[value], undefined)
  }
  return { ...rest, root: expand(rootObject, undefined) }
}

for (const name of ['frameworks', 'libraries', 'dynamic']) {
  describe(`generate, of the ${name} fixture`, async () => {
    const expected = join(FIXTURES, name, 'expected')
    const { files, links } = generate(await load(join(FIXTURES, name, 'project')))
    const written = walk(expected).filter((path) => path !== 'links.json' && !path.startsWith('Pods.xcodeproj/'))

    it('generates the files CocoaPods does, and no other', () => {
      assert.deepEqual([...files.keys()].filter((path) => !path.startsWith('Pods.xcodeproj/')).sort(), written.sort())
    })

    for (const path of written) {
      it(`writes ${path} as CocoaPods does`, () => {
        assert.equal(Buffer.from(files.get(path) ?? '').toString('utf8'), readFileSync(join(expected, path), 'utf8'))
      })
    }

    it('links the headers CocoaPods does', () => {
      assert.deepEqual(Object.fromEntries([...links].sort(([a], [b]) => (a < b ? -1 : 1))), JSON.parse(readFileSync(join(expected, 'links.json'), 'utf8')))
    })

    it('builds the Pods project CocoaPods does, object for object', () => {
      assert.deepEqual(treeOf(files.get('Pods.xcodeproj/project.pbxproj')), treeOf(readFileSync(join(expected, 'Pods.xcodeproj/project.pbxproj'), 'utf8')))
    })
  })
}

describe('generate, with build settings of pod.config.json', () => {
  it('sets them on every target, and a pod\'s own on its target alone', async () => {
    const input = await load(join(FIXTURES, 'frameworks/project'))
    input.config.buildSettings = { CODE_SIGNING_ALLOWED: 'NO' }
    input.config.pods.Alpha = { buildSettings: { HEADER_SEARCH_PATHS: '$(inherited) $(SRCROOT)/..' } }
    const { root } = treeOf(generate(input).files.get('Pods.xcodeproj/project.pbxproj'))
    const settings = Object.fromEntries(root.targets.map((target) => [target.name, target.buildConfigurationList.buildConfigurations.map((configuration) => configuration.buildSettings)]))
    assert.deepEqual(Object.keys(settings), ['Alpha', 'Alpha-Alpha_privacy', 'Beta', 'Delta', 'Gamma', 'Pods-defaults-App', 'Pods-defaults-Ext'])
    for (const [name, configurations] of Object.entries(settings)) {
      for (const one of configurations) {
        assert.equal(one.CODE_SIGNING_ALLOWED, 'NO', name)
        assert.deepEqual(one.HEADER_SEARCH_PATHS, name === 'Alpha' ? ['$(inherited)', '$(SRCROOT)/..'] : undefined, name)
      }
    }
  })
})

describe('generate, of dynamic frameworks', () => {
  const staticFramework = (input, name, value) => {
    input.pods.find((pod) => pod.name === name).root.attributes.static_framework = value
  }

  it('refuses a dynamic framework with a pod linked statically under it, as CocoaPods does', async () => {
    // Beta, built dynamic, on Alpha, built static: `pod install` 1.16.2 fails on it, with the same words.
    const input = await load(join(FIXTURES, 'dynamic/project'))
    staticFramework(input, 'Alpha', true)
    staticFramework(input, 'Beta', false)
    assert.throws(() => generate(input), (error) => error.name === 'PodError' && error.message === 'targets["App"]: has transitive dependencies that include statically linked binaries: Alpha')
    // And one that is not built itself, but is static all the same.
    const headers = await load(join(FIXTURES, 'dynamic/project'))
    staticFramework(headers, 'Delta', true)
    assert.throws(() => generate(headers), /has transitive dependencies that include statically linked binaries: Delta/u)
    // A static one on a dynamic one is as the fixture has it; and with no dynamic framework, nothing is refused.
    const frameworks = await load(join(FIXTURES, 'frameworks/project'))
    staticFramework(frameworks, 'Delta', true)
    assert.ok(generate(frameworks).files.has('Pods.xcodeproj/project.pbxproj'))
  })
})
