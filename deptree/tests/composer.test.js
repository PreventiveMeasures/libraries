import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { Vfs } from '@preventive/vfs'
import { DeptreeError, LockfileError, buildComposerTree } from '../composer.js'
import { rawZip } from './registry.js'

const HOST = Object.freeze({ composer: '2.10.3', os: 'linux', unzip: true })
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const DRUPAL = 'https://ftp.drupal.org/files/projects/admin_toolbar-3.6.3.zip'
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const encoder = new TextEncoder()
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')
const zipball = (repo, sha = SHA) => ({ type: 'zip', url: `https://api.github.com/repos/${repo}/zipball/${sha}`, reference: sha, shasum: '' })

// GitHub's archive of a commit as git writes it: its top directory first,
// directories 0o775, files 0o664 or 0o775. `files` maps a path to text,
// `{ link }` or `{ exec }`; a path ending in `/` is a directory.
async function archive(files) {
  const top = 'acme-lib-aaaaaaa'
  const entries = [{ name: `${top}/`, type: 'directory', mode: 0o775 }]
  for (const [path, given] of Object.entries(files)) {
    const file = typeof given === 'string' ? { text: given } : given
    if (path.endsWith('/')) entries.push({ name: `${top}/${path}`, type: 'directory', mode: 0o775 })
    else if (file.link === undefined) entries.push({ name: `${top}/${path}`, data: encoder.encode(file.exec ?? file.text), mode: file.exec === undefined ? 0o664 : 0o775 })
    else entries.push({ name: `${top}/${path}`, type: 'symlink', linkname: file.link })
  }
  return await compress(pack(entries, { format: 'pax' }), 'gzip')
}

// A client of GitHub that answers each archive by repo@sha.
function github(archives) {
  const calls = []
  return {
    calls,
    getRepoTarball: (options) => {
      calls.push(options)
      const bytes = archives[`${options.repo}@${options.sha}`]
      return bytes === undefined ? Promise.reject(new Error(`no archive of ${options.repo}@${options.sha}`)) : Promise.resolve(bytes)
    },
  }
}

const serve = (files) => {
  globalThis.fetch = (input) => Promise.resolve(Object.hasOwn(files, String(input)) ? new Response(files[String(input)]) : Response.json({}, { status: 404 }))
}

// A lockfile of Composer 2.10, as it writes one: `packages` and
// `packages-dev` sorted by name, each `{ name, version, ... }`; and the
// composer.json that asks for each, with `config`.
function project(packages, dev = [], config) {
  const stability = [...packages, ...dev].some(({ version }) => version.startsWith('dev-')) ? 'dev' : 'stable'
  const order = ['name', 'version', 'target-dir', 'source', 'dist', 'require', 'bin', 'type']
  const sorted = (list) => list.toSorted((a, b) => (a.name < b.name ? -1 : 1)).map((pkg) => Object.fromEntries(order.filter((key) => pkg[key] !== undefined).map((key) => [key, pkg[key]])))
  const lock = {
    _readme: ['This file locks the dependencies of your project to a known state', 'Read more about it at https://getcomposer.org/doc/01-basic-usage.md#installing-dependencies', 'This file is @generated automatically'],
    'content-hash': '0123456789abcdef0123456789abcdef',
    packages: sorted(packages),
    'packages-dev': sorted(dev),
    aliases: [],
    'minimum-stability': stability,
    'stability-flags': {},
    'prefer-stable': false,
    'prefer-lowest': false,
    platform: {},
    'platform-dev': {},
    'plugin-api-version': '2.9.0',
  }
  const asks = (list) => Object.fromEntries(list.map(({ name, version }) => [name.toLowerCase(), version]))
  const root = { name: 'acme/app', require: asks(packages), ...(dev.length > 0 ? { 'require-dev': asks(dev) } : {}), 'minimum-stability': stability, ...(config === undefined ? {} : { config }) }
  return { lockfile: `${JSON.stringify(lock, null, 4)}\n`, composerJson: JSON.stringify(root) }
}

function listing(vfs) {
  const out = {}
  for (const { path, type } of vfs.walk('/')) {
    if (path === '/') continue
    const { mode } = vfs.lstat(path)
    out[path.slice(1)] = type === 'directory' ? `dir ${mode.toString(8)}` : type === 'symlink' ? `-> ${vfs.readlink(path)}` : `${mode.toString(8)} ${vfs.readText(path)}`
  }
  return out
}

const LIB = { name: 'acme/lib', version: '1.0.0', dist: zipball('acme/lib'), bin: ['bin/plain', 'bin/tool', 'missing', 'src'], type: 'library' }
const LIB_FILES = { 'src/A.php': '<?php', 'bin/plain': '#!/bin/sh', 'bin/tool': { exec: '#!/bin/sh' }, 'docs/': {}, latest: { link: 'src/A.php' } }

describe('buildComposerTree', () => {
  it('installs each package into vendor/<name> as unzip extracts its zipball, held to its commit', async () => {
    const client = github({ [`acme/lib@${SHA}`]: await archive(LIB_FILES), [`acme/dev@${SHA2}`]: await archive({ 'x.php': 'x' }) })
    const meta = { name: 'acme/meta', version: '1.0.0', type: 'metapackage' }
    const dev = { name: 'acme/dev', version: '2.0.0', dist: zipball('acme/dev', SHA2), type: 'library' }
    const { vfs, stats, installed } = await buildComposerTree({ ...project([LIB, meta], [dev]), host: HOST, github: client })
    assert.deepEqual(listing(vfs), {
      vendor: 'dir 755',
      'vendor/acme': 'dir 755',
      'vendor/acme/dev': 'dir 755',
      'vendor/acme/dev/x.php': '644 x',
      'vendor/acme/lib': 'dir 755',
      'vendor/acme/lib/bin': 'dir 755',
      'vendor/acme/lib/bin/plain': '755 #!/bin/sh',
      'vendor/acme/lib/bin/tool': '755 #!/bin/sh',
      'vendor/acme/lib/docs': 'dir 755',
      'vendor/acme/lib/latest': '-> src/A.php',
      'vendor/acme/lib/src': 'dir 755',
      'vendor/acme/lib/src/A.php': '644 <?php',
    })
    assert.deepEqual(client.calls.toSorted((a, b) => (a.repo < b.repo ? -1 : 1)), [{ repo: 'acme/dev', sha: SHA2, exported: true }, { repo: 'acme/lib', sha: SHA, exported: true }])
    assert.deepEqual(stats, { packages: 3, installed: 2, metapackages: 1, files: 4, bytes: 24, links: 1 })
    assert.deepEqual(installed, [
      { path: 'vendor/acme/lib', name: 'acme/lib', version: '1.0.0', type: 'library', dev: false, repo: 'acme/lib', commit: SHA },
      { path: null, name: 'acme/meta', version: '1.0.0', type: 'metapackage', dev: false },
      { path: 'vendor/acme/dev', name: 'acme/dev', version: '2.0.0', type: 'library', dev: true, repo: 'acme/dev', commit: SHA2 },
    ])
  })

  it('holds a dist with a shasum to it, and moves the one directory at the top of its zip into place', async () => {
    const zip = rawZip([
      { name: 'admin_toolbar/', mode: 0o40755 },
      { name: 'admin_toolbar/a.yml', data: 'a', mode: 0o100644 },
      { name: 'admin_toolbar/run', data: 'r', mode: 0o104755 },
      { name: '.DS_Store', data: 'd', mode: 0o100644 },
    ])
    serve({ [DRUPAL]: zip })
    const pkg = { name: 'drupal/admin_toolbar', version: '3.6.3', dist: { type: 'zip', url: DRUPAL, reference: '8.x-3.6.3', shasum: sha1(zip) }, type: 'drupal-module' }
    const { vfs, installed } = await buildComposerTree({ ...project([pkg]), host: HOST })
    assert.deepEqual(listing(vfs), { vendor: 'dir 755', 'vendor/drupal': 'dir 755', 'vendor/drupal/admin_toolbar': 'dir 755', 'vendor/drupal/admin_toolbar/a.yml': '644 a', 'vendor/drupal/admin_toolbar/run': '755 r' })
    assert.deepEqual(installed[0], { path: 'vendor/drupal/admin_toolbar', name: 'drupal/admin_toolbar', version: '3.6.3', type: 'drupal-module', dev: false, url: DRUPAL, shasum: sha1(zip) })
    serve({ [DRUPAL]: rawZip([{ name: 'a', data: 'other' }]) })
    await assert.rejects(buildComposerTree({ ...project([pkg]), host: HOST }), (error) => error instanceof DeptreeError && error.where === 'packages["drupal/admin_toolbar"]' && /integrity mismatch/u.test(error.message))
  })

  it('installs into config.vendor-dir, under a target-dir', async () => {
    const client = github({ [`acme/lib@${SHA}`]: await archive({ 'a.php': 'a' }) })
    const pkg = { ...LIB, bin: undefined, 'target-dir': 'Acme/Lib' }
    const { vfs } = await buildComposerTree({ ...project([pkg], [], { 'vendor-dir': './lib/deps/' }), host: HOST, github: client })
    assert.deepEqual(Object.keys(listing(vfs)), ['lib', 'lib/deps', 'lib/deps/acme', 'lib/deps/acme/lib', 'lib/deps/acme/lib/Acme', 'lib/deps/acme/lib/Acme/Lib', 'lib/deps/acme/lib/Acme/Lib/a.php'])
    for (const dir of ['../vendor', '/abs', '~/v', '$HOME/v', 'a\\b', '', '.']) {
      await assert.rejects(buildComposerTree({ ...project([pkg], [], { 'vendor-dir': dir }), host: HOST, github: client }), { name: 'DeptreeError', where: 'composer.json: config.vendor-dir' }, dir)
    }
    await assert.rejects(buildComposerTree({ ...project([{ ...pkg, 'target-dir': 'A\\B' }]), host: HOST, github: client }), /target-dir "A\\\\B" is not supported/u)
  })

  it('refuses a package where Composer proxies the bins, bin-dir, on macOS by names as it takes them', async () => {
    const client = github({ [`acme/lib@${SHA}`]: await archive({ 'a.php': 'a' }) })
    const binned = (name, config, host = HOST) => buildComposerTree({ ...project([{ ...LIB, name, bin: undefined }], [], config), host, github: client })
    const refused = { name: 'DeptreeError', message: /a package installed where Composer proxies the bins, "vendor\/bin", is not supported/u }
    await assert.rejects(binned('bin/tool'), refused)
    await assert.rejects(binned('Bin/tool', undefined, { ...HOST, os: 'darwin' }), refused)
    assert.ok((await binned('Bin/tool')).vfs.isFile('/vendor/Bin/tool/a.php'))
    assert.ok((await binned('bin/tool', { 'bin-dir': 'tools' })).vfs.isFile('/vendor/bin/tool/a.php'))
    await assert.rejects(binned('acme/lib', { 'bin-dir': '{$vendor-dir}/acme/lib/bin' }), /proxies the bins, "vendor\/acme\/lib\/bin"/u)
    await assert.rejects(binned('acme/lib', { 'bin-dir': '{$home}/bin' }), { where: 'composer.json: config.bin-dir' })
  })

  it('refuses a package Composer would clone, by preferred-install or for want of a dist', async () => {
    const source = { type: 'git', url: 'https://github.com/acme/lib.git', reference: SHA }
    const client = github({ [`acme/lib@${SHA}`]: await archive({ 'a.php': 'a' }) })
    const pkg = { ...LIB, bin: undefined, source }
    const dev = { ...pkg, version: 'dev-main' }
    for (const [config, packages] of [[{ 'preferred-install': 'source' }, [pkg]], [{ 'preferred-install': 'auto' }, [dev]], [{ 'preferred-install': { 'ACME/*': 'source' } }, [pkg]], [{ 'preferred-install': { 'other/*': 'dist' } }, [dev]], [undefined, [{ ...pkg, dist: undefined }]]]) {
      await assert.rejects(buildComposerTree({ ...project(packages, [], config), host: HOST, github: client }), /packages\["acme\/lib"\]: a package installed from source, a git clone/u, JSON.stringify(config))
    }
    for (const config of [{ 'preferred-install': 'auto' }, { 'preferred-install': { 'acme/*': 'dist' } }, { 'preferred-install': { 'acme/*': 'auto' } }]) {
      await buildComposerTree({ ...project([pkg], [], config), host: HOST, github: client })
    }
    await assert.rejects(buildComposerTree({ ...project([pkg], [], { 'preferred-install': 'fast' }), host: HOST, github: client }), { where: 'composer.json: config.preferred-install' })
  })

  it('refuses a dist it cannot hold to anything, and one of another type', async () => {
    const cases = [
      [{ type: 'zip', url: 'https://example.com/a.zip', reference: SHA, shasum: '' }, /a dist from "https:\/\/example\.com\/a\.zip", with no shasum to hold it to, is not supported/u],
      [{ type: 'zip', url: 'https://example.com/a.zip', reference: SHA, shasum: 'c'.repeat(40) }, /only a release zip on ftp\.drupal\.org and GitHub's zipball of a commit are/u],
      [{ type: 'tar', url: 'https://example.com/a.tar', reference: SHA, shasum: 'c'.repeat(40) }, /a tar dist is not supported/u],
      [{ ...zipball('acme/lib'), mirrors: [{ url: 'https://mirror.example.com/%package%.zip', preferred: true }] }, /a preferred mirror/u],
    ]
    for (const [dist, message] of cases) {
      await assert.rejects(buildComposerTree({ ...project([{ ...LIB, dist }]), host: HOST, github: github({}) }), message)
    }
  })

  it('makes a bin executable through its links, but not a directory, and refuses a link that leads out of the package', async () => {
    const client = github({ [`acme/lib@${SHA}`]: await archive({ 'src/run': 'r', 'bin/run': { link: '../src/run' } }) })
    const { vfs } = await buildComposerTree({ ...project([{ ...LIB, bin: ['bin/run'] }]), host: HOST, github: client })
    assert.equal(vfs.lstat('/vendor/acme/lib/src/run').mode, 0o755)
    for (const files of [{ out: { link: '../x' } }, { 'd/': {}, 'd/up': { link: '../..' } }]) {
      const links = github({ [`acme/lib@${SHA}`]: await archive(files) })
      await assert.rejects(buildComposerTree({ ...project([{ ...LIB, bin: undefined }]), host: HOST, github: links }), /links out of the package, which is not supported/u, JSON.stringify(files))
    }
    const through = github({ [`acme/lib@${SHA}`]: await archive({ 'd/': {}, 'd/l': { link: '.' }, 'd/x': 'x', 'd/y/': {} }) })
    const { vfs: linked } = await buildComposerTree({ ...project([{ ...LIB, bin: ['d/l/l/x', 'd/l/y', 'd/x/'] }]), host: HOST, github: through })
    assert.equal(linked.lstat('/vendor/acme/lib/d/x').mode, 0o755)
  })

  it('refuses two packages\' bins of one name unless both are executable already', async () => {
    const other = { ...LIB, name: 'acme/other', dist: zipball('acme/other', SHA2), bin: ['tool'] }
    const lib = { ...LIB, bin: ['bin/tool'] }
    const clash = async (otherTool) => github({ [`acme/lib@${SHA}`]: await archive({ 'bin/tool': { exec: 't' } }), [`acme/other@${SHA2}`]: await archive({ tool: otherTool }) })
    await assert.rejects(buildComposerTree({ ...project([lib, other]), host: HOST, github: await clash('t') }), /"acme\/lib" and "acme\/other" each have a bin named "tool"/u)
    const { vfs } = await buildComposerTree({ ...project([lib, other]), host: HOST, github: await clash({ exec: 't' }) })
    assert.equal(vfs.lstat('/vendor/acme/other/tool').mode, 0o755)
  })

  it('reads composer.json and composer.lock from a project, and mounts into a Vfs without a vendor directory', async () => {
    const files = project([{ ...LIB, bin: undefined }])
    const client = github({ [`acme/lib@${SHA}`]: await archive({ 'a.php': 'a' }) })
    const vfs = new Vfs()
    vfs.writeFile('/composer.json', files.composerJson)
    vfs.writeFile('/composer.lock', files.lockfile)
    const built = await buildComposerTree({ project: vfs, host: HOST, github: client, vfs })
    assert.equal(built.vfs, vfs)
    assert.equal(vfs.readText('/vendor/acme/lib/a.php'), 'a')
    await assert.rejects(buildComposerTree({ project: vfs, host: HOST, github: client, vfs }), { where: 'vfs["/vendor"]' })
    const folded = new Vfs()
    folded.mkdir('/Vendor')
    await assert.rejects(buildComposerTree({ ...files, host: { ...HOST, os: 'darwin' }, github: client, vfs: folded }), { where: 'vfs["/Vendor"]' })
    const empty = new Vfs()
    await assert.rejects(buildComposerTree({ project: empty, host: HOST, github: client }), /the project has no composer\.json/u)
  })

  it('refuses a lockfile the reader refuses, and hosts and options it does not take', async () => {
    const files = project([{ ...LIB, bin: undefined }])
    await assert.rejects(buildComposerTree({ ...files, lockfile: files.lockfile.replace('"1.0.0"', '"one"'), host: HOST }), LockfileError)
    for (const [host, where] of [[{ ...HOST, composer: '2.1.14' }, 'host.composer'], [{ ...HOST, composer: '2.11.0' }, 'host.composer'], [{ ...HOST, os: 'win32' }, 'host.os'], [{ ...HOST, unzip: false }, 'host.unzip']]) {
      await assert.rejects(buildComposerTree({ ...files, host }), { name: 'DeptreeError', where })
    }
    for (const options of [{ ...files }, { ...files, host: { ...HOST, unzip: 'yes' } }, { ...files, host: HOST, github: {} }, { lockfile: files.lockfile, host: HOST }, { ...files, host: HOST, vfs: {} }]) {
      await assert.rejects(buildComposerTree(options), TypeError)
    }
  })
})
