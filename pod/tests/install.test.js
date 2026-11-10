import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { install } from '../src/install.js'

const FIXTURE = new URL('fixtures/frameworks/', import.meta.url).pathname
const ARCHIVE = 'https://github.com/acme/gamma/archive/refs/tags/3.0.0.tar.gz'
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
// install() fetches no git source here; a client that is asked of anything fails the test.
const GITHUB = Object.fromEntries(['getRepo', 'compareCommits', 'getCommitTree', 'getRepoTreeTarball'].map((name) => [name, () => assert.fail(`${name} was called`)]))

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
    const result = await install(dir, GITHUB)
    assert.deepEqual(result, { pods: ['Alpha', 'Beta', 'Delta', 'Gamma'], targets: ['Pods-defaults-App', 'Pods-defaults-Ext'], downloaded: ['Gamma'], written: 48 })
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
    await install(dir, GITHUB)
    writeFileSync(join(dir, 'Pods/Target Support Files/Alpha/stale.txt'), 'stale')
    const again = await install(dir, GITHUB)
    assert.deepEqual([again.downloaded, again.written, asked], [[], 0, [ARCHIVE]])
    assert.equal(existsSync(join(dir, 'Pods/Target Support Files/Alpha/stale.txt')), false)
  })

  it('refuses a podspec that is not the one the lockfile has the checksum of', async () => {
    const { dir } = await project()
    writeFileSync(join(dir, 'Podspecs/Alpha.podspec.json'), readFileSync(join(dir, 'Podspecs/Alpha.podspec.json'), 'utf8').replace('"Alpha"', '"Alpha" '))
    await assert.rejects(install(dir, GITHUB), /pods\["Alpha"\]: its podspec is not the one the lockfile has the checksum of/u)
  })

  it('refuses an archive that is not the one its podspec has the hash of', async () => {
    const { dir } = await project()
    const served = globalThis.fetch
    globalThis.fetch = async (input) => new Response(Buffer.concat([Buffer.from(await (await served(input)).arrayBuffer()), Buffer.from([0])]))
    await assert.rejects(install(dir, GITHUB), /integrity|sha256/iu)
    assert.equal(existsSync(join(dir, 'Pods/Gamma')), false)
  })

  const tagged = (spec) => ({ ...spec, source: { git: 'https://github.com/acme/gamma.git', tag: '3.0.0' } })

  it('refuses a source that is held to no hash, of a pod it has to download', async () => {
    const { dir, asked } = await project(tagged)
    await assert.rejects(install(dir, GITHUB), /pods\["Gamma"\]: a git source by a tag/u)
    assert.deepEqual(asked, [])
  })

  it('takes a pod that is not downloaded as it is, whatever source its podspec names', async () => {
    // Local pods, by :path: Alpha's podspec names a git tag, and nothing of it is fetched.
    const local = await project()
    assert.deepEqual(JSON.parse(readFileSync(join(local.dir, 'Podspecs/Alpha.podspec.json'), 'utf8')).source, { git: 'https://example.com/alpha.git', tag: 'v1.0.0' })
    await install(local.dir, GITHUB)
    assert.deepEqual(local.asked, [ARCHIVE])
    // A pod vendored in Pods/, as its Manifest.lock records it: by a git tag too, and not fetched.
    const { dir, asked } = await project(tagged, {}, true)
    const result = await install(dir, GITHUB)
    assert.deepEqual([result.downloaded, asked], [[], []])
    assert.ok(existsSync(join(dir, 'Pods/Target Support Files/Gamma/Gamma.debug.xcconfig')))
    // Once it is not there, or not as the lockfile has it, it has to be downloaded, and is refused.
    writeFileSync(join(dir, 'Pods/Manifest.lock'), readFileSync(join(dir, 'Podfile.lock'), 'utf8').replace(/Gamma: [\da-f]{40}/u, `Gamma: ${'0'.repeat(40)}`))
    await assert.rejects(install(dir, GITHUB), /pods\["Gamma"\]: a git source by a tag/u)
    rmSync(join(dir, 'Pods/Gamma'), { recursive: true })
    cpSync(join(dir, 'Podfile.lock'), join(dir, 'Pods/Manifest.lock'))
    await assert.rejects(install(dir, GITHUB), /pods\["Gamma"\]: a git source by a tag/u)
  })

  it('runs a prepare_command only for a pod that pod.config.json names, before the pod is cleaned', async () => {
    const prepared = (spec) => ({ ...spec, prepare_command: '  touch prepared.txt\n  echo "int prepared(void);" > Gamma/Core/Prepared.h\n' })
    const refused = await project(prepared)
    await assert.rejects(install(refused.dir, GITHUB), /pods\["Gamma"\]: its podspec has a prepare_command.*name the pod in `prepareCommands`/u)
    const { dir } = await project(prepared, { prepareCommands: ['Gamma'] })
    await install(dir, GITHUB)
    assert.equal(readFileSync(join(dir, 'Pods/Gamma/Gamma/Core/Prepared.h'), 'utf8'), 'int prepared(void);\n')
    assert.equal(existsSync(join(dir, 'Pods/Gamma/prepared.txt')), false, 'what no spec uses is cleaned away')
    assert.match(readFileSync(join(dir, 'Pods/Pods.xcodeproj/project.pbxproj'), 'utf8'), /Prepared\.h in Headers/u)
    const failing = await project((spec) => ({ ...spec, prepare_command: 'echo before >&2; false; echo after >&2' }), { prepareCommands: ['Gamma'] })
    await assert.rejects(install(failing.dir, GITHUB), /pods\["Gamma"\]: its prepare_command failed, with status 1:\nbefore$/u)
  })
})
