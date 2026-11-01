import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createClient } from '@preventive/upstream/github.js'
import { createVfs } from '@preventive/vfs'
import { DeptreeError, LockfileError, buildCocoaPodsTree } from '../cocoapods.js'
import { expandBraces, fnmatch } from '../src/cocoapods/fnmatch.js'
import { ACME, PODFILE, PODSPEC, allLock, coreLock, podspecOf, sha1 } from './cocoapods-fixture.js'
import { stubGitHub, stubTrunk } from './registry.js'

// No spec repo of CocoaPods' own on this machine answers for the stubs.
process.env.CP_REPOS_DIR = join(tmpdir(), `deptree-cocoapods-test-${process.pid}-none`)

const HOST = Object.freeze({ cocoapods: '1.16.2', os: 'linux' })
// Trunk with `podspec` for Acme 1.2.0, and GitHub with the repo, its tag
// and `branches`. Returns what each was asked.
function stubPods({ podspec = PODSPEC, tags = { 'v1.2.0': ACME.commit }, branches = {} } = {}) {
  const github = stubGitHub({ 'acme/acme': { id: 1, commit: ACME.commit, tree: ACME.tree, tarball: ACME.tarball, listings: {}, tags, branches } })
  const trunk = stubTrunk({ 'Acme@1.2.0': podspec })
  return { github, trunk }
}

const client = () => createClient({ token: null })

async function build({ lockfile = coreLock(), podspec, branches, tags, ...rest } = {}) {
  stubPods({ podspec, branches, tags })
  return await buildCocoaPodsTree({ lockfile, host: HOST, github: client(), ...rest })
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
    const { vfs, stats, installed } = await buildCocoaPodsTree({ lockfile: coreLock(), podfile: PODFILE, host: HOST, github: client() })
    assert.deepEqual(listing(vfs), CORE)
    assert.deepEqual(stats, { pods: 1, downloaded: 1, files: 9, bytes: 147, links: 0 })
    assert.deepEqual(installed, [{ path: 'Pods/Acme', name: 'Acme', version: '1.2.0', checksum: sha1(PODSPEC), pods: ['Acme/Core'], git: 'https://github.com/acme/acme.git', tag: 'v1.2.0', commit: ACME.commit }])
    assert.deepEqual(calls.trunk, ['https://cdn.cocoapods.org/Specs/7/9/d/Acme/1.2.0/Acme.podspec.json'])
    assert.deepEqual(calls.github, ['acme/acme/git/ref/heads/v1.2.0', 'acme/acme/git/ref/tags/v1.2.0', `acme/acme/git/commits/${ACME.commit}`, `acme/acme/tarball/${ACME.tree}`])
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
    const lockfile = 'PODS:\n  - Local (0.1.0)\n\nDEPENDENCIES:\n  - Local (from `../Local`)\n\nEXTERNAL SOURCES:\n  Local:\n    :path: "../Local"\n\nSPEC CHECKSUMS:\n  Local: ' + 'f'.repeat(40) + '\n\nCOCOAPODS: 1.16.2\n'
    const { vfs, stats, installed } = await buildCocoaPodsTree({ lockfile, host: HOST })
    assert.deepEqual(listing(vfs), {})
    assert.deepEqual(stats, { pods: 1, downloaded: 0, files: 0, bytes: 0, links: 0 })
    assert.deepEqual(installed, [])
  })

  it('reads Podfile.lock and the Podfile from the project, and holds the Podfile to its checksum', async () => {
    const project = createVfs({ '/Podfile.lock': coreLock(), '/Podfile': PODFILE, '/App/main.swift': '' })
    stubPods()
    const { vfs } = await buildCocoaPodsTree({ project, host: HOST, github: client(), vfs: project })
    assert.equal(vfs, project)
    assert.equal(vfs.readText('/Pods/Acme/LICENSE'), 'MIT\n')
    assert.equal(vfs.readText('/App/main.swift'), '')
    const changed = createVfs({ '/Podfile.lock': coreLock(), '/Podfile': `${PODFILE}pod 'Other'\n` })
    await assert.rejects(buildCocoaPodsTree({ project: changed, host: HOST, github: client() }), LockfileError)
    await assert.rejects(buildCocoaPodsTree({ project: createVfs({ '/Podfile.lock': coreLock() }), host: HOST }), /the project has no Podfile/u)
    await assert.rejects(buildCocoaPodsTree({ project: createVfs({ '/Podfile': PODFILE }), host: HOST }), /the project has no Podfile\.lock/u)
  })

  it('refuses a vfs with a Pods directory before fetching anything', async () => {
    const calls = stubPods()
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(), host: HOST, github: client(), vfs: createVfs({ '/Pods/x': '' }) }), /a Pods directory is there already/u)
    assert.deepEqual([...calls.trunk, ...calls.github], [])
  })

  it('checks out the commit a podspec names, asking for no tag', async () => {
    const podspec = podspecOf({ source: { git: 'git@github.com:acme/acme.git', commit: ACME.commit } })
    const calls = stubPods({ podspec })
    const { vfs, installed } = await buildCocoaPodsTree({ lockfile: coreLock(podspec), host: HOST, github: client() })
    assert.deepEqual(listing(vfs), CORE)
    assert.equal(installed[0].tag, undefined)
    assert.equal(installed[0].commit, ACME.commit)
    assert.deepEqual(calls.github, [`acme/acme/git/commits/${ACME.commit}`, `acme/acme/tarball/${ACME.tree}`])
  })

  it("refuses a tag a branch is named as too, as git's clone takes the branch", async () => {
    await assert.rejects(build({ branches: { 'v1.2.0': 'a'.repeat(40) } }), /has a branch named "v1\.2\.0" as well as the tag/u)
  })

  it('refuses a podspec that is not the one the lockfile has the checksum of', async () => {
    stubPods({ podspec: podspecOf({ summary: 'changed' }) })
    await assert.rejects(buildCocoaPodsTree({ lockfile: coreLock(), host: HOST, github: client() }), (error) => error instanceof DeptreeError && /integrity mismatch for Acme@1\.2\.0/u.test(error.message))
  })

  it('refuses a source but git from GitHub by a tag or a commit, and a prepare_command', async () => {
    for (const [extra, message] of [
      [{ source: { http: 'https://example.com/acme.zip' } }, /a source by :http is not supported/u],
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
    }
  })

  it('refuses a pod from another spec repo or an external source but :path, before fetching anything', async () => {
    const other = coreLock().replace('  trunk:\n', '  https://github.com/acme/specs.git:\n')
    const calls = stubPods()
    await assert.rejects(buildCocoaPodsTree({ lockfile: other, host: HOST, github: client() }), /from the spec repo "https:\/\/github\.com\/acme\/specs\.git" is not supported/u)
    const git = allLock()
      .replace(':path: "../Local"', `:git: https://github.com/acme/local.git\n\nCHECKOUT OPTIONS:\n  Local:\n    :commit: ${'b'.repeat(40)}\n    :git: https://github.com/acme/local.git`)
      .replace('(from `../Local`)', '(from `https://github.com/acme/local.git`)')
    await assert.rejects(buildCocoaPodsTree({ lockfile: git, host: HOST, github: client() }), /an external source by :git is not supported/u)
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
