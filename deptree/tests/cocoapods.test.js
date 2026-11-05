import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createClient } from '@preventive/upstream/github.js'
import { createVfs } from '@preventive/vfs'
import { DeptreeError, LockfileError, buildCocoaPodsTree } from '../cocoapods.js'
import { expandBraces, fnmatch } from '../src/cocoapods/fnmatch.js'
import { installPod, planPod } from '../src/cocoapods/install.js'
import { readPodspec } from '../src/cocoapods/podspec.js'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { archiveOf } from '../src/cocoapods/archive.js'
import { ACME, ACME_ARCHIVE, OTHER, PINS, PODFILE, PODSPEC, allLock, coreLock, httpPodspecOf, mixedLock, podspecLock, podspecOf, sha1, sha256 } from './cocoapods-fixture.js'
import { stubArchives, stubGitHub, stubTrunk } from './registry.js'

// No spec repo of CocoaPods' own on this machine answers for the stubs.
process.env.CP_REPOS_DIR = join(tmpdir(), `deptree-cocoapods-test-${process.pid}-none`)

const HOST = Object.freeze({ cocoapods: '1.16.2', os: 'linux' })
// Trunk with `podspec` for Acme 1.2.0 and `others`, and GitHub with the
// repo, its tag, `branches`, and the commits its default branch is ahead
// of, `history`. Returns what each was asked.
function stubPods({ podspec = PODSPEC, tags = { 'v1.2.0': ACME.commit }, branches = {}, history = [ACME.commit], others = {} } = {}) {
  const github = stubGitHub({ 'acme/acme': { id: 1, commit: ACME.commit, tree: ACME.tree, tarball: ACME.tarball, listings: {}, tags, branches, history } })
  const trunk = stubTrunk({ 'Acme@1.2.0': podspec, ...others })
  return { github, trunk }
}

const client = () => createClient({ token: null })

// A pod by :path alone.
const LOCAL_LOCK = `PODS:\n  - Local (0.1.0)\n\nDEPENDENCIES:\n  - Local (from \`../Local\`)\n\nEXTERNAL SOURCES:\n  Local:\n    :path: "../Local"\n\nSPEC CHECKSUMS:\n  Local: ${'f'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`
const MIXED_LOCK = mixedLock()

async function build({ lockfile = coreLock(), podspec, branches, tags, history, ...rest } = {}) {
  stubPods({ podspec, branches, tags, history })
  return await buildCocoaPodsTree({ lockfile, host: HOST, github: client(), pins: PINS, ...rest })
}

function listing(vfs) {
  const out = {}
  for (const { path, type } of vfs.walk('/')) {
    if (path === '/') continue
    const { mode } = vfs.lstat(path)
    out[path.slice(1)] = type === 'symlink' ? `link ${vfs.readlink(path)}` : type === 'directory' ? 'dir' : `${mode.toString(8)} ${vfs.readText(path)}`
  }
  return out
}

// What CocoaPods 1.16.2 leaves of the repo in Pods/Acme for Acme/Core:
// the download cleaned for every spec, then for Core, its source files
// made read-only. `Sources/Cor` is kept as it is at the start of a used
// file's path, and `foo.` as it ends in a dot.
const CORE = {
  Pods: 'dir',
  'Pods/Acme': 'dir',
  'Pods/Acme/Acme.modulemap': '644 framework module Acme {}\n',
  'Pods/Acme/LICENSE': '644 MIT\n',
  'Pods/Acme/README.md': '644 # Acme\n',
  'Pods/Acme/Sources': 'dir',
  'Pods/Acme/Sources/Cor': '644 prefix\n',
  'Pods/Acme/Sources/Core': 'dir',
  'Pods/Acme/Sources/Core/Acme.h': '444 #import <Foundation/Foundation.h>\n',
  'Pods/Acme/Sources/Core/Acme.m': '444 #import "Acme.h"\n',
  'Pods/Acme/Sources/Core/Acme.swift': '444 public enum Acme {}\n',
  'Pods/Acme/Sources/Core/Exec.c': '555 int acme(void) { return 1; }\n',
  'Pods/Acme/foo.': '644 dot\n',
}

describe('buildCocoaPodsTree', () => {
  it("downloads a pod into Pods/<name>, and keeps of it what CocoaPods keeps", async () => {
    const calls = stubPods()
    const { vfs, stats, installed } = await buildCocoaPodsTree({ lockfile: coreLock(), podfile: PODFILE, host: HOST, github: client(), pins: PINS })
    assert.deepEqual(listing(vfs), CORE)
    assert.deepEqual(stats, { pods: 1, downloaded: 1, files: 9, bytes: 147, links: 0 })
    assert.deepEqual(installed, [{ path: 'Pods/Acme', name: 'Acme', version: '1.2.0', checksum: sha1(PODSPEC), pods: ['Acme/Core'], git: 'https://github.com/acme/acme.git', tag: 'v1.2.0', commit: ACME.commit }])
    assert.deepEqual(calls.trunk, ['https://cdn.cocoapods.org/Specs/7/9/d/Acme/1.2.0/Acme.podspec.json'])
    assert.deepEqual(calls.github, ['acme/acme/git/ref/heads/v1.2.0', 'acme/acme/git/ref/tags/v1.2.0', 'acme/acme.git/git-upload-pack', `acme/acme/tarball/${ACME.tree}`])
  })

  it('keeps what each spec installed uses, and writes nothing for a pod by :path', async () => {
    const { vfs, stats, installed } = await build({ lockfile: allLock() })
    assert.deepEqual(listing(vfs), {
      ...CORE,
      'Pods/Acme/Resources': 'dir',
      'Pods/Acme/Resources/icon.png': '644 png\n',
      'Pods/Acme/Sources/UI': 'dir',
      'Pods/Acme/Sources/UI/View.swift': '444 import UIKit\n',
    })
    assert.equal(stats.pods, 2)
    assert.equal(stats.downloaded, 1)
    assert.deepEqual(installed.map(({ pods }) => pods), [['Acme', 'Acme/Core', 'Acme/UI']])
  })

  it('builds nothing, and fetches nothing, where every pod is by :path', async () => {
    const { vfs, stats, installed, skipped } = await buildCocoaPodsTree({ lockfile: LOCAL_LOCK, host: HOST })
    assert.deepEqual(listing(vfs), {})
    assert.deepEqual(stats, { pods: 1, downloaded: 0, files: 0, bytes: 0, links: 0 })
    assert.deepEqual(installed, [])
    assert.deepEqual(skipped, [])
  })

  it('writes Pods/Manifest.lock with manifest, the lockfile byte for byte, whatever pods there are', async () => {
    const { vfs, stats } = await build({ manifest: true })
    assert.deepEqual(listing(vfs), { ...CORE, 'Pods/Manifest.lock': `644 ${coreLock()}` })
    assert.deepEqual(stats, { pods: 1, downloaded: 1, files: 10, bytes: 147 + Buffer.byteLength(coreLock()), links: 0 })
    const { vfs: local, stats: none } = await buildCocoaPodsTree({ lockfile: LOCAL_LOCK, host: HOST, manifest: true })
    assert.deepEqual(listing(local), { Pods: 'dir', 'Pods/Manifest.lock': `644 ${LOCAL_LOCK}` })
    assert.deepEqual(none, { pods: 1, downloaded: 0, files: 1, bytes: Buffer.byteLength(LOCAL_LOCK), links: 0 })
    const project = createVfs({ '/Podfile.lock': coreLock(), '/Podfile': PODFILE })
    stubPods()
    await buildCocoaPodsTree({ project, host: HOST, github: client(), pins: PINS, vfs: project, manifest: true })
    assert.deepEqual(project.readFile('/Pods/Manifest.lock'), project.readFile('/Podfile.lock'))
    await assert.rejects(build({ manifest: 'yes' }), /manifest must be a boolean, or left out/u)
  })

  it('skips with partial each pod refused for where it is from, lockfile and podspec alike, and lists it', async () => {
    const calls = stubPods({ others: { 'Other@1.0.0': OTHER } })
    await assert.rejects(buildCocoaPodsTree({ lockfile: MIXED_LOCK, host: HOST, github: client(), pins: PINS }), /pods\["Local"\]: a pod from an external source by :git is not supported/u)
    const { vfs, stats, installed, skipped } = await buildCocoaPodsTree({ lockfile: MIXED_LOCK, host: HOST, github: client(), pins: PINS, partial: true, manifest: true })
    assert.deepEqual(listing(vfs), { ...CORE, 'Pods/Manifest.lock': `644 ${MIXED_LOCK}` })
    assert.deepEqual(stats, { pods: 3, downloaded: 1, files: 10, bytes: 147 + Buffer.byteLength(MIXED_LOCK), links: 0 })
    assert.deepEqual(installed.map(({ name }) => name), ['Acme'])
    assert.deepEqual(skipped, [
      { name: 'Local', version: '0.1.0', reason: 'pods["Local"]: a pod from an external source by :git is not supported: only those from trunk, by :podspec and by :path are' },
      { name: 'Other', version: '1.0.0', reason: 'pods["Other"]: an :http source from "https://example.com/other.zip", not https://github.com/<owner>/<repo>/ and a path of letters, digits and `_.~@-%` under it, is not supported' },
    ])
    // Other's podspec is fetched, to know where it is from; nothing more of it.
    assert.deepEqual(calls.trunk.map((at) => at.split('/').at(-1)).sort(), ['Acme.podspec.json', 'Other.podspec.json'])
    assert.equal(calls.github.some((call) => /local|other/iu.test(call)), false)
    await assert.rejects(build({ partial: 1 }), /partial must be a boolean, or left out/u)
  })

  it('holds a pod partial skips to the lockfile all the same, and refuses with it all but where a pod is from', async () => {
    stubPods({ others: { 'Other@1.0.0': Buffer.from(`${OTHER}\n`) } })
    await assert.rejects(buildCocoaPodsTree({ lockfile: MIXED_LOCK, host: HOST, github: client(), pins: PINS, partial: true }), /integrity mismatch for Other@1\.0\.0/u)
    await assert.rejects(build({ branches: { 'v1.2.0': 'a'.repeat(40) }, partial: true }), /has a branch named "v1\.2\.0" as well as the tag/u)
    const podspec = podspecOf({ platforms: { ios: '13.0', osx: '10.15' }, subspecs: [{ name: 'Core', source_files: 'Sources/Core', osx: { exclude_files: 'Sources/Core/Exec.c' } }] })
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec, partial: true }), /names other files on osx than on ios/u)
    stubPods({ podspec: podspecOf({ summary: 'changed' }) })
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(), host: HOST, github: client(), pins: PINS, partial: true }), /integrity mismatch for Acme@1\.2\.0/u)
  })

  it('reads Podfile.lock and the Podfile from the project, and holds the Podfile to its checksum', async () => {
    const project = createVfs({ '/Podfile.lock': coreLock(), '/Podfile': PODFILE, '/App/main.swift': '' })
    stubPods()
    const { vfs } = await buildCocoaPodsTree({ project, host: HOST, github: client(), pins: PINS, vfs: project })
    assert.equal(vfs, project)
    assert.equal(vfs.readText('/Pods/Acme/LICENSE'), 'MIT\n')
    assert.equal(vfs.readText('/App/main.swift'), '')
    const changed = createVfs({ '/Podfile.lock': coreLock(), '/Podfile': `${PODFILE}pod 'Other'\n` })
    await assert.rejects(buildCocoaPodsTree({ project: changed, host: HOST, github: client(), pins: PINS }), LockfileError)
    await assert.rejects(buildCocoaPodsTree({ project: createVfs({ '/Podfile.lock': coreLock() }), host: HOST }), /the project has no Podfile/u)
    await assert.rejects(buildCocoaPodsTree({ project: createVfs({ '/Podfile': PODFILE }), host: HOST }), /the project has no Podfile\.lock/u)
  })

  it('refuses a vfs with a Pods directory before fetching anything', async () => {
    const calls = stubPods()
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(), host: HOST, github: client(), pins: PINS, vfs: createVfs({ '/Pods/x': '' }) }), /a Pods directory is there already/u)
    assert.deepEqual([...calls.trunk, ...calls.github], [])
  })

  it('checks out the commit a podspec names, asking for no tag', async () => {
    const podspec = podspecOf({ source: { git: 'git@github.com:acme/acme.git', commit: ACME.commit } })
    const calls = stubPods({ podspec })
    const { vfs, installed } = await buildCocoaPodsTree({ lockfile: coreLock(podspec), host: HOST, github: client(), pins: PINS })
    assert.deepEqual(listing(vfs), CORE)
    assert.equal(installed[0].tag, undefined)
    assert.equal(installed[0].commit, ACME.commit)
    assert.deepEqual(calls.github, ['acme/acme', `acme/acme/compare/${ACME.commit}...main?per_page=1`, 'acme/acme.git/git-upload-pack', `acme/acme/tarball/${ACME.tree}`])
  })

  it('takes a tag to the commit it is pinned to, and refuses one unpinned, listing every pin it lacks, before any tarball is fetched', async () => {
    const { installed } = await build()
    assert.equal(installed[0].commit, ACME.commit)
    const other = podspecOf({ name: 'Other', version: '1.0.0', source: { git: 'https://github.com/acme/acme.git', tag: 'v1.2.0' } })
    const lockfile = `PODS:\n  - Acme/Core (1.2.0)\n  - Other (1.0.0)\n\nDEPENDENCIES:\n  - Acme/Core\n  - Other\n\nSPEC REPOS:\n  trunk:\n    - Acme\n    - Other\n\nSPEC CHECKSUMS:\n  Acme: ${sha1(PODSPEC)}\n  Other: ${sha1(other)}\n\nCOCOAPODS: 1.16.2\n`
    for (const partial of [false, true]) {
      const calls = stubPods({ others: { 'Other@1.0.0': other } })
      await assert.rejects(buildCocoaPodsTree({ lockfile, host: HOST, github: client(), partial }), (error) => {
        assert.ok(error instanceof DeptreeError && error.where === undefined)
        const [detail, json] = error.message.split(/:\n(?=\{)/u)
        assert.equal(detail, '2 pods by a git tag are pinned to no commit, as the lockfile holds none for a tag and GitHub could move one: pin each to the commit its tag names on GitHub now, once that is checked, as pins takes them')
        assert.deepEqual(JSON.parse(json), { Acme: { tag: 'v1.2.0', commit: ACME.commit }, Other: { tag: 'v1.2.0', commit: ACME.commit } })
        return true
      }, `partial: ${partial}`)
      assert.deepEqual(calls.github.filter((call) => /tarball|upload-pack/u.test(call)), [])
    }
    stubPods({ others: { 'Other@1.0.0': other } })
    await assert.rejects(buildCocoaPodsTree({ lockfile, host: HOST, github: client(), pins: PINS }), /^DeptreeError: a pod by a git tag is pinned to no commit[^]*"Other"/u)
  })

  it('refuses a pin for another tag than its podspec names, and a tag GitHub has moved off the commit it is pinned to', async () => {
    await assert.rejects(build({ pins: { Acme: { tag: 'v1.1.0', commit: ACME.commit } } }), /pods\["Acme"\]: it is pinned for the tag "v1\.1\.0", where its podspec names "v1\.2\.0": pin it anew, once checked/u)
    await assert.rejects(build({ tags: { 'v1.2.0': 'c'.repeat(40) } }), new RegExp(`pods\\["Acme"\\]: its tag "v1\\.2\\.0" names ${'c'.repeat(40)} on GitHub now, not ${ACME.commit}, which it is pinned to`, 'u'))
    for (const pins of [null, [], { Acme: null }, { Acme: { tag: 'v1.2.0' } }, { Acme: { tag: 'v1.2.0', commit: ACME.commit.toUpperCase() } }, { Acme: { tag: '', commit: ACME.commit } }, { Acme: { ...PINS.Acme, branch: 'main' } }]) {
      await assert.rejects(build({ pins }), /pins must be an object of pins by name/u, JSON.stringify(pins))
    }
  })

  it("reads a commit's tree off its own object, and refuses one GitHub has no such object for", async () => {
    const podspec = podspecOf({ source: { git: 'https://github.com/acme/acme.git', commit: 'b'.repeat(40) } })
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec, history: ['b'.repeat(40)] }), /pods\["Acme"\]: getCommitTree: GitHub refused the fetch: upload-pack: not our ref b{40}/u)
  })

  it('refuses a commit the default branch does not have, as a clone may not', async () => {
    const podspec = podspecOf({ source: { git: 'https://github.com/acme/acme.git', commit: ACME.commit } })
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec, history: [] }), /is not in the history of the repository's default branch/u)
  })

  it('refuses every pod before it fetches any tarball', async () => {
    const other = Buffer.from(`${JSON.stringify({ name: 'Other', version: '1.0.0', source: { http: 'https://example.com/other.zip' } })}\n`)
    const lockfile = `PODS:\n  - Acme/Core (1.2.0)\n  - Other (1.0.0)\n\nDEPENDENCIES:\n  - Acme/Core\n  - Other\n\nSPEC REPOS:\n  trunk:\n    - Acme\n    - Other\n\nSPEC CHECKSUMS:\n  Acme: ${sha1(PODSPEC)}\n  Other: ${sha1(other)}\n\nCOCOAPODS: 1.16.2\n`
    const calls = stubPods({ others: { 'Other@1.0.0': other } })
    await assert.rejects(buildCocoaPodsTree({ lockfile, host: HOST, github: client(), pins: PINS }), /pods\["Other"\]: an :http source from "https:\/\/example\.com\/other\.zip", not https:\/\/github\.com/u)
    assert.deepEqual(calls.github.filter((call) => /\/(?:git\/commits|tarball)\//u.test(call)), [])
  })

  it('refuses what the podspec alone says before fetching any tarball', async () => {
    const podspec = podspecOf({ platforms: 'iOS' })
    const calls = stubPods({ podspec })
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(podspec), host: HOST, github: client(), pins: PINS }), /platforms names "iOS"/u)
    assert.deepEqual(calls.github.filter((call) => /\/(?:git\/commits|tarball)\//u.test(call)), [])
  })

  it("refuses a tag a branch is named as too, as git's clone takes the branch", async () => {
    await assert.rejects(build({ branches: { 'v1.2.0': 'a'.repeat(40) } }), /has a branch named "v1\.2\.0" as well as the tag/u)
  })

  it('refuses a podspec that is not the one the lockfile has the checksum of', async () => {
    stubPods({ podspec: podspecOf({ summary: 'changed' }) })
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(), host: HOST, github: client(), pins: PINS }), (error) => error instanceof DeptreeError && /integrity mismatch for Acme@1\.2\.0/u.test(error.message))
  })

  it('refuses a source but git from GitHub by a tag or a commit, and a prepare_command', async () => {
    for (const [extra, message] of [
      [{ source: { http: 'https://example.com/acme.zip' } }, /an :http source from "https:\/\/example\.com\/acme\.zip", not https:\/\/github\.com/u],
      [{ source: { svn: 'https://example.com/acme' } }, /a source by :svn is not supported: only git from GitHub, and :http from GitHub, are/u],
      [{ source: { git: 'https://gitlab.com/acme/acme.git', tag: 'v1.2.0' } }, /not a GitHub repository over https or ssh/u],
      [{ source: { git: 'https://github.com/acme/acme.git', tag: 'v1.2.0', submodules: true } }, /with its submodules is not supported/u],
      [{ source: { git: 'https://github.com/acme/acme.git', branch: 'main' } }, /by a branch, which locks no commit/u],
      [{ source: { git: 'https://github.com/acme/acme.git', tag: 'v1.2.0', commit: ACME.commit } }, /names both or neither/u],
      [{ source: { git: 'https://github.com/acme/acme.git', commit: ACME.commit.slice(0, 8) } }, /is not a full commit/u],
      [{ source: { git: 'https://github.com/acme/acme.git', tag: 'v1.2.0', shallow: true } }, /has :shallow, which cocoapods-downloader refuses/u],
      [{ prepare_command: 'make' }, /a prepare_command, a script CocoaPods runs in the download, is not supported/u],
    ]) {
      const podspec = podspecOf(extra)
      await assert.rejects(build({ lockfile: coreLock(podspec), podspec }), (error) => error instanceof DeptreeError && error.where === 'pods["Acme"]' && message.test(error.message), JSON.stringify(extra))
      const { vfs, skipped } = await build({ lockfile: coreLock(podspec), podspec, partial: true })
      assert.deepEqual(listing(vfs), {}, JSON.stringify(extra))
      assert.deepEqual(skipped.map(({ name, version }) => `${name} ${version}`), ['Acme 1.2.0'], JSON.stringify(extra))
      assert.match(skipped[0].reason, message, JSON.stringify(extra))
    }
  })

  it('refuses a pod from another spec repo or an external source but :path, before fetching anything', async () => {
    const other = coreLock().replace('  trunk:\n', '  https://github.com/acme/specs.git:\n')
    const calls = stubPods()
    await assert.rejects(buildCocoaPodsTree({ lockfile: other, host: HOST, github: client(), pins: PINS }), /from the spec repo "https:\/\/github\.com\/acme\/specs\.git" is not supported/u)
    const git = allLock()
      .replace(':path: "../Local"', `:git: https://github.com/acme/local.git\n\nCHECKOUT OPTIONS:\n  Local:\n    :commit: ${'b'.repeat(40)}\n    :git: https://github.com/acme/local.git`)
      .replace('(from `../Local`)', '(from `https://github.com/acme/local.git`)')
    await assert.rejects(buildCocoaPodsTree({ lockfile: git, host: HOST, github: client(), pins: PINS }), /an external source by :git is not supported/u)
    assert.deepEqual([...calls.trunk, ...calls.github], [])
    const { vfs, skipped } = await buildCocoaPodsTree({ lockfile: other, host: HOST, github: client(), pins: PINS, partial: true })
    assert.deepEqual(listing(vfs), {})
    assert.match(skipped[0].reason, /^pods\["Acme"\]: a pod from the spec repo "https:\/\/github\.com\/acme\/specs\.git" is not supported/u)
    assert.deepEqual([...calls.trunk, ...calls.github], [])
  })

  it('refuses a pod whose name is a glob, which CocoaPods cleans it by, before fetching anything', async () => {
    const lockfile = `PODS:\n  - "Foo[1] (1.0.0)"\n\nDEPENDENCIES:\n  - "Foo[1]"\n\nSPEC REPOS:\n  trunk:\n    - "Foo[1]"\n\nSPEC CHECKSUMS:\n  "Foo[1]": ${'f'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`
    const calls = stubPods()
    await assert.rejects(buildCocoaPodsTree({ lockfile, host: HOST, github: client(), pins: PINS }), /pods\["Foo\[1\]"\]: a name with a glob's/u)
    assert.deepEqual([...calls.trunk, ...calls.github], [])
  })

  it('refuses a spec that names other files on another platform, unless the platforms given are one', async () => {
    const podspec = podspecOf({ platforms: { ios: '13.0', osx: '10.15' }, subspecs: [{ name: 'Core', source_files: 'Sources/Core', osx: { exclude_files: 'Sources/Core/Exec.c' } }, { name: 'UI', source_files: 'Sources/UI/**/*.swift' }] })
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec }), /"Acme\/Core" names other files on osx than on ios, and the platforms it is installed for are not given/u)
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec, platforms: ['ios', 'osx'] }), /does not say which of the platforms given/u)
    const { vfs } = await build({ lockfile: coreLock(podspec), podspec, platforms: ['ios'] })
    assert.equal(listing(vfs)['Pods/Acme/Sources/Core/Exec.c'], '555 int acme(void) { return 1; }\n')
    const { vfs: mac } = await build({ lockfile: coreLock(podspec), podspec, platforms: ['osx'] })
    assert.equal(listing(mac)['Pods/Acme/Sources/Core/Exec.c'], undefined)
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec, platforms: ['watchos'] }), /is for none of the platforms given/u)
  })

  it('downloads a pod by :podspec by the podspec CocoaPods evaluated, held to the lockfile, as given or in Pods/Local Podspecs', async () => {
    const podspec = httpPodspecOf()
    const calls = { trunk: stubTrunk({}), archives: stubArchives({ [ACME_ARCHIVE]: ACME.tarball }) }
    const { vfs, installed } = await buildCocoaPodsTree({ lockfile: podspecLock(podspec), host: HOST, github: client(), pins: PINS, podspecs: { Acme: podspec } })
    assert.deepEqual(listing(vfs), CORE)
    assert.deepEqual(installed, [{ path: 'Pods/Acme', name: 'Acme', version: '1.2.0', checksum: sha1(podspec), pods: ['Acme/Core'], http: ACME_ARCHIVE, sha256: sha256(ACME.tarball) }])
    assert.deepEqual(calls.trunk, [])
    assert.deepEqual(calls.archives, [ACME_ARCHIVE])
    // One of git from GitHub, given as text.
    stubPods()
    const { vfs: git } = await buildCocoaPodsTree({ lockfile: podspecLock(PODSPEC), host: HOST, github: client(), pins: PINS, podspecs: { Acme: PODSPEC.toString(), Other: '{}' } })
    assert.deepEqual(listing(git), CORE)
    const project = createVfs({ '/Podfile.lock': podspecLock(podspec), '/Podfile': PODFILE, '/Pods/Local Podspecs/Acme.podspec.json': podspec })
    stubArchives({ [ACME_ARCHIVE]: ACME.tarball })
    await assert.rejects(buildCocoaPodsTree({ project, host: HOST, github: client(), pins: PINS }), LockfileError, 'the Podfile is held to the lockfile as before')
    const { vfs: read } = await buildCocoaPodsTree({ project: createVfs({ '/Podfile.lock': podspecLock(podspec).replace('COCOAPODS', `PODFILE CHECKSUM: ${sha1(PODFILE)}\n\nCOCOAPODS`), '/Podfile': PODFILE, '/Pods/Local Podspecs/Acme.podspec.json': podspec }), host: HOST, github: client(), pins: PINS })
    assert.deepEqual(listing(read), CORE)
  })

  it('refuses a :podspec pod whose podspec given is not the lockfile\'s, and one not given unless partial skips it', async () => {
    const podspec = httpPodspecOf()
    stubArchives({ [ACME_ARCHIVE]: ACME.tarball })
    const given = (podspecs, rest = {}) => buildCocoaPodsTree({ lockfile: podspecLock(podspec), host: HOST, github: client(), pins: PINS, podspecs, ...rest })
    await assert.rejects(given({ Acme: `${podspec}\n` }), /pods\["Acme"\]: its podspec given is not the one the lockfile has the checksum of/u)
    await assert.rejects(given({ Acme: `${podspec}\n` }, { partial: true }), /is not the one the lockfile has the checksum of/u)
    await assert.rejects(given({}), /pods\["Acme"\]: its podspec, the JSON CocoaPods writes as Pods\/Local Podspecs\/Acme\.podspec\.json, is not given/u)
    const { vfs, skipped } = await given(undefined, { partial: true })
    assert.deepEqual(listing(vfs), {})
    assert.match(skipped[0].reason, /is not given$/u)
    await assert.rejects(given({ Acme: 1 }), TypeError)
    await assert.rejects(given([]), TypeError)
    await assert.rejects(given({ Acme: '\uD800' }), TypeError)
    await assert.rejects(buildCocoaPodsTree({ lockfile: podspecLock(PODSPEC, ACME.commit), host: HOST, github: client(), pins: PINS, podspecs: { Acme: PODSPEC } }), /a pod by :podspec that CocoaPods downloads by its CHECKOUT OPTIONS is not supported/u)
  })

  it('downloads an :http archive from GitHub, held to its podspec\'s hash, and flattens it as RemoteFile does', async () => {
    const fromTrunk = async (podspec, rest = {}) => {
      stubTrunk({ 'Acme@1.2.0': podspec })
      const calls = stubArchives({ [ACME_ARCHIVE]: ACME.tarball })
      return { ...await buildCocoaPodsTree({ lockfile: coreLock(podspec), host: HOST, github: client(), pins: PINS, ...rest }), calls }
    }
    const { vfs, installed, calls } = await fromTrunk(httpPodspecOf())
    assert.deepEqual(listing(vfs), CORE)
    assert.deepEqual(calls, [ACME_ARCHIVE])
    assert.equal(installed[0].git, undefined)
    const top = 'acme-acme-ef76ec6'
    const { vfs: kept } = await fromTrunk(httpPodspecOf({ flatten: false }, { subspecs: [{ name: 'Core', source_files: `${top}/Sources/Core` }] }))
    assert.equal(listing(kept)[`Pods/Acme/${top}/Sources/Core/Acme.h`], '444 #import <Foundation/Foundation.h>\n')
    const { installed: both } = await fromTrunk(httpPodspecOf({ sha1: sha1(ACME.tarball) }))
    assert.equal(both[0].sha256, sha256(ACME.tarball), 'sha256 before sha1, as RemoteFile checks one')
    const { vfs: tar } = await fromTrunk(httpPodspecOf({ type: 'tar' }))
    assert.deepEqual(listing(tar), CORE, '`tar xf` reads a gzipped tar whatever its type says')
  })

  it('refuses an archive its hash is not of, partial or not', async () => {
    for (const partial of [false, true]) {
      const podspec = httpPodspecOf({ sha256: 'a'.repeat(64) })
      stubTrunk({ 'Acme@1.2.0': podspec })
      stubArchives({ [ACME_ARCHIVE]: ACME.tarball })
      await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(podspec), host: HOST, github: client(), pins: PINS, partial }), (error) => error instanceof DeptreeError && /integrity mismatch for https:\/\/github\.com\/acme\/acme\/archive/u.test(error.message))
    }
  })

  it('refuses an :http source but one on GitHub over https, held to a hash, of an archive `tar xf` extracts', async () => {
    for (const [source, message] of [
      [{ http: 'http://github.com/acme/acme/archive/refs/tags/v1.2.0.tar.gz' }, /not https:\/\/github\.com\/<owner>\/<repo>\//u],
      [{ http: 'https://gitlab.com/acme/acme/-/archive/v1.2.0/acme.tar.gz' }, /not https:\/\/github\.com/u],
      [{ http: `${ACME_ARCHIVE}?x=1` }, /not https:\/\/github\.com/u],
      [{ http: 'https://github.com/acme/acme' }, /not https:\/\/github\.com/u],
      [{ http: 'https://github.com/acme/acme/archive/v1+2.tar.gz' }, /not https:\/\/github\.com/u],
      [{ sha256: null }, /with no :sha256 to hold the download to is not supported/u],
      [{ sha256: null, sha1: sha1(ACME.tarball) }, /held to a :sha1 alone, which two archives can be made to share, is not supported: only one held to a :sha256 is/u],
      [{ sha256: 'A'.repeat(64) }, /its :sha256 is not one in lowercase hex/u],
      [{ headers: ['Authorization: x'] }, /with :headers, which curl sends with the request, is not supported/u],
      [{ type: 'zip' }, /an :http source of a zip is not supported/u],
      [{ http: 'https://github.com/acme/acme/archive/refs/tags/v1.2.0.zip' }, /an :http source of a zip is not supported/u],
      [{ type: 'gz' }, /its :type "gz" names no type of archive/u],
      [{ http: 'https://github.com/acme/acme/releases/download/v1.2.0/acme' }, /its URL names no type of archive/u],
      [{ shallow: true }, /its source has :shallow, which cocoapods-downloader refuses of :http/u],
    ]) {
      const podspec = httpPodspecOf(source)
      await assert.rejects(build({ lockfile: coreLock(podspec), podspec }), (error) => error instanceof DeptreeError && error.where === 'pods["Acme"]' && message.test(error.message), JSON.stringify(source))
      const { skipped } = await build({ lockfile: coreLock(podspec), podspec, partial: true })
      assert.match(skipped[0].reason, message, JSON.stringify(source))
    }
  })

  it('refuses a host it does not build for, and options of the wrong type', async () => {
    await assert.rejects(build({ host: { cocoapods: '1.12.1', os: 'linux' } }), /CocoaPods "1\.12\.1" is not supported/u)
    await assert.rejects(build({ host: { cocoapods: '1.16.2', os: 'win32' } }), /"win32" is not supported/u)
    await assert.rejects(build({ platforms: ['android'] }), TypeError)
    await assert.rejects(build({ platforms: [] }), TypeError)
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(), host: HOST }), /github must be a GitHub client/u)
    await assert.rejects(buildCocoaPodsTree({ host: HOST }), /lockfile must be the Podfile\.lock text/u)
  })

  it('refuses on macOS two names in a pod that are one there', async () => {
    const podspec = podspecOf({ subspecs: [{ name: 'Core', source_files: 'Sources/Core' }] })
    const { vfs } = await build({ lockfile: coreLock(podspec), podspec, host: { cocoapods: '1.16.2', os: 'darwin' } })
    assert.equal(vfs.readText('/Pods/Acme/LICENSE'), 'MIT\n')
    await assert.rejects(build({ lockfile: coreLock(podspec), podspec, host: { cocoapods: '1.16.2', os: 'darwin' }, vfs: createVfs({ '/pods': '' }) }), /a Pods directory is there already/u)
  })
})

describe('installPod', () => {
  // A download of Foo.h and `Alias.h` linking to `foo.h`, each a source
  // file of the root, unless `files` and `links` say otherwise; `spec`
  // what the root has beside its name and version.
  const FOO = { 'Foo.h': 'foo' }
  const ALIAS = { 'Alias.h': 'foo.h' }
  const HEADERS = { source_files: '*.h' }
  const install = ({ folded = false, keepsGit = false, files = FOO, links = ALIAS, spec = HEADERS }) => {
    const podspec = readPodspec(Buffer.from(JSON.stringify({ name: 'Pod', version: '1.0.0', ...spec })), 'Pod', '1.0.0', 'pod')
    const contents = { dirs: [], files: new Map(Object.entries(files).map(([path, data]) => [path, { data: Buffer.from(data), mode: 0o644 }])), links: new Map(Object.entries(links)) }
    const out = installPod(contents, planPod(podspec, [podspec], undefined, 'pod'), { folded, keepsGit, where: 'pod' })
    return Object.fromEntries([...[...out.files].map(([path, { mode }]) => [path, mode.toString(8)]), ...out.links])
  }

  it('follows a link on macOS to a name of another case, as its filesystem finds one', () => {
    assert.deepEqual(install({ folded: true }), { 'Foo.h': '444', 'Alias.h': 'foo.h' })
    assert.throws(() => install({}), /the source file "Alias\.h" links to nothing/u)
  })

  it('refuses on macOS a download with two names that are one there, whatever is kept of it', () => {
    const files = { 'Foo.h': 'foo', 'A.txt': 'a', 'a.TXT': 'b' }
    assert.throws(() => install({ folded: true, files, links: {} }), /"A\.txt" and "a\.TXT" are one name on macOS/u)
    assert.deepEqual(install({ files, links: {} }), { 'Foo.h': '444' })
  })

  it('takes a link to nothing at all as one that leads nowhere', () => {
    assert.throws(() => install({ links: { 'Alias.h': '' } }), /the source file "Alias\.h" links to nothing/u)
  })

  it('gives up on a chain of links where the system does: after 40 on Linux, 32 on macOS', () => {
    // c1.h to c35.h, each a link to the next, the last to Foo.h.
    const links = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`c${i + 1}.h`, i === 34 ? 'Foo.h' : `c${i + 2}.h`]))
    assert.equal(install({ links })['Foo.h'], '444')
    assert.throws(() => install({ folded: true, links }), /the source file "c1\.h" links to nothing/u)
  })

  it("refuses, before CocoaPods 1.16, a pod whose patterns keep the clone's .git", () => {
    const spec = { source_files: '*.h', preserve_paths: '.*' }
    assert.throws(() => install({ keepsGit: true, links: {}, spec }), /keep the \.git of the clone/u)
    assert.deepEqual(install({ links: {}, spec }), { 'Foo.h': '444' })
    assert.deepEqual(install({ keepsGit: true, links: {} }), { 'Foo.h': '444' })
  })

  it('refuses a name or a path longer than the system takes, and a letter Ruby releases case otherwise', () => {
    assert.throws(() => install({ files: { [`${'a'.repeat(256)}.h`]: '' }, links: {} }), /longer than a path or a name can be/u)
    const deep = { [`${'d/'.repeat(600)}x.h`]: '' }
    assert.deepEqual(Object.keys(install({ files: deep, links: {} })), [])
    assert.throws(() => install({ folded: true, files: deep, links: {} }), /longer than a path or a name can be/u)
    assert.throws(() => install({ files: { '\u{10D50}.h': '' }, links: {} }), /a letter whose case each release of Ruby maps otherwise/u)
  })

  it('refuses a pod that takes too many matches to clean, before making them', () => {
    const files = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`f${i}.h`, '']))
    const spec = { source_files: Array.from({ length: 12 }, (_, i) => `{a${i},b${i}}`).join('') }
    const started = Date.now()
    assert.throws(() => install({ files, links: {}, spec }), /take more than 200000000 matches/u)
    assert.ok(Date.now() - started < 10_000)
  })
})

describe('fnmatch', () => {
  // Each as Ruby's File.fnmatch has it, with FNM_CASEFOLD | FNM_PATHNAME.
  it('matches as Ruby does, its bracket quirk with it', () => {
    for (const [pattern, path, expected] of [
      ['**/*.m', 'a/b/f.m', true], ['**/*.m', 'f.m', true], ['a/**/f.m', 'a/f.m', true], ['*', '.h', false], ['**/*', 'a/.h/x', false],
      ['**/b', '.x/b', false], ['.*', '.x', true], ['[.]x', '.x', false], ['A*', 'abc', true], ['\u00E9', '\u00C9', false],
      ['[a]', 'A', false], ['[ba]', 'A', true], ['[ab]', 'B', true], ['[a-c]', 'B', true], ['[!a]', 'A', true], ['a?b', 'a/b', false],
      ['[/]', '/', false], ['\\*', '*', true], ['*', '', true], ['[]a]', ']', false], ['[a-]', '-', true],
    ]) assert.equal(fnmatch(pattern, path), expected, `${pattern} ${path}`)
  })
})

describe('expandBraces', () => {
  it('expands as PathList does: each set by its text, values split as Ruby splits them', () => {
    assert.deepEqual(expandBraces('a/**/b'), ['a/**/b', 'a/b'])
    assert.deepEqual(expandBraces('{a,b}/{c,d}'), ['a/c', 'a/d', 'b/c', 'b/d'])
    assert.deepEqual(expandBraces('{a,b}/{a,b}'), ['a/a', 'b/b'])
    assert.deepEqual(expandBraces('x{}'), [])
    assert.deepEqual(expandBraces('x{,}'), [])
    assert.deepEqual(expandBraces('x{,a,}'), ['x', 'xa'])
    assert.deepEqual(expandBraces('{a{b}'), ['ab'])
    assert.equal(expandBraces('{a\\b,c}'), undefined)
  })
})

describe('archiveOf', () => {
  const tgz = { file: 'file.tgz', flatten: true }
  const archive = async (entries, gzip = true) => {
    const tar = pack(entries)
    return gzip ? await compress(tar, 'gzip') : tar
  }
  const extract = async (entries, source = tgz) => {
    const { dirs, files, links } = await archiveOf(await archive(entries), source, 'pod')
    return { dirs: [...dirs].sort(), files: Object.fromEntries([...files].map(([path, { mode }]) => [path, mode.toString(8)])), links: Object.fromEntries(links) }
  }

  it('extracts as a user other than root, flattening one directory, and copies hard links', async () => {
    const out = await extract([
      { name: 'Pod-1.0/', type: 'directory', mode: 0o700 },
      { name: 'Pod-1.0/a.h', data: Buffer.from('a'), mode: 0o666 },
      { name: 'Pod-1.0/b.h', type: 'hardlink', linkname: 'Pod-1.0/a.h' },
      { name: 'Pod-1.0/sub/run', data: Buffer.from('#!'), mode: 0o775 },
      { name: 'Pod-1.0/c.h', type: 'symlink', linkname: 'a.h' },
    ])
    assert.deepEqual(out, { dirs: [], files: { 'a.h': '644', 'b.h': '644', 'sub/run': '755' }, links: { 'c.h': 'a.h' } })
    assert.deepEqual((await extract([{ name: 'Pod-1.0/a.h', data: Buffer.from('a') }], { file: 'file.tgz', flatten: false })).files, { 'Pod-1.0/a.h': '644' })
    assert.deepEqual((await extract([{ name: 'Pod-1.0/a.h', data: Buffer.from('a') }, { name: 'README', data: Buffer.from('r') }])).files, { 'Pod-1.0/a.h': '644', README: '644' }, 'two things are not flattened')
    assert.deepEqual((await archiveOf(await archive([{ name: 'x/a.h', data: Buffer.from('a') }], false), tgz, 'pod')).files.get('a.h').mode, 0o644, 'a tar not gzipped')
  })

  it('refuses what tar would make otherwise on another machine, or what the moves would meet', async () => {
    for (const [entries, message] of [
      [[{ name: 'x/run', data: Buffer.from(''), mode: 0o4755 }], /a mode of 4755, with a bit tar sets or drops/u],
      [[{ name: 'x/', type: 'directory', mode: 0o555 }, { name: 'x/a', data: Buffer.from('') }], /a directory of mode 555, which its owner cannot list and write in/u],
      [[{ name: 'x/a', data: Buffer.from(''), mode: 0o200 }], /a file of mode 200, which its owner cannot read/u],
      [[{ name: 'x/._a', data: Buffer.from('') }], /a name starting with `\._`/u],
      [[{ name: 'x/.git/config', data: Buffer.from('') }], /a path with a \.git in it/u],
      [[{ name: 'x/fifo', type: 'fifo' }], /a fifo, which a pod's download cannot hold/u],
      [[{ name: 'file.tgz', data: Buffer.from('') }], /the archive holds "file\.tgz", the name RemoteFile downloads it under/u],
      [[{ name: 'x', type: 'symlink', linkname: 'y' }], /the one thing in the archive is a link/u],
      [[{ name: 'x./a', data: Buffer.from('') }], /has a name ending in `\.`/u],
      [[{ name: 'x/x.tmp', data: Buffer.from('') }], /holds "x\.tmp", the name it is moved to/u],
    ]) await assert.rejects(extract(entries), (error) => error instanceof DeptreeError && message.test(error.message), JSON.stringify(entries))
    await assert.rejects(archiveOf(Buffer.from('BZh91AY&SY'), tgz, 'pod'), /compressed with bzip2, which is not read here/u)
    await assert.rejects(archiveOf(Buffer.from('not a tar at all'), tgz, 'pod'), /its archive cannot be read/u)
  })
})
