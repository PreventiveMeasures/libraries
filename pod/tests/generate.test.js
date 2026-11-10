import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
      assert.equal(new Set(links.map(([path]) => path)).size, links.length, 'a path is linked once')
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
    assert.deepEqual(Object.keys(settings), ['Alpha', 'Alpha-Alpha_privacy', 'Beta', 'Delta', 'Gamma', 'Local', 'Local-LocalFiles', 'Local-LocalStrings', 'Pods-defaults-App', 'Pods-defaults-Ext'])
    for (const [name, configurations] of Object.entries(settings)) {
      for (const one of configurations) {
        assert.equal(one.CODE_SIGNING_ALLOWED, 'NO', name)
        assert.deepEqual(one.HEADER_SEARCH_PATHS, name === 'Alpha' ? ['$(inherited)', '$(SRCROOT)/..'] : undefined, name)
      }
    }
  })
})

describe('generate, with the app\'s project in another directory than the Podfile\'s', () => {
  it('gives the app its paths from its project\'s directory, as CocoaPods does, and nothing else is other', async () => {
    // `project '../App/App.xcodeproj'`: `pod install` 1.16.2 writes the same Pods/ but for these two paths.
    const root = mkdtempSync(join(tmpdir(), 'pod-generate-test-'))
    try {
      cpSync(join(FIXTURES, 'frameworks/project'), join(root, 'ios'), { recursive: true })
      mkdirSync(join(root, 'App'))
      renameSync(join(root, 'ios/App.xcodeproj'), join(root, 'App/App.xcodeproj'))
      const config = JSON.parse(readFileSync(join(root, 'ios/pod.config.json'), 'utf8'))
      writeFileSync(join(root, 'ios/pod.config.json'), JSON.stringify({ ...config, project: '../App/App.xcodeproj' }))
      const { files } = generate(await load(join(root, 'ios')))
      const expected = join(FIXTURES, 'frameworks/expected')
      const moved = (text) => text.replace('PODS_PODFILE_DIR_PATH = ${SRCROOT}/.', 'PODS_PODFILE_DIR_PATH = ${SRCROOT}/../ios').replace('PODS_ROOT = ${SRCROOT}/Pods', 'PODS_ROOT = ${SRCROOT}/../ios/Pods')
      const written = [...files.keys()].filter((path) => !path.startsWith('Pods.xcodeproj/'))
      for (const path of written) assert.equal(Buffer.from(files.get(path)).toString('utf8'), moved(readFileSync(join(expected, path), 'utf8')), path)
      assert.equal(written.filter((path) => Buffer.from(files.get(path)).toString('utf8').includes('${SRCROOT}/../ios/Pods')).length, 4)
      assert.deepEqual(treeOf(files.get('Pods.xcodeproj/project.pbxproj')), treeOf(readFileSync(join(expected, 'Pods.xcodeproj/project.pbxproj'), 'utf8')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('generate, of a header that more than one comes to the path of', () => {
  it('links the path once, to the last of them, as CocoaPods\' `ln -sf` of each in turn leaves it', async () => {
    // One header in two subspecs, and another of its name in the second: `pod install` 1.16.2 links the last.
    const input = await load(join(FIXTURES, 'libraries/project'))
    const [dyn, stat] = input.pods.find((pod) => pod.name === 'Binary').root.subspecs
    dyn.attributes.source_files = ['Stat.xcframework/ios-arm64/Headers/*.h']
    stat.attributes.source_files = ['Stat.xcframework/ios-arm64/Headers/*.h', 'Stat.xcframework/ios-arm64_x86_64-simulator/Headers/*.h']
    const { links } = generate(input)
    assert.equal(new Set(links.map(([path]) => path)).size, links.length)
    assert.deepEqual(links.filter(([path]) => path.includes('/Binary/')), [
      ['Headers/Private/Binary/Stat.h', '../../../Binary/Stat.xcframework/ios-arm64_x86_64-simulator/Headers/Stat.h'],
      ['Headers/Public/Binary/Stat.h', '../../../Binary/Stat.xcframework/ios-arm64_x86_64-simulator/Headers/Stat.h'],
    ])
  })
})

describe('generate, of a library\'s module map', () => {
  const linked = (links, name) => links.map(([path]) => path).filter((path) => path.endsWith(`/${name}.modulemap`) || path.endsWith(`/${name}-umbrella.h`))
  const textOf = (files, path) => Buffer.from(files.get(path)).toString('utf8')

  it('links a module map and an umbrella header where they are written, and not where they are not', async () => {
    // As `pod install` 1.16.2 leaves Pods/Headers in each of the three.
    const input = await load(join(FIXTURES, 'libraries/project'))
    assert.deepEqual(linked(generate(input).links, 'Core'), ['Headers/Public/core/Core.modulemap', 'Headers/Public/core/Core-umbrella.h'])
    // A spec that says no module map is written has none, nor an umbrella header, and no link to either. Those
    // that import the pod are given the path of one all the same, as CocoaPods gives it.
    input.pods.find((pod) => pod.name === 'Core').root.attributes.module_map = false
    const none = generate(input)
    assert.deepEqual(linked(none.links, 'Core'), [])
    assert.deepEqual([...none.files.keys()].filter((path) => /Core(?:\.modulemap|-umbrella\.h)$/u.test(path)), [])
    assert.ok(textOf(none.files, 'Target Support Files/Pods-App/Pods-App.debug.xcconfig').includes('-fmodule-map-file="${PODS_ROOT}/Headers/Public/core/Core.modulemap"'))
    // A module map of the pod's own is linked, and no umbrella header is written with it.
    input.config.pods.Mapped = { ...input.config.pods.Mapped, modularHeaders: true }
    const own = generate(input)
    assert.deepEqual(linked(own.links, 'Mapped'), ['Headers/Private/Mapped/Mapped.modulemap'])
    assert.equal(own.files.has('Target Support Files/Mapped/Mapped-umbrella.h'), false)
  })
})

describe('generate, of the compiled resources of a pod with nothing to build', () => {
  // The app's project as CocoaPods integrates it for these pods: each target with the phase that copies them.
  const resourcesOf = async (fixture) => {
    const input = await load(join(FIXTURES, fixture, 'project'))
    input.pods.find((pod) => pod.name === 'Local').root.attributes.source_files = 'src/*.h'
    for (const target of input.user.targets) target.scripts = [...new Set([...target.scripts, `${target.label}/${target.label}-resources.sh`])]
    const text = Buffer.from(generate(input).files.get('Target Support Files/Pods-defaults-App/Pods-defaults-App-resources.sh')).toString('utf8')
    return [...new Set(text.split('\n').filter((line) => line.includes('Main.storyboard')).map((line) => line.trim()))]
  }

  it('names them in the framework where the pod is a static one, and where they are where it is a dynamic one', async () => {
    // CocoaPods asks how the pod is built, and not whether: `pod install` 1.16.2 writes these two.
    assert.deepEqual(await resourcesOf('frameworks'), ['install_resource "${BUILT_PRODUCTS_DIR}/Local/Local.framework/Base.lproj/Main.storyboardc"'])
    assert.deepEqual(await resourcesOf('dynamic'), ['install_resource "${PODS_ROOT}/../local/Local/ui/Base.lproj/Main.storyboard"'])
  })
})

describe('generate, with what is said of one pod over what is said of all', () => {
  it('takes a pod out of modular headers and of inhibited warnings where it says false, as CocoaPods does', async () => {
    // `use_modular_headers!` and `inhibit_all_warnings!` with `:modular_headers => false` and
    // `:inhibit_warnings => false` on a pod each: `pod install` 1.16.2 writes these.
    const input = await load(join(FIXTURES, 'libraries/project'))
    Object.assign(input.config, { modularHeaders: true, inhibitWarnings: true })
    Object.assign(input.config.pods, { Scripted: { modularHeaders: false }, Mapped: { inhibitWarnings: false } })
    const { files, podTargets } = generate(input)
    const said = Object.fromEntries(podTargets.map((target) => [target.name, [target.definesModule, target.inhibitWarnings]]))
    assert.deepEqual([said.Scripted, said.Mapped, said.Local], [[false, true], [true, false], [true, true]])
    assert.equal(files.has('Target Support Files/Scripted/Scripted.modulemap'), false)
    assert.equal(files.has('Target Support Files/Local/Local.modulemap'), true)
    const flags = Buffer.from(files.get('Target Support Files/Pods-App/Pods-App.debug.xcconfig')).toString('utf8')
    assert.equal(flags.includes('Scripted.modulemap'), false)
    assert.equal(flags.includes('-fmodule-map-file="${PODS_ROOT}/Headers/Public/Local/Local.modulemap"'), true)
  })
})

describe('generate, for a project that has no phase for what is written now', () => {
  it('refuses, as nothing would copy the resources or embed the frameworks, which CocoaPods adds a phase for', async () => {
    // Local with nothing to build under dynamic frameworks has resources for the app to copy, and the app's
    // project has only the phase that embeds frameworks: `pod install` puts the other in, and nothing here does.
    const input = await load(join(FIXTURES, 'dynamic/project'))
    input.pods.find((pod) => pod.name === 'Local').root.attributes.source_files = 'src/*.h'
    assert.throws(() => generate(input), (error) => error.name === 'PodError' && error.message === 'targets["App"]: its pods have resources to copy, and no phase of it in the app\'s project runs Pods-defaults-App-resources.sh, which does it: the project is integrated for other pods than the lockfile has, and has to be integrated again')
    // An extension embeds no frameworks and a static library copies no resources: neither has such a phase.
    const hosted = await load(join(FIXTURES, 'libraries/project'))
    const ext = hosted.user.targets.find((target) => target.name === 'Ext')
    Object.assign(ext, { productType: 'static_library', scripts: [] })
    assert.ok(generate(hosted).files.has('Target Support Files/Pods-Ext/Pods-Ext-resources.sh'))
    Object.assign(ext, { productType: 'app_extension' })
    assert.throws(() => generate(hosted), /^PodError: targets\["Ext"\]: its pods have resources to copy, and no phase of it in the app's project runs Pods-Ext-resources\.sh/u)
    const app = hosted.user.targets.find((target) => target.name === 'App')
    Object.assign(ext, { scripts: ['Pods-Ext/Pods-Ext-resources.sh'] })
    app.scripts = app.scripts.filter((path) => !path.endsWith('-frameworks.sh'))
    assert.throws(() => generate(hosted), /^PodError: targets\["App"\]: its pods have frameworks to embed, and no phase of it in the app's project runs Pods-App-frameworks\.sh/u)
  })
})

describe('generate, for a project whose phases run what is written no more', () => {
  it('refuses, as the project is not changed and its phase would run a script that is not there', async () => {
    // Ext takes Core, which has a resource, and its target in the app's project runs Pods-Ext-resources.sh.
    // With a pod that has none instead, CocoaPods writes no such script and takes the phase out of the project.
    const input = await load(join(FIXTURES, 'libraries/project'))
    assert.deepEqual(input.user.targets.map((target) => [target.name, target.scripts]), [
      ['App', ['Pods-App/Pods-App-frameworks.sh', 'Pods-App/Pods-App-resources.sh']],
      ['Ext', ['Pods-Ext/Pods-Ext-resources.sh']],
    ])
    input.config.targets.Ext = { pods: ['Overlap'] }
    assert.throws(() => generate(input), (error) => error.name === 'PodError' && error.message.startsWith('targets["Ext"]: a phase of it in the app\'s project runs Pods-Ext-resources.sh, which its pods have no more use for and is not written'))
  })
})

describe('generate, of the pods of a target that is embedded in another', () => {
  const podsOf = (aggregates) => Object.fromEntries(aggregates.map((aggregate) => [aggregate.userTarget.name, aggregate.podTargets.map((target) => target.name)]))
  const textOf = (files, path) => Buffer.from(files.get(`Target Support Files/${path}`)).toString('utf8')

  it('gives the app an extension\'s dynamic frameworks that it does not take itself, as CocoaPods does', async () => {
    // App takes Alpha and Delta; Ext, which it hosts, Beta, Delta and Gamma. `pod install` 1.16.2 has Gamma, a
    // dynamic framework, in the app's target too, which embeds it; and not Beta, which is a static one.
    const input = await load(join(FIXTURES, 'dynamic/project'))
    input.config.targets = { App: { pods: ['Alpha', 'Delta'] }, Ext: { pods: ['Beta', 'Delta', 'Gamma'] } }
    const { files, aggregates } = generate(input)
    assert.deepEqual(podsOf(aggregates), { App: ['Alpha', 'Delta', 'Gamma'], Ext: ['Alpha', 'Beta', 'Delta', 'Gamma'] })
    const embeds = textOf(files, 'Pods-defaults-App/Pods-defaults-App-frameworks.sh').split('\n').filter((line) => line.includes('install_framework "')).map((line) => line.trim())
    assert.deepEqual([...new Set(embeds)], ['install_framework "${BUILT_PRODUCTS_DIR}/Alpha/alpha.framework"', 'install_framework "${BUILT_PRODUCTS_DIR}/Gamma/Gamma.framework"'])
    assert.ok(textOf(files, 'Pods-defaults-App/Pods-defaults-App.debug.xcconfig').includes('OTHER_LDFLAGS = $(inherited) -l"c++" -framework "CoreGraphics" -framework "Gamma" -framework "UIKit" -framework "alpha"\n'))
    const app = treeOf(files.get('Pods.xcodeproj/project.pbxproj')).root.targets.find((target) => target.name === 'Pods-defaults-App')
    assert.deepEqual(app.dependencies.map((dependency) => dependency.name), ['Alpha', 'Delta', 'Gamma'])
  })

  it('gives the app the pods of a static library it hosts, which it links; and writes no lists for a phase the library has not', async () => {
    // Without frameworks an extension's pods stay its own, and a static library's are its host's too.
    const input = await load(join(FIXTURES, 'libraries/project'))
    input.config.targets = { App: { pods: ['Core', 'Binary'] }, Ext: { pods: ['Mapped'] } }
    assert.deepEqual(podsOf(generate(input).aggregates), { App: ['Binary', 'Core'], Ext: ['HeaderOnly', 'Mapped'] })
    input.user.targets.find((target) => target.name === 'Ext').productType = 'static_library'
    const { files, aggregates } = generate(input)
    assert.deepEqual(podsOf(aggregates), { App: ['Binary', 'Core', 'HeaderOnly', 'Mapped'], Ext: ['HeaderOnly', 'Mapped'] })
    assert.ok(textOf(files, 'Pods-App/Pods-App.debug.xcconfig').includes(' -l"Mapped" '))
    assert.deepEqual([...files.keys()].filter((path) => path.includes('/Pods-Ext/Pods-Ext-resources')), ['Target Support Files/Pods-Ext/Pods-Ext-resources.sh'])
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

describe('generate, of resource bundles', () => {
  const targetsOf = (input) => treeOf(generate(input).files.get('Pods.xcodeproj/project.pbxproj')).root.targets.map((target) => target.name)

  it('refuses a bundle of one name in two specs of a pod, which CocoaPods makes two targets of one id for', async () => {
    // `pod install` 1.16.2 writes the project all the same, with "Generated duplicate UUIDs" and one target lost.
    const input = await load(join(FIXTURES, 'frameworks/project'))
    const gamma = input.pods.find((pod) => pod.name === 'Gamma').root
    for (const spec of gamma.subspecs) spec.attributes.resource_bundles = { Shared: ['LICENSE'] }
    assert.throws(() => generate(input), (error) => error.name === 'PodError' && error.message === 'pods["Gamma"]: the resource bundle "Shared" is of more than one of its specs, Gamma/Core and Gamma/Extra, which CocoaPods writes no sound project for: two targets of one id')
    // In one spec alone it is a target, and one of the same name in another pod is another.
    delete gamma.subspecs[1].attributes.resource_bundles
    input.pods.find((pod) => pod.name === 'Delta').root.attributes.resource_bundles = { Shared: ['include/**/*.h'] }
    assert.deepEqual(targetsOf(input).filter((name) => name.endsWith('-Shared')), ['Delta-Shared', 'Gamma-Shared'])
  })
})
