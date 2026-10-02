import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { Vfs } from '@preventive/vfs'
import { DeptreeError, LockfileError, buildNpmTree, findNpmWorkspaces } from '../npm.js'
import { sri, stubRegistry, tarball, url } from './registry.js'

// A small project whose lockfile npm's own Arborist wrote, and whose tree
// real npm 11.12.1 and 10.9.9 installed with `npm ci --ignore-scripts` as
// the first tests expect, from the tarballs made here; then one change at
// a time, each refused with where and why.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const HOST = Object.freeze({ npm: '11.12.1', node: '24.15.0', os: 'linux', cpu: 'x64', libc: 'glibc' })
const NPM10 = Object.freeze({ ...HOST, npm: '10.9.9' })

const TARBALLS = await Promise.all([
  tarball('a', '1.0.0', { 'bin/a.js': '#!/usr/bin/env node\r\nconsole.log(1)\r\n', 'x.sh': { data: 'x', mode: 0o700 }, '.gitignore': 'ignored\n' }, { manifest: { dependencies: { b: '^1.0.0' }, bin: { a: 'bin/a.js' } } }),
  tarball('a', '2.0.0', { 'a.js': '#!/bin/sh\n' }, { manifest: { bin: { a: 'a.js' } } }),
  tarball('b', '1.0.0', { 'index.js': 'b' }),
  tarball('c', '1.0.0', { 'index.js': 'c' }),
  tarball('d', '1.0.0', { 'cli.js': { data: 'd', mode: 0o600 } }, { manifest: { bin: { same: 'cli.js' } } }),
  tarball('@s/same', '1.0.0', { 'cli.js': { data: 's', mode: 0o600 } }, { manifest: { bin: { same: 'cli.js' } } }),
  tarball('mac', '1.0.0', {}, { manifest: { os: ['darwin'], dependencies: { '@m/dep': '1.0.0' } } }),
  tarball('@m/dep', '1.0.0'),
])
const T = Object.fromEntries(TARBALLS.map((t) => [`${t.name}@${t.version}`, t]))

const ROOT = { name: 'proj', version: '1.0.0', workspaces: ['packages/*'], dependencies: { a: '^1.0.0', '@s/same': '1.0.0', x: 'npm:c@1.0.0' }, devDependencies: { d: '1.0.0' }, optionalDependencies: { mac: '1.0.0' } }
const WORKSPACE = { name: 'w', version: '1.0.0', dependencies: { a: '^2.0.0' } }

const entry = (id, rest = {}) => {
  const { name, version, integrity } = T[id]
  return { version, resolved: url(name, version), integrity, ...rest }
}

// As npm writes it: scalars before mappings, each in npm's order.
function LOCK() {
  return {
    name: 'proj',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'proj', version: '1.0.0', workspaces: ['packages/*'], dependencies: ROOT.dependencies, devDependencies: ROOT.devDependencies, optionalDependencies: ROOT.optionalDependencies },
      'node_modules/@m/dep': entry('@m/dep@1.0.0', { optional: true }),
      'node_modules/@s/same': entry('@s/same@1.0.0', { bin: { same: 'cli.js' } }),
      'node_modules/a': entry('a@1.0.0', { dependencies: { b: '^1.0.0' }, bin: { a: 'bin/a.js' } }),
      'node_modules/b': entry('b@1.0.0'),
      'node_modules/d': entry('d@1.0.0', { dev: true, bin: { same: 'cli.js' } }),
      'node_modules/mac': entry('mac@1.0.0', { optional: true, os: ['darwin'], dependencies: { '@m/dep': '1.0.0' } }),
      'node_modules/w': { resolved: 'packages/w', link: true },
      'node_modules/x': { name: 'c', ...entry('c@1.0.0') },
      'packages/w': { version: '1.0.0', dependencies: { a: '^2.0.0' } },
      'packages/w/node_modules/a': entry('a@2.0.0', { bin: { a: 'a.js' } }),
    },
  }
}

const write = (lock) => `${JSON.stringify(lock, null, 2)}\n`
const json = (value) => JSON.stringify(value, null, 2)

function given({ lock = LOCK(), root = ROOT, workspace = WORKSPACE, npmrc, host = HOST, ...rest } = {}) {
  return { lockfile: write(lock), manifests: { '.': json(root), 'packages/w': json(workspace) }, npmrc, host, ...rest }
}

const latin1 = new TextDecoder('latin1')

// Each entry under a node_modules: a directory and its mode, a file, its
// mode and text, or a link and where it leads.
function listing(vfs) {
  const out = []
  for (const { path, type } of vfs.walk('/')) {
    if (!path.includes('node_modules')) continue
    const mode = (vfs.lstat(path).mode & 0o777).toString(8)
    if (type === 'directory') out.push(`${path.slice(1)}/ ${mode}`)
    else if (type === 'symlink') out.push(`${path.slice(1)} -> ${vfs.readlink(path)}`)
    else out.push(`${path.slice(1)} ${mode} ${JSON.stringify(latin1.decode(vfs.readFile(path)))}`)
  }
  return out.sort()
}

// What npm 11.12.1 wrote, .bin and .package-lock.json aside.
const NPM_11 = [
  'node_modules/ 755',
  'node_modules/@s/ 755',
  'node_modules/@s/same/ 755',
  'node_modules/@s/same/cli.js 755 "s"',
  'node_modules/@s/same/package.json 644 "{\\"name\\":\\"@s/same\\",\\"version\\":\\"1.0.0\\",\\"bin\\":{\\"same\\":\\"cli.js\\"}}"',
  'node_modules/a/ 755',
  'node_modules/a/.npmignore 644 "ignored\\n"',
  'node_modules/a/bin/ 755',
  'node_modules/a/bin/a.js 755 "#!/usr/bin/env node\\nconsole.log(1)\\r\\n"',
  'node_modules/a/package.json 644 "{\\"name\\":\\"a\\",\\"version\\":\\"1.0.0\\",\\"dependencies\\":{\\"b\\":\\"^1.0.0\\"},\\"bin\\":{\\"a\\":\\"bin/a.js\\"}}"',
  'node_modules/a/x.sh 744 "x"',
  'node_modules/b/ 755',
  'node_modules/b/index.js 644 "b"',
  'node_modules/b/package.json 644 "{\\"name\\":\\"b\\",\\"version\\":\\"1.0.0\\"}"',
  'node_modules/d/ 755',
  'node_modules/d/cli.js 644 "d"',
  'node_modules/d/package.json 644 "{\\"name\\":\\"d\\",\\"version\\":\\"1.0.0\\",\\"bin\\":{\\"same\\":\\"cli.js\\"}}"',
  'node_modules/w -> ../packages/w',
  'node_modules/x/ 755',
  'node_modules/x/index.js 644 "c"',
  'node_modules/x/package.json 644 "{\\"name\\":\\"c\\",\\"version\\":\\"1.0.0\\"}"',
  'packages/w/node_modules/ 755',
  'packages/w/node_modules/a/ 755',
  'packages/w/node_modules/a/a.js 755 "#!/bin/sh\\n"',
  'packages/w/node_modules/a/package.json 644 "{\\"name\\":\\"a\\",\\"version\\":\\"2.0.0\\",\\"bin\\":{\\"a\\":\\"a.js\\"}}"',
]

const refuses = async (options, message, where, type = DeptreeError) => {
  await assert.rejects(buildNpmTree(options), (error) => {
    assert.ok(error instanceof type, error.stack)
    assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
    assert.equal(error.where, where)
    return true
  })
}

describe('the tree npm installs', () => {
  it('as npm 11.12.1 installs it', async () => {
    stubRegistry(TARBALLS)
    const { vfs, stats, installed } = await buildNpmTree(given())
    assert.deepEqual(listing(vfs), NPM_11)
    assert.deepEqual(stats, { packages: 8, installed: 6, skipped: 2, tarballs: 6, files: 14, bytes: stats.bytes, links: 1 })
    assert.deepEqual(installed.map(({ path, name, version, dev, optional, devOptional, peer }) => [path, `${name}@${version}`, dev, optional, devOptional, peer]), [
      ['node_modules/@s/same', '@s/same@1.0.0', false, false, false, false],
      ['node_modules/a', 'a@1.0.0', false, false, false, false],
      ['node_modules/b', 'b@1.0.0', false, false, false, false],
      ['node_modules/d', 'd@1.0.0', true, false, true, false],
      ['node_modules/x', 'c@1.0.0', false, false, false, false],
      ['packages/w/node_modules/a', 'a@2.0.0', false, false, false, false],
    ])
    assert.equal(installed.find(({ path }) => path === 'node_modules/a').integrity, T['a@1.0.0'].integrity)
  })

  it('as npm 10.9.9 installs it, the scope of what it left out made', async () => {
    stubRegistry(TARBALLS)
    const { vfs } = await buildNpmTree(given({ host: NPM10 }))
    assert.deepEqual(listing(vfs), [...NPM_11, 'node_modules/@m/ 755'].sort())
  })
})

describe('read from a project', () => {
  const project = (files = {}) => {
    const vfs = new Vfs()
    const all = { 'package.json': json(ROOT), 'packages/w/package.json': json(WORKSPACE), 'package-lock.json': write(LOCK()), ...files }
    for (const [path, text] of Object.entries(all)) {
      if (text === undefined) continue
      vfs.mkdir(`/${path.split('/').slice(0, -1).join('/')}`, { recursive: true })
      vfs.writeFile(`/${path}`, text)
    }
    return vfs
  }

  it('as given, the tree mounted beside it', async () => {
    stubRegistry(TARBALLS)
    const vfs = project()
    assert.deepEqual(findNpmWorkspaces({ project: vfs }), ['.', 'packages/w'])
    const tree = await buildNpmTree({ project: vfs, host: HOST, vfs })
    assert.equal(tree.vfs, vfs)
    assert.deepEqual(listing(vfs), NPM_11)
    assert.equal(vfs.readText('/packages/w/package.json'), json(WORKSPACE))
  })

  it('refused: a shrinkwrap, no lockfile, a workspace the lockfile lacks, a link the globs reach', async () => {
    await refuses({ project: project({ 'npm-shrinkwrap.json': '{}' }), host: HOST }, 'an npm-shrinkwrap.json, which npm reads in place of package-lock.json, is not supported', 'npm-shrinkwrap.json')
    await refuses({ project: project({ 'package-lock.json': undefined }), host: HOST }, 'the project has no package-lock.json, which npm ci cannot do without')
    await refuses({ project: project({ 'packages/v/package.json': json({ name: 'v', version: '1.0.0' }) }), host: HOST }, 'asks for "v" as workspace "file:packages/v", and the lockfile as nothing, which npm ci refuses or resolves again', 'manifests["."]')
    const linked = project()
    linked.symlink('w', '/packages/u')
    await refuses({ project: linked, host: HOST }, 'a link where npm looks for workspaces is not supported', '"packages/u"')
  })

  it('not given with it', async () => {
    await assert.rejects(buildNpmTree({ project: project(), lockfile: write(LOCK()), host: HOST }), { name: 'TypeError', message: 'project must be left out where lockfile is given' })
    await assert.rejects(buildNpmTree({ project: project(), npmrc: '', host: HOST }), { name: 'TypeError', message: 'npmrc must be left out where lockfile is: both are read from project' })
    await assert.rejects(buildNpmTree({ host: HOST }), { name: 'TypeError', message: 'lockfile must be the text of package-lock.json, or left out with a project given to read it from' })
  })
})

describe('the host', () => {
  it('an npm supported, Linux with its libc, no Windows', async () => {
    await refuses(given({ host: { ...HOST, npm: '9.9.4' } }), 'npm "9.9.4" is not supported: only 10.9.9, and 11.12.0 to 11.21.0', 'host.npm')
    await refuses(given({ host: { ...HOST, os: 'win32', libc: undefined } }), 'Windows is not supported: npm links bins there with shims, and workspaces with junctions', 'host.os')
    await refuses(given({ host: { ...HOST, node: '24' } }), '"24" is not an exact version', 'host.node')
    await assert.rejects(buildNpmTree(given({ host: { ...HOST, libc: undefined } })), { name: 'TypeError', message: 'host.libc must be glibc or musl on Linux' })
    await assert.rejects(buildNpmTree(given({ host: { ...HOST, os: 'darwin' } })), { name: 'TypeError', message: 'host.libc must be left out but on Linux' })
  })

  it('on macOS, the optional package installed', async () => {
    stubRegistry(TARBALLS)
    const { vfs, stats } = await buildNpmTree(given({ host: { ...HOST, os: 'darwin', libc: undefined } }))
    assert.equal(stats.skipped, 0)
    assert.deepEqual(listing(vfs).filter((line) => line.startsWith('node_modules/mac') || line.startsWith('node_modules/@m')), [
      'node_modules/@m/ 755',
      'node_modules/@m/dep/ 755',
      'node_modules/@m/dep/package.json 644 "{\\"name\\":\\"@m/dep\\",\\"version\\":\\"1.0.0\\"}"',
      'node_modules/mac/ 755',
      'node_modules/mac/package.json 644 "{\\"name\\":\\"mac\\",\\"version\\":\\"1.0.0\\",\\"os\\":[\\"darwin\\"],\\"dependencies\\":{\\"@m/dep\\":\\"1.0.0\\"}}"',
    ])
  })

  it('a platform or engines the root and workspaces ask for', async () => {
    await refuses(given({ root: { ...ROOT, os: ['darwin'] } }), 'its os, "[\\"darwin\\"]", is not the host\'s, which npm fails on', 'manifests["."]')
    await refuses(given({ workspace: { ...WORKSPACE, libc: 'musl' } }), 'its libc, "\\"musl\\"", is not the host\'s, which npm fails on', 'manifests["packages/w"]')
    stubRegistry(TARBALLS)
    await buildNpmTree(given({ workspace: { ...WORKSPACE, engines: { node: '<10' } } }))
    await refuses(given({ workspace: { ...WORKSPACE, engines: { node: '<10' } }, npmrc: 'engine-strict=true\n' }), 'its engines.node, "<10", does not take Node 24.15.0, which npm fails on with engine-strict', 'manifests["packages/w"]')
  })

  it('the root\'s devEngines', async () => {
    const dev = (devEngines, host) => given({ root: { ...ROOT, devEngines }, host })
    stubRegistry(TARBALLS)
    await buildNpmTree(dev({ runtime: { name: 'node', version: '>=24' }, packageManager: [{ name: 'yarn' }, { name: 'npm', version: '11.12.1' }], os: { name: 'darwin', onFail: 'warn' } }))
    await refuses(dev({ runtime: { name: 'node', version: '<24' } }), 'the host\'s runtime is not one it takes, which npm fails on', 'manifests["."].devEngines.runtime')
    await refuses(dev({ os: { name: 'linux', version: '>=6' } }), 'a version of the os, which npm takes from the kernel, is not known here', 'manifests["."].devEngines.os')
    await refuses(dev({ libc: { name: 'glibc' } }, { ...HOST, os: 'darwin', libc: undefined }), 'the host has none, which npm fails on', 'manifests["."].devEngines.libc')
    await refuses(dev({ editor: { name: 'vim' } }), '"editor" is not an engine npm knows, which it fails on', 'manifests["."].devEngines')
    await refuses(dev({ cpu: { name: 'x64', arch: 'x' } }), '"arch" is not a field npm knows, which npm fails on', 'manifests["."].devEngines.cpu')
  })
})

describe('the .npmrc', () => {
  it('bin-links=false leaves every bin as it is unpacked', async () => {
    stubRegistry(TARBALLS)
    const { vfs } = await buildNpmTree(given({ npmrc: 'bin-links=false\n' }))
    assert.equal(latin1.decode(vfs.readFile('/node_modules/a/bin/a.js')), '#!/usr/bin/env node\r\nconsole.log(1)\r\n')
    assert.equal(vfs.lstat('/node_modules/a/bin/a.js').mode & 0o777, 0o644)
    assert.equal(vfs.lstat('/node_modules/@s/same/cli.js').mode & 0o777, 0o644)
  })

  it('passed over where it changes nothing', async () => {
    stubRegistry(TARBALLS)
    const npmrc = '; comment\n# comment\nfund=false\naudit=false\ninstall-strategy=hoisted\nlockfile-version=3\n//registry.npmjs.org/:_authToken=${TOKEN}\n@s:registry=https://example.com/\nlegacy-peer-deps=false\nengine-strict=true\n'
    assert.deepEqual(listing((await buildNpmTree(given({ npmrc }))).vfs), NPM_11)
  })

  it('refused where it may change the tree, or read otherwise', async () => {
    await refuses(given({ npmrc: 'omit=dev\n' }), '"omit" is a setting not supported here: it may change what npm installs', '.npmrc:1')
    await refuses(given({ npmrc: '\n_authToken=x\n' }), '"_authToken" is a setting not supported here: it may change what npm installs', '.npmrc:2')
    await refuses(given({ npmrc: 'bin-links=0\n' }), 'expected true or false for "bin-links"', '.npmrc:1')
    await refuses(given({ npmrc: 'bin-links="false"\n' }), 'expected true or false for "bin-links"', '.npmrc:1')
    await refuses(given({ npmrc: 'install-strategy=nested\n' }), 'expected hoisted for "install-strategy"', '.npmrc:1')
    await refuses(given({ npmrc: 'force[]=false\n' }), 'expected false for "force"', '.npmrc:1')
    await refuses(given({ npmrc: '"omit"=dev\n' }), '"\\"omit\\"" is quoted, escaped, commented or taken from the environment, which is not read here', '.npmrc:1')
    await refuses(given({ npmrc: '${KEY}=true\n' }), '"${KEY}" is quoted, escaped, commented or taken from the environment, which is not read here', '.npmrc:1')
    await refuses(given({ npmrc: 'save-dev=true\nsave-prod=false\n' }), '"save-dev" and "save-prod" are both set, which npm fails on', '.npmrc')
    await refuses(given({ npmrc: '[section]\nx=1\n' }), 'a section is not supported', '.npmrc:1')
  })

  it('legacy-peer-deps, with which npm loads no peer', async () => {
    const lock = LOCK()
    lock.packages['node_modules/b'].peerDependencies = { nowhere: '1.0.0' }
    await refuses(given({ lock }), '"1.0.0" is met by nothing where npm looks for "nowhere", so npm would install it', 'packages["node_modules/b"].peerDependencies.nowhere', LockfileError)
    stubRegistry(TARBALLS)
    assert.deepEqual(listing((await buildNpmTree(given({ lock, npmrc: 'legacy-peer-deps=true\n' }))).vfs), NPM_11)
  })
})

describe('the project held to the lockfile', () => {
  it('each package.json asks for what the lockfile does', async () => {
    await refuses(given({ root: { ...ROOT, dependencies: { ...ROOT.dependencies, a: '^1.0.1' } } }), 'asks for "a" as prod "^1.0.1", and the lockfile as prod "^1.0.0", which npm ci refuses or resolves again', 'manifests["."]')
    await refuses(given({ workspace: { ...WORKSPACE, devDependencies: { b: '1.0.0' } } }), 'asks for "b" as dev "1.0.0", and the lockfile as nothing, which npm ci refuses or resolves again', 'manifests["packages/w"]')
    await refuses(given({ root: { ...ROOT, dependencies: [] } }), 'expected a mapping of names to specs, which npm fails without', 'manifests["."].dependencies')
  })

  it('each workspace its name and version', async () => {
    await refuses(given({ workspace: { ...WORKSPACE, version: '1.0.1' } }), 'is "1.0.1", and the lockfile has "1.0.0", which npm ci refuses', 'manifests["packages/w"].version')
    await refuses({ ...given(), manifests: { '.': json(ROOT) } }, 'a workspace of the lockfile npm does not find', 'manifests["packages/w"]')
  })

  it('refused: overrides, acceptDependencies', async () => {
    await refuses(given({ root: { ...ROOT, overrides: { b: '1.0.0' } } }), 'overrides, which change what npm asks for, are not supported', 'manifests["."].overrides')
    stubRegistry(TARBALLS)
    await buildNpmTree(given({ root: { ...ROOT, overrides: {} } }))
    await refuses(given({ workspace: { ...WORKSPACE, acceptDependencies: {} } }), 'acceptDependencies, which npm reads otherwise for devDependencies, is not supported', 'manifests["packages/w"].acceptDependencies')
  })
})

describe('the packages', () => {
  const swapped = (location, change) => {
    const lock = LOCK()
    change(lock.packages[location])
    return given({ lock })
  }

  it('from the registry alone', async () => {
    await refuses(swapped('node_modules/b', (b) => (b.resolved = 'https://example.com/b-1.0.0.tgz')), 'only the registry\'s own tarball of b@1.0.0, https://registry.npmjs.org/b/-/b-1.0.0.tgz, is supported', 'packages["node_modules/b"]')
    await refuses(swapped('node_modules/b', (b) => delete b.resolved), 'a package with no resolved URL, which npm fetches by the registry\'s packument, whose bins it makes executable, is not supported', 'packages["node_modules/b"]')
    await refuses(swapped('node_modules/b', (b) => (b.integrity = 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=')), 'a tarball with no sha512 integrity is not supported', 'packages["node_modules/b"]')
    stubRegistry(TARBALLS)
    const mirrored = swapped('node_modules/@s/same', (s) => (s.resolved = 'https://registry.yarnpkg.com/@s%2fsame/-/same-1.0.0.tgz'))
    assert.deepEqual(listing((await buildNpmTree(mirrored)).vfs), NPM_11)
  })

  it('refused: a link but to a workspace, one elsewhere', async () => {
    const lock = LOCK()
    lock.packages['node_modules/b'] = { resolved: 'node_modules/x', link: true }
    await refuses(given({ lock }), 'a link to a package is not supported', 'packages["node_modules/b"]')
  })

  const one = async (files, manifest = {}, top = 'package') => {
    const t = await tarball('b', '1.0.0', files, { manifest, top })
    const lock = LOCK()
    Object.assign(lock.packages['node_modules/b'], { integrity: t.integrity }, manifest.bin === undefined ? {} : { bin: manifest.bin })
    stubRegistry([...TARBALLS.filter(({ name }) => name !== 'b'), t])
    return given({ lock })
  }

  it('unpacked as npm\'s tar unpacks it', async () => {
    const options = await one({ 'run.sh': { data: 'r', mode: 0o751 }, 'ro.txt': { data: 'o', mode: 0o400 }, '.npmignore': 'n', '.gitignore': 'g', 'lib/.gitignore': { data: 'l', mode: 0o700 } })
    const { vfs } = await buildNpmTree(options)
    assert.deepEqual(listing(vfs).filter((line) => line.startsWith('node_modules/b/')), [
      'node_modules/b/ 755',
      'node_modules/b/.npmignore 644 "n"',
      'node_modules/b/lib/ 755',
      'node_modules/b/lib/.npmignore 744 "l"',
      'node_modules/b/package.json 644 "{\\"name\\":\\"b\\",\\"version\\":\\"1.0.0\\"}"',
      'node_modules/b/ro.txt 644 "o"',
      'node_modules/b/run.sh 755 "r"',
    ])
  })

  it('refused: what npm never packs', async () => {
    await refuses(await one({ 'x.js': { data: 'x', mode: 0o4755 } }), '"package/x.js" has a setuid, setgid or sticky bit, which is not supported', 'packages["node_modules/b"]')
    await refuses(await one({ 'node_modules/y/index.js': 'y' }), '"package/node_modules/y/index.js" is in the package\'s own node_modules, where npm installs its dependencies, which is not supported', 'packages["node_modules/b"]')
    const split = await compress(pack([{ name: 'package/package.json', data: new TextEncoder().encode('{}') }, { name: 'other/x', data: new Uint8Array(1) }]), 'gzip')
    const lock = LOCK()
    lock.packages['node_modules/b'].integrity = sri(split)
    stubRegistry([...TARBALLS.filter(({ name }) => name !== 'b'), { name: 'b', version: '1.0.0', bytes: split }])
    await refuses(given({ lock }), 'the tarball has entries under more than one directory', 'packages["node_modules/b"]')
  })

  it('refused: bins npm fails on, or does not leave as here', async () => {
    await refuses(await one({ 'b.js': 'x' }, { bin: { b: 'b.js/x' } }), '"b.js/x" runs through a file, which npm fails on', 'packages["node_modules/b"].bin')
    await refuses(await one({ 'lib/x.js': 'x' }, { bin: { b: 'lib' } }), '"lib" is a directory, which is not supported', 'packages["node_modules/b"].bin')
    await refuses(await one({}, { bin: { b: 'node_modules/c/c.js' } }), '"node_modules/c/c.js" is in the package\'s own node_modules, where npm installs its dependencies, which is not supported', 'packages["node_modules/b"].bin')
    await refuses(await one({ 'b.js': { data: new Uint8Array([0x23, 0x21, 0x78, 0x0d, 0x0a, 0xff]) } }, { bin: { b: 'b.js' } }), 'a bin with a CRLF shebang that is not UTF-8, which npm rewrites with replacement characters, is not supported', 'packages["node_modules/b"].bin')
  })

  it('a tarball npm 10.9.9\'s tar gives up on', async () => {
    const options = await one({ zeros: { data: new Uint8Array(4 * 1024 * 1024) } })
    await assert.rejects(buildNpmTree({ ...options, host: NPM10 }), { name: 'DeptreeError', where: 'packages["node_modules/b"]', message: /^packages\["node_modules\/b"\]: the tarball inflates \d+ times its first \d+ bytes, past what npm's tar gives up at$/u })
    await buildNpmTree(options)
  })
})

describe('the Vfs mounted into', () => {
  it('none of a node_modules there, before anything is fetched', async () => {
    const vfs = new Vfs()
    vfs.mkdir('/packages/w/node_modules', { recursive: true })
    const calls = stubRegistry(TARBALLS)
    await refuses(given({ vfs }), 'a node_modules is there already, which is neither kept beside the tree nor removed', 'vfs["/packages/w/node_modules"]')
    assert.deepEqual(calls, [])
  })
})
