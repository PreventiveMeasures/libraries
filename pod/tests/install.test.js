import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { install } from '../src/install.js'

const FIXTURE = new URL('fixtures/frameworks/', import.meta.url).pathname
const LIBRARIES = new URL('fixtures/libraries/', import.meta.url).pathname
const ARCHIVE = 'https://github.com/acme/gamma/archive/refs/tags/3.0.0.tar.gz'
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))

const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// The fixture's project in a directory of its own, Gamma not yet downloaded: its archive, as GitHub would
// serve it, holds what CocoaPods left of it in Pods/ and a file it cleans away; the podspec is held to that
// archive's hash, and the lockfile to that podspec. `change` edits the podspec first.
async function project(change = (spec) => spec, config = {}, vendored = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pod-install-test-'))
  dirs.push(dir)
  cpSync(join(FIXTURE, 'project'), dir, { recursive: true })
  const gamma = join(dir, 'Pods/Gamma')
  const entries = [...walk(gamma).map((path) => ({ name: `gamma-3.0.0/${path}`, data: readFileSync(join(gamma, path)) })), { name: 'gamma-3.0.0/unused.txt', data: Buffer.from('unused\n') }]
  if (!vendored) rmSync(join(dir, 'Pods'), { recursive: true })
  const archive = await compress(pack(entries), 'gzip')
  const path = join(dir, 'Podspecs/Gamma.podspec.json')
  const before = readFileSync(path)
  const spec = change(JSON.parse(before))
  if (spec.source.http !== undefined) spec.source.sha256 = sha('sha256', archive)
  const podspec = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`)
  writeFileSync(path, podspec)
  writeFileSync(join(dir, 'Podfile.lock'), readFileSync(join(dir, 'Podfile.lock'), 'utf8').replace(sha('sha1', before), sha('sha1', podspec)))
  // Vendored: Pods/Gamma is there, with CocoaPods' record of having installed it as the lockfile has it.
  if (vendored) cpSync(join(dir, 'Podfile.lock'), join(dir, 'Pods/Manifest.lock'))
  writeFileSync(join(dir, 'pod.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'pod.config.json'), 'utf8')), ...config }))
  const asked = []
  globalThis.fetch = (input) => {
    asked.push(String(input))
    return Promise.resolve(String(input) === ARCHIVE ? new Response(archive) : new Response('Not Found', { status: 404 }))
  }
  return { dir, asked, podspec }
}

describe('install', () => {
  it('downloads a pod by its archive, cleans it, and generates Pods/ as CocoaPods does', async () => {
    const { dir, asked, podspec } = await project()
    const result = await install(dir)
    assert.deepEqual(result, { pods: ['Alpha', 'Beta', 'Delta', 'Gamma', 'Local'], targets: ['Pods-defaults-App', 'Pods-defaults-Ext'], downloaded: ['Gamma'], written: 58 })
    assert.deepEqual(asked, [ARCHIVE])
    assert.deepEqual(walk(join(dir, 'Pods/Gamma')).sort(), walk(join(FIXTURE, 'project/Pods/Gamma')).sort())
    assert.equal(statSync(join(dir, 'Pods/Gamma/Gamma/Core/GammaCore.m')).mode & 0o777, 0o444, 'a source file is locked')
    const expected = join(FIXTURE, 'expected')
    for (const path of walk(expected).filter((one) => one !== 'links.json' && !one.startsWith('Pods.xcodeproj/') && !/Gamma\.podspec\.json|Manifest\.lock/u.test(one))) {
      assert.equal(readFileSync(join(dir, 'Pods', path), 'utf8'), readFileSync(join(expected, path), 'utf8'), path)
    }
    assert.deepEqual(readFileSync(join(dir, 'Pods/Local Podspecs/Gamma.podspec.json')), podspec)
    assert.deepEqual(readFileSync(join(dir, 'Pods/Manifest.lock')), readFileSync(join(dir, 'Podfile.lock')))
    for (const [path, target] of Object.entries(JSON.parse(readFileSync(join(expected, 'links.json'), 'utf8')))) assert.equal(readlinkSync(join(dir, 'Pods', path)), target)
    assert.equal(statSync(join(dir, 'Pods/Target Support Files/Pods-defaults-App/Pods-defaults-App-resources.sh')).mode & 0o777, 0o755)
    assert.ok(existsSync(join(dir, 'Pods/Pods.xcodeproj/project.pbxproj')))
  })

  it('downloads nothing, and writes nothing, where Pods/ is as the lockfile has it', async () => {
    const { dir, asked } = await project()
    await install(dir)
    writeFileSync(join(dir, 'Pods/Target Support Files/Alpha/stale.txt'), 'stale')
    const again = await install(dir)
    assert.deepEqual([again.downloaded, again.written, asked], [[], 0, [ARCHIVE]])
    assert.equal(existsSync(join(dir, 'Pods/Target Support Files/Alpha/stale.txt')), false)
  })

  it('refuses a podspec that is not the one the lockfile has the checksum of', async () => {
    const { dir } = await project()
    writeFileSync(join(dir, 'Podspecs/Alpha.podspec.json'), readFileSync(join(dir, 'Podspecs/Alpha.podspec.json'), 'utf8').replace('"summary": "Alpha"', '"summary": "Changed"'))
    await assert.rejects(install(dir), /pods\["Alpha"\]: its podspec, "Podspecs\/Alpha\.podspec\.json", has sha1 [0-9a-f]{40}, not the lockfile's [0-9a-f]{40}$/u)
  })

  it('reads a podspec where the lockfile has the pod from, as JSON or in the form read without Ruby', async () => {
    const { dir } = await project()
    // Alpha's podspec as its author would write it, beside the pod: it comes to the JSON the lockfile is of.
    const json = JSON.parse(readFileSync(join(dir, 'Podspecs/Alpha.podspec.json'), 'utf8'))
    const ruby = `Pod::Spec.new do |s|
  s.name = 'Alpha'
  s.version = '1.0.0'
  s.summary = 'Alpha'
  s.homepage = 'https://example.com/alpha'
  s.license = 'MIT'
  s.author = 'Fixture'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => 'https://example.com/alpha.git', :tag => "v#{s.version}" }
  s.source_files = 'src/**/*.{h,mm,cpp}'
  s.private_header_files = 'src/Alpha+Private.h'
  s.header_dir = 'alpha'
  s.header_mappings_dir = 'src'
  s.compiler_flags = '-DALPHA=1 -Wno-comma'
  s.frameworks = 'UIKit', 'CoreGraphics'
  s.library = 'c++'
  s.resource_bundles = { 'Alpha_privacy' => ['res/PrivacyInfo.xcprivacy'] }
  s.pod_target_xcconfig = ${JSON.stringify(json.pod_target_xcconfig).replaceAll('":', '" =>')}
  s.dependency 'Delta'
end
`
    rmSync(join(dir, 'Podspecs/Alpha.podspec.json'))
    rmSync(join(dir, 'local/Alpha/Alpha.podspec.json'))
    writeFileSync(join(dir, 'local/Alpha/Alpha.podspec'), ruby)
    await install(dir)
    assert.equal(readFileSync(join(dir, 'Pods/Local Podspecs/Alpha.podspec.json'), 'utf8'), readFileSync(join(FIXTURE, 'expected/Local Podspecs/Alpha.podspec.json'), 'utf8'))
    // Beta's as JSON beside the pod, as its package ships it and not as CocoaPods writes it.
    rmSync(join(dir, 'Podspecs/Beta.podspec.json'))
    const shipped = JSON.stringify(JSON.parse(readFileSync(join(dir, 'local/Beta/Beta.podspec.json'), 'utf8')))
    writeFileSync(join(dir, 'local/Beta/Beta.podspec.json'), shipped)
    await install(dir)
    assert.equal(readFileSync(join(dir, 'Pods/Local Podspecs/Beta.podspec.json'), 'utf8'), readFileSync(join(FIXTURE, 'expected/Local Podspecs/Beta.podspec.json'), 'utf8'))
    // One read by the environment: it is the lockfile's only in the environment pod.config.json gives it.
    const config = JSON.parse(readFileSync(join(dir, 'pod.config.json'), 'utf8'))
    writeFileSync(join(dir, 'local/Alpha/Alpha.podspec'), ruby.replace("s.license = 'MIT'", "s.license = 'MIT' if ENV['ALPHA_LICENSED'] == '1'"))
    await assert.rejects(install(dir), /pods\["Alpha"\]: its podspec, "local\/Alpha\/Alpha\.podspec", has sha1 [0-9a-f]{40}, not the lockfile's [0-9a-f]{40}, as read with ALPHA_LICENSED not set$/u)
    writeFileSync(join(dir, 'pod.config.json'), JSON.stringify({ ...config, env: { ALPHA_LICENSED: '1' } }))
    assert.equal((await install(dir)).written, 0)
    writeFileSync(join(dir, 'pod.config.json'), JSON.stringify({ ...config, env: { ALPHA_LICENSED: 1 } }))
    await assert.rejects(install(dir), /pod\.config\.json: env must be an object of variables of the environment, each a string, or null for one that is not set/u)
    writeFileSync(join(dir, 'pod.config.json'), JSON.stringify(config))
    // And by a global the Podfile set: it is the lockfile's only with what pod.config.json gives of it.
    writeFileSync(join(dir, 'local/Alpha/Alpha.podspec'), ruby.replace("s.license = 'MIT'", "s.license = $AlphaLicense if defined?($AlphaLicense)"))
    await assert.rejects(install(dir), /not the lockfile's [0-9a-f]{40}, as read with \$AlphaLicense not set$/u)
    writeFileSync(join(dir, 'pod.config.json'), JSON.stringify({ ...config, globals: { AlphaLicense: 'MIT' } }))
    assert.equal((await install(dir)).written, 0)
    writeFileSync(join(dir, 'pod.config.json'), JSON.stringify({ ...config, globals: { $AlphaLicense: 'MIT' } }))
    await assert.rejects(install(dir), /pod\.config\.json: globals must be an object of globals by name, without the `\$`/u)
    writeFileSync(join(dir, 'pod.config.json'), JSON.stringify(config))
    // One that is not in the form read, and one that comes to another podspec than the lockfile's.
    writeFileSync(join(dir, 'local/Alpha/Alpha.podspec'), ruby.replace("s.license = 'MIT'", "s.license = %x(cat LICENSE)"))
    await assert.rejects(install(dir), /pods\["Alpha"\]: local\/Alpha\/Alpha\.podspec: line 6: `%x\(cat`, which is not read without Ruby/u)
    writeFileSync(join(dir, 'local/Alpha/Alpha.podspec'), ruby.replace("'c++'", "'z'"))
    await assert.rejects(install(dir), /pods\["Alpha"\]: its podspec, "local\/Alpha\/Alpha\.podspec", has sha1/u)
    rmSync(join(dir, 'local/Alpha/Alpha.podspec'))
    await assert.rejects(install(dir), /pods\["Alpha"\]: its podspec is not at ".*Podspecs\/Alpha\.podspec\.json" or .*local\/Alpha\/Alpha\.podspec\.json"/u)
  })

  it('refuses an archive that is not the one its podspec has the hash of', async () => {
    const { dir } = await project()
    const served = globalThis.fetch
    globalThis.fetch = async (input) => new Response(Buffer.concat([Buffer.from(await (await served(input)).arrayBuffer()), Buffer.from([0])]))
    await assert.rejects(install(dir), /integrity|sha256/iu)
    assert.equal(existsSync(join(dir, 'Pods/Gamma')), false)
  })

  const tagged = (spec) => ({ ...spec, source: { git: 'https://github.com/acme/gamma.git', tag: '3.0.0' } })

  it('refuses a source that is held to no hash, of a pod it has to download', async () => {
    const { dir, asked } = await project(tagged)
    await assert.rejects(install(dir), /pods\["Gamma"\]: a :git source is not supported/u)
    assert.deepEqual(asked, [])
  })

  it('takes a pod that is not downloaded as it is, whatever source its podspec names', async () => {
    // Local pods, by :path: Alpha's podspec names a git tag, and nothing of it is fetched.
    const local = await project()
    assert.deepEqual(JSON.parse(readFileSync(join(local.dir, 'Podspecs/Alpha.podspec.json'), 'utf8')).source, { git: 'https://example.com/alpha.git', tag: 'v1.0.0' })
    await install(local.dir)
    assert.deepEqual(local.asked, [ARCHIVE])
    // A pod vendored in Pods/, as its Manifest.lock records it: by a git tag too, and not fetched.
    const { dir, asked } = await project(tagged, {}, true)
    const result = await install(dir)
    assert.deepEqual([result.downloaded, asked], [[], []])
    assert.ok(existsSync(join(dir, 'Pods/Target Support Files/Gamma/Gamma.debug.xcconfig')))
    // Once it is not there, or not as the lockfile has it, it has to be downloaded, and is refused.
    writeFileSync(join(dir, 'Pods/Manifest.lock'), readFileSync(join(dir, 'Podfile.lock'), 'utf8').replace(/Gamma: [\da-f]{40}/u, `Gamma: ${'0'.repeat(40)}`))
    await assert.rejects(install(dir), /pods\["Gamma"\]: a :git source is not supported/u)
    rmSync(join(dir, 'Pods/Gamma'), { recursive: true })
    cpSync(join(dir, 'Podfile.lock'), join(dir, 'Pods/Manifest.lock'))
    await assert.rejects(install(dir), /pods\["Gamma"\]: a :git source is not supported/u)
  })

  it('asks nothing of a pod Pods/ has already, where another has to be downloaded', async () => {
    const { dir, asked } = await project()
    // Epsilon, from trunk, is in Pods/ as its Manifest.lock records it, by a git tag; Gamma is not there.
    const podspec = `${JSON.stringify({ name: 'Epsilon', version: '1.0.0', summary: 'Epsilon', homepage: 'https://example.com/epsilon', license: 'MIT', authors: 'Fixture', platforms: { ios: '15.1' }, source: { git: 'https://example.com/epsilon.git', tag: '1.0.0' }, source_files: '*.h' }, null, 2)}\n`
    const lock = readFileSync(join(dir, 'Podfile.lock'), 'utf8')
      .replace('  - Delta (0.3.0)\n', '  - Delta (0.3.0)\n  - Epsilon (1.0.0)\n')
      .replace('  - Delta (from `local/Delta`)\n', '  - Delta (from `local/Delta`)\n  - Epsilon\n')
      .replace('EXTERNAL SOURCES:\n', 'SPEC REPOS:\n  trunk:\n    - Epsilon\n\nEXTERNAL SOURCES:\n')
      .replace(/(  Delta: [\da-f]{40}\n)/u, `$1  Epsilon: ${sha('sha1', podspec)}\n`)
    writeFileSync(join(dir, 'Podfile.lock'), lock)
    writeFileSync(join(dir, 'Podspecs/Epsilon.podspec.json'), podspec)
    mkdirSync(join(dir, 'Pods/Epsilon'), { recursive: true })
    writeFileSync(join(dir, 'Pods/Epsilon/Epsilon.h'), '')
    writeFileSync(join(dir, 'Pods/Manifest.lock'), lock)
    const result = await install(dir)
    assert.deepEqual([result.pods, result.downloaded, asked], [['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma', 'Local'], ['Gamma'], [ARCHIVE]])
    assert.ok(existsSync(join(dir, 'Pods/Gamma/Gamma/Core/GammaCore.m')))
  })

  it('refuses a pod by :path whose podspec has a prepare_command, named in prepareCommands or not, and runs nothing', async () => {
    // `pod install` 1.16.2 runs it for a :path pod too, in the pod's own directory, at each installation. Here
    // such a pod is a mistake of the project's: it is used where it is, and no script is run in it.
    const withCommand = async (config) => {
      const { dir } = await project((spec) => spec, config, true)
      const path = join(dir, 'Podspecs/Delta.podspec.json')
      const before = readFileSync(path)
      const podspec = Buffer.from(`${JSON.stringify({ ...JSON.parse(before), prepare_command: 'echo ran > prepared.txt' }, null, 2)}\n`)
      writeFileSync(path, podspec)
      for (const lock of ['Podfile.lock', 'Pods/Manifest.lock']) writeFileSync(join(dir, lock), readFileSync(join(dir, lock), 'utf8').replace(sha('sha1', before), sha('sha1', podspec)))
      return dir
    }
    for (const config of [{}, { prepareCommands: ['Delta'] }]) {
      const dir = await withCommand(config)
      await assert.rejects(install(dir), (error) => error.name === 'PodError' && error.message === 'pods["Delta"]: a :path pod\'s prepare_command is not run: run it, and take it out of the podspec')
      assert.equal(existsSync(join(dir, 'local/Delta/prepared.txt')), false)
    }
  })

  it('links a header that two subspecs both have once, where linking it again would fail', async () => {
    // The libraries fixture, its pods in Pods/ as the lockfile has them: Overlap's subspecs share a header.
    const dir = mkdtempSync(join(tmpdir(), 'pod-install-test-'))
    dirs.push(dir)
    cpSync(join(LIBRARIES, 'project'), dir, { recursive: true })
    cpSync(join(dir, 'Podfile.lock'), join(dir, 'Pods/Manifest.lock'))
    globalThis.fetch = (input) => assert.fail(`${String(input)} was fetched`)
    assert.deepEqual((await install(dir)).downloaded, [])
    const links = JSON.parse(readFileSync(join(LIBRARIES, 'expected/links.json'), 'utf8'))
    for (const [path, target] of Object.entries(links)) assert.equal(readlinkSync(join(dir, 'Pods', path)), target, path)
    assert.equal(links['Headers/Private/Overlap/Same.h'], '../../../../local/Overlap/h/x/Same.h')
    assert.deepEqual(walk(join(dir, 'Pods/Headers')).sort(), Object.keys(links).map((path) => path.slice('Headers/'.length)).sort())
  })

  it('runs a prepare_command only for a pod that pod.config.json names, before the pod is cleaned', async () => {
    const prepared = (spec) => ({ ...spec, prepare_command: '  touch prepared.txt\n  echo "int prepared(void);" > Gamma/Core/Prepared.h\n' })
    const refused = await project(prepared)
    await assert.rejects(install(refused.dir), /pods\["Gamma"\]: its prepare_command runs only if `prepareCommands` in pod\.config\.json names the pod/u)
    const { dir } = await project(prepared, { prepareCommands: ['Gamma'] })
    await install(dir)
    assert.equal(readFileSync(join(dir, 'Pods/Gamma/Gamma/Core/Prepared.h'), 'utf8'), 'int prepared(void);\n')
    assert.equal(existsSync(join(dir, 'Pods/Gamma/prepared.txt')), false, 'what no spec uses is cleaned away')
    assert.match(readFileSync(join(dir, 'Pods/Pods.xcodeproj/project.pbxproj'), 'utf8'), /Prepared\.h in Headers/u)
    const failing = await project((spec) => ({ ...spec, prepare_command: 'echo before >&2; false; echo after >&2' }), { prepareCommands: ['Gamma'] })
    await assert.rejects(install(failing.dir), /pods\["Gamma"\]: its prepare_command failed \(1\):\nbefore$/u)
  })
})
