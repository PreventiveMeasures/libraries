import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { DeptreeError, buildPnpmTree } from '../pnpm.js'
import { buildNpmTree } from '../npm.js'
import { buildYarn1Tree } from '../yarn1.js'
import { HOST, stubRegistry, tarball, url } from './registry.js'

// `production`: trees of the shapes real installs made with pnpm 9.15.9,
// 10.33.4, 11.28.6, 11.28.9, 12.14.0, 12.15.0 and 12.16.1 `install --prod`,
// npm 10.9.9 and 11.12.1 `ci --omit=dev`, and yarn 1.22.22 `install
// --production`, each from a lockfile that pnpm, npm or yarn wrote for them,
// from the tarballs made here.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// Each link and where it leads, and each directory a package.json or
// nothing is in, as the real installs were listed.
function layout(vfs) {
  const out = []
  for (const { path, type } of vfs.walk('/')) {
    if (type === 'symlink') out.push(`${path.slice(1)} -> ${vfs.readlink(path)}`)
    else if (type === 'directory' && vfs.isFile(`${path}/package.json`)) out.push(`${path.slice(1)}/`)
    else if (type === 'directory' && path !== '/' && vfs.readdir(path).length === 0) out.push(`${path.slice(1)}/ (empty)`)
  }
  return out.sort()
}

const PNPM_TARBALLS = await Promise.all([
  tarball('debug', '4.3.7', {}, { manifest: { dependencies: { ms: '^2.1.3' }, peerDependenciesMeta: { 'supports-color': { optional: true } } } }),
  tarball('has-flag', '4.0.0'),
  tarball('is-number', '6.0.0'),
  tarball('is-number', '7.0.0'),
  tarball('is-odd', '3.0.1', {}, { manifest: { dependencies: { 'is-number': '^6.0.0' } } }),
  tarball('ms', '2.1.3'),
  tarball('supports-color', '8.1.1', {}, { manifest: { dependencies: { 'has-flag': '^4.0.0' } } }),
  tarball('ajv', '8.17.1'),
  tarball('ajv-formats', '3.0.1', {}, { manifest: { dependencies: { ajv: '^8.0.0' }, peerDependencies: { ajv: '^8.0.0' }, peerDependenciesMeta: { ajv: { optional: true } } } }),
])

describe('buildPnpmTree with production', () => {
  const I = Object.fromEntries(PNPM_TARBALLS.map((t) => [`${t.name}@${t.version}`, t.integrity]))
  const packages = (keys, extra = {}) => keys.map((key) => `  ${key}:\n    resolution: {integrity: ${I[key]}}\n${extra[key] ?? ''}`).join('\n')
  const head = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n"

  // debug's optional peer supports-color is the root's devDependency, as is
  // a version of is-number that is-odd needs another of.
  const DEBUG_ROOT = '    dependencies:\n      debug:\n        specifier: 4.3.7\n        version: 4.3.7(supports-color@8.1.1)\n      is-odd:\n        specifier: 3.0.1\n        version: 3.0.1\n    devDependencies:\n      is-number:\n        specifier: 7.0.0\n        version: 7.0.0\n      supports-color:\n        specifier: 8.1.1\n        version: 8.1.1\n'
  const DEBUG_PACKAGES = `packages:\n\n${packages(['debug@4.3.7', 'has-flag@4.0.0', 'is-number@6.0.0', 'is-number@7.0.0', 'is-odd@3.0.1', 'ms@2.1.3', 'supports-color@8.1.1'], { 'debug@4.3.7': "    peerDependencies:\n      supports-color: '*'\n    peerDependenciesMeta:\n      supports-color:\n        optional: true\n" })}`
  const DEBUG_SNAPSHOTS = 'snapshots:\n\n  debug@4.3.7(supports-color@8.1.1):\n    dependencies:\n      ms: 2.1.3\n    optionalDependencies:\n      supports-color: 8.1.1\n\n  has-flag@4.0.0: {}\n\n  is-number@6.0.0: {}\n\n  is-number@7.0.0: {}\n\n  is-odd@3.0.1:\n    dependencies:\n      is-number: 6.0.0\n\n  ms@2.1.3: {}\n\n  supports-color@8.1.1:\n    dependencies:\n      has-flag: 4.0.0\n'
  const DEBUG = `${head}  .:\n${DEBUG_ROOT}\n${DEBUG_PACKAGES}\n${DEBUG_SNAPSHOTS}`
  const ROOT = JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { debug: '4.3.7', 'is-odd': '3.0.1' }, devDependencies: { 'is-number': '7.0.0', 'supports-color': '8.1.1' } })

  const build = (pnpm, options = {}) => {
    stubRegistry(PNPM_TARBALLS)
    return buildPnpmTree({ lockfile: DEBUG, manifests: { '.': ROOT }, host: { ...HOST, pnpm }, production: true, ...options })
  }

  // What pnpm 10.33.4 and 9.15.9 installed: supports-color with what it
  // needs, as debug reaches it.
  const STORE = [
    'node_modules/.pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/debug/',
    'node_modules/.pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/ms -> ../../ms@2.1.3/node_modules/ms',
    'node_modules/.pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/supports-color -> ../../supports-color@8.1.1/node_modules/supports-color',
    'node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/',
    'node_modules/.pnpm/is-number@6.0.0/node_modules/is-number/',
    'node_modules/.pnpm/is-odd@3.0.1/node_modules/is-number -> ../../is-number@6.0.0/node_modules/is-number',
    'node_modules/.pnpm/is-odd@3.0.1/node_modules/is-odd/',
    'node_modules/.pnpm/ms@2.1.3/node_modules/ms/',
    'node_modules/.pnpm/supports-color@8.1.1/node_modules/has-flag -> ../../has-flag@4.0.0/node_modules/has-flag',
    'node_modules/.pnpm/supports-color@8.1.1/node_modules/supports-color/',
    'node_modules/debug -> .pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/debug',
    'node_modules/is-odd -> .pnpm/is-odd@3.0.1/node_modules/is-odd',
  ]
  const hoisted = (...aliases) => aliases.map((alias) => `node_modules/.pnpm/node_modules/${alias} -> ../${{ 'has-flag': 'has-flag@4.0.0', 'is-number': 'is-number@6.0.0', ms: 'ms@2.1.3', 'supports-color': 'supports-color@8.1.1' }[alias]}/node_modules/${alias}`)

  it('leaves out each project\'s devDependencies, and what only they reach', async () => {
    const { vfs, installed, stats } = await build('10.33.4')
    assert.deepEqual(layout(vfs), [...STORE, ...hoisted('has-flag', 'is-number', 'ms', 'supports-color')].sort())
    assert.deepEqual(installed.map(({ key, dev }) => [key, dev]), [['debug@4.3.7(supports-color@8.1.1)', false], ['has-flag@4.0.0', false], ['is-number@6.0.0', false], ['is-odd@3.0.1', false], ['ms@2.1.3', false], ['supports-color@8.1.1', false]])
    assert.deepEqual([stats.snapshots, stats.installed, stats.skipped, stats.tarballs], [7, 6, 0, 6])
    const full = await build('10.33.4', { production: false })
    assert.ok(full.vfs.isDirectory('/node_modules/.pnpm/is-number@7.0.0/node_modules/is-number'))
    assert.equal(full.vfs.readlink('/node_modules/is-number'), '.pnpm/is-number@7.0.0/node_modules/is-number')
  })

  it('keeps from hoisting, for pnpm 9, each name the root\'s specifiers have', async () => {
    const { vfs } = await build('9.15.9')
    assert.deepEqual(layout(vfs), [...STORE, ...hoisted('has-flag', 'ms')].sort())
  })

  // From pnpm 11.28 and in pnpm 12, supports-color is only there for an
  // optional peer of debug, which the root lists among its devDependencies.
  for (const pnpm of ['11.28.9', '12.8.1', '12.16.1']) {
    it(`leaves out, for pnpm ${pnpm}, a devDependency only there to satisfy an optional peer`, async () => {
      const { vfs, installed } = await build(pnpm)
      assert.deepEqual(layout(vfs), [
        'node_modules/.pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/debug/',
        'node_modules/.pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/ms -> ../../ms@2.1.3/node_modules/ms',
        'node_modules/.pnpm/is-number@6.0.0/node_modules/is-number/',
        'node_modules/.pnpm/is-odd@3.0.1/node_modules/is-number -> ../../is-number@6.0.0/node_modules/is-number',
        'node_modules/.pnpm/is-odd@3.0.1/node_modules/is-odd/',
        'node_modules/.pnpm/ms@2.1.3/node_modules/ms/',
        ...hoisted('is-number', 'ms'),
        'node_modules/debug -> .pnpm/debug@4.3.7_supports-color@8.1.1/node_modules/debug',
        'node_modules/is-odd -> .pnpm/is-odd@3.0.1/node_modules/is-odd',
      ].sort())
      assert.deepEqual(installed.map(({ key }) => key), ['debug@4.3.7(supports-color@8.1.1)', 'is-number@6.0.0', 'is-odd@3.0.1', 'ms@2.1.3'])
    })
  }

  // ajv-formats asks for ajv as its own dependency and as an optional peer,
  // which it resolved as its own: the root has it only by another alias.
  const AJV = `${head}  .:\n    dependencies:\n      ajv-formats:\n        specifier: 3.0.1\n        version: 3.0.1\n    devDependencies:\n      my-ajv:\n        specifier: npm:ajv@8.17.1\n        version: ajv@8.17.1\n\npackages:\n\n${packages(['ajv-formats@3.0.1', 'ajv@8.17.1'], { 'ajv-formats@3.0.1': '    peerDependencies:\n      ajv: ^8.0.0\n    peerDependenciesMeta:\n      ajv:\n        optional: true\n' })}\nsnapshots:\n\n  ajv-formats@3.0.1:\n    dependencies:\n      ajv: 8.17.1\n\n  ajv@8.17.1: {}\n`
  const AJV_ROOT = JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { 'ajv-formats': '3.0.1' }, devDependencies: { 'my-ajv': 'npm:ajv@8.17.1' } })
  const buildAjv = (pnpm) => {
    stubRegistry(PNPM_TARBALLS)
    return buildPnpmTree({ lockfile: AJV, manifests: { '.': AJV_ROOT }, host: { ...HOST, pnpm }, production: true })
  }
  const KEPT = ['node_modules/.pnpm/ajv-formats@3.0.1/node_modules/ajv -> ../../ajv@8.17.1/node_modules/ajv', 'node_modules/.pnpm/ajv-formats@3.0.1/node_modules/ajv-formats/', 'node_modules/.pnpm/ajv@8.17.1/node_modules/ajv/', 'node_modules/.pnpm/node_modules/ajv -> ../ajv@8.17.1/node_modules/ajv', 'node_modules/ajv-formats -> .pnpm/ajv-formats@3.0.1/node_modules/ajv-formats']
  const DROPPED = ['node_modules/.pnpm/ajv-formats@3.0.1/node_modules/ajv-formats/', 'node_modules/ajv-formats -> .pnpm/ajv-formats@3.0.1/node_modules/ajv-formats']
  for (const [pnpm, expected] of [['10.33.4', KEPT], ['11.27.1', KEPT], ['11.28.6', DROPPED], ['11.28.7', KEPT], ['12.14.0', DROPPED], ['12.15.0', KEPT]]) {
    it(`takes, for pnpm ${pnpm}, a dependency by an optional peer's name for one to it ${expected === KEPT ? 'only where the key binds it' : 'whatever the key binds'}`, async () => {
      const { vfs } = await buildAjv(pnpm)
      assert.deepEqual(layout(vfs), expected)
    })
  }

  it('lays out with sizeEstimateOnly and lazy what it builds', async () => {
    const { vfs } = await build('11.28.9')
    const dirs = (tree) => layout(tree).map((line) => line.replace(/\/ \(empty\)$/u, '/'))
    for (const options of [{ sizeEstimateOnly: true }, { lazy: true }]) {
      const laid = await build('11.28.9', options)
      assert.deepEqual(dirs(laid.vfs), layout(vfs))
      if (options.lazy) {
        await laid.unpack(laid.installed.map(({ path }) => path))
        assert.deepEqual(layout(laid.vfs), layout(vfs))
      }
    }
  })

  // pnpm 10.33.4 and 11.28.9 with nodeLinker: hoisted: packages/a's
  // devDependencies, a link to packages/b among them, are not installed.
  it('leaves them out of the hoisted layout', async () => {
    const workspace = 'nodeLinker: hoisted\npackageImportMethod: copy\npackages:\n  - packages/*\n'
    const lockfile = `${head}  .:\n${DEBUG_ROOT}\n  packages/a:\n    dependencies:\n      debug:\n        specifier: 4.3.7\n        version: 4.3.7(supports-color@8.1.1)\n    devDependencies:\n      b:\n        specifier: workspace:*\n        version: link:../b\n      is-number:\n        specifier: 7.0.0\n        version: 7.0.0\n\n  packages/b:\n    dependencies:\n      is-odd:\n        specifier: 3.0.1\n        version: 3.0.1\n\n${DEBUG_PACKAGES}\n${DEBUG_SNAPSHOTS}`
    const manifests = { '.': ROOT, 'packages/a': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { debug: '4.3.7' }, devDependencies: { b: 'workspace:*', 'is-number': '7.0.0' } }), 'packages/b': JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' } }) }
    const top = (...names) => names.map((name) => `node_modules/${name}/`)
    for (const [pnpm, expected] of [['10.33.4', top('debug', 'has-flag', 'is-number', 'is-odd', 'ms', 'supports-color')], ['11.28.9', ['node_modules/a -> ../packages/a', 'node_modules/b -> ../packages/b', ...top('debug', 'is-number', 'is-odd', 'ms')]]]) {
      stubRegistry(PNPM_TARBALLS)
      const { vfs } = await buildPnpmTree({ lockfile, manifests, workspace, host: { ...HOST, pnpm }, production: true })
      assert.deepEqual(layout(vfs), expected)
      assert.equal(JSON.parse(vfs.readText('/node_modules/is-number/package.json')).version, '6.0.0')
    }
  })

  it('is a boolean', async () => {
    await assert.rejects(build('10.33.4', { production: 'yes' }), { name: 'TypeError', message: 'production must be a boolean, or left out' })
  })

  it('refuses a production setting all the same', async () => {
    await assert.rejects(build('10.33.4', { npmrc: 'production=true\n' }), (error) => error instanceof DeptreeError && /for the production option to say/u.test(error.message))
  })
})

const NPM_TARBALLS = await Promise.all([
  tarball('is-odd', '3.0.1', {}, { manifest: { dependencies: { 'is-number': '^6.0.0' } } }),
  tarball('is-number', '6.0.0'),
  tarball('is-number', '7.0.0'),
  tarball('@sindresorhus/is', '4.6.0'),
  tarball('a-tool', '1.0.0', { 'cli.js': 'a' }, { manifest: { bin: { tool: 'cli.js' } } }),
  tarball('x-tool', '1.0.0', { 'cli.js': 'x' }, { manifest: { bin: { tool: 'cli.js' } } }),
  tarball('mac', '1.0.0', {}, { manifest: { os: ['darwin'] } }),
])

describe('buildNpmTree with production', () => {
  const T = Object.fromEntries(NPM_TARBALLS.map((t) => [`${t.name}@${t.version}`, t]))
  const entry = (id, rest = {}) => ({ version: T[id].version, resolved: url(T[id].name, T[id].version), integrity: T[id].integrity, ...rest })
  const root = { name: 'root', version: '1.0.0', dependencies: { 'is-odd': '3.0.1', 'x-tool': '1.0.0' }, devDependencies: { '@sindresorhus/is': '4.6.0', 'a-tool': '1.0.0', 'is-number': '7.0.0' } }
  const lock = (extra = {}, devDependencies = root.devDependencies) => `${JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: root.dependencies, devDependencies },
      'node_modules/@sindresorhus/is': entry('@sindresorhus/is@4.6.0', { dev: true }),
      'node_modules/a-tool': entry('a-tool@1.0.0', { dev: true, bin: { tool: 'cli.js' } }),
      'node_modules/is-number': entry('is-number@7.0.0', { dev: true }),
      'node_modules/is-odd': entry('is-odd@3.0.1', { dependencies: { 'is-number': '^6.0.0' } }),
      'node_modules/is-odd/node_modules/is-number': entry('is-number@6.0.0'),
      'node_modules/x-tool': entry('x-tool@1.0.0', { bin: { tool: 'cli.js' } }),
      ...extra,
    },
  }, null, 2)}\n`
  const build = (npm, options = {}) => {
    stubRegistry(NPM_TARBALLS)
    return buildNpmTree({ lockfile: lock(), manifests: { '.': JSON.stringify(root) }, host: { npm, node: '24.15.0', os: 'linux', cpu: 'x64', libc: 'glibc' }, production: true, ...options })
  }
  const TREE = ['node_modules/is-odd/', 'node_modules/is-odd/node_modules/is-number/', 'node_modules/x-tool/']

  // npm 10.9.9 made @sindresorhus/is's directory before it took it out.
  it('leaves out what dev dependencies alone reach, npm 10 the directories they were in', async () => {
    const npm10 = await build('10.9.9')
    assert.deepEqual(layout(npm10.vfs), ['node_modules/@sindresorhus/ (empty)', ...TREE])
    const npm11 = await build('11.12.1')
    assert.deepEqual(layout(npm11.vfs), TREE)
    assert.deepEqual([npm11.stats.packages, npm11.stats.installed, npm11.stats.skipped], [6, 3, 0])
    assert.ok(npm11.installed.every(({ dev }) => !dev))
  })

  // a-tool claims the name first where it is installed, by its path.
  it('links the bins of what it installs alone', async () => {
    const { vfs } = await build('11.12.1')
    assert.equal(vfs.stat('/node_modules/x-tool/cli.js').mode & 0o777, 0o755)
    const full = await build('11.12.1', { production: false })
    assert.equal(full.vfs.stat('/node_modules/x-tool/cli.js').mode & 0o777, 0o644)
    assert.equal(full.vfs.stat('/node_modules/a-tool/cli.js').mode & 0o777, 0o755)
  })

  it('holds to the host what npm 10 does, and npm 11 does not, of what it leaves out', async () => {
    const options = { lockfile: lock({ 'node_modules/mac': entry('mac@1.0.0', { dev: true, os: ['darwin'] }) }, { ...root.devDependencies, mac: '1.0.0' }), manifests: { '.': JSON.stringify({ ...root, devDependencies: { ...root.devDependencies, mac: '1.0.0' } }) } }
    await assert.rejects(build('10.9.9', options), (error) => error instanceof DeptreeError && /is not the host's, and it is not optional, which npm fails on/u.test(error.message))
    assert.deepEqual(layout((await build('11.12.1', options)).vfs), TREE)
  })
})

const YARN_TARBALLS = await Promise.all([
  tarball('is-odd', '3.0.1', {}, { manifest: { dependencies: { 'is-number': '^6.0.0' } } }),
  tarball('is-number', '6.0.0'),
  tarball('is-number', '7.0.0'),
])

describe('buildYarn1Tree with production', () => {
  const T = Object.fromEntries(YARN_TARBALLS.map((t) => [`${t.name}@${t.version}`, t]))
  const entry = (keys, id, dependencies = '') => `${keys}:\n  version "${T[id].version}"\n  resolved "${url(T[id].name, T[id].version)}"\n  integrity ${T[id].integrity}\n${dependencies}`
  const lockfile = (...entries) => `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n${entries.join('\n')}`
  const IS_ODD = entry('is-odd@3.0.1', 'is-odd@3.0.1', '  dependencies:\n    is-number "^6.0.0"\n')
  const build = (manifests, lock) => {
    stubRegistry(YARN_TARBALLS)
    return buildYarn1Tree({ lockfile: lock, manifests, host: { yarn: '1.22.22', node: '24.15.0', os: 'linux', cpu: 'x64' }, production: true })
  }
  const root = (devDependencies) => JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' }, devDependencies })

  // yarn hoists the root's is-number@7.0.0 all the same, where is-odd's
  // is-number@6.0.0 cannot then be.
  it('hoists the root\'s devDependencies, and installs them only where something else needs them', async () => {
    const { vfs, installed, stats } = await build({ '.': root({ 'is-number': '7.0.0' }) }, lockfile(entry('is-number@7.0.0', 'is-number@7.0.0'), entry('is-number@^6.0.0', 'is-number@6.0.0'), IS_ODD))
    assert.deepEqual(layout(vfs), ['node_modules/is-odd/', 'node_modules/is-odd/node_modules/is-number/'])
    assert.deepEqual(installed.map(({ path, dev }) => [path, dev]), [['node_modules/is-odd', false], ['node_modules/is-odd/node_modules/is-number', false]])
    assert.deepEqual([stats.packages, stats.installed], [3, 2])
    const shared = await build({ '.': root({ 'is-number': '6.0.0' }) }, lockfile(entry('is-number@6.0.0, is-number@^6.0.0', 'is-number@6.0.0'), IS_ODD))
    assert.deepEqual(layout(shared.vfs), ['node_modules/is-number/', 'node_modules/is-odd/'])
  })

  it('asks for no workspace\'s devDependencies', async () => {
    const manifests = {
      '.': JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] }),
      'packages/a': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' }, devDependencies: { b: '1.0.0', 'is-number': '7.0.0' } }),
      'packages/b': JSON.stringify({ name: 'b', version: '1.0.0' }),
    }
    const { vfs } = await build(manifests, lockfile(entry('is-number@7.0.0', 'is-number@7.0.0'), entry('is-number@^6.0.0', 'is-number@6.0.0'), IS_ODD))
    assert.deepEqual(layout(vfs), ['node_modules/a -> ../packages/a', 'node_modules/b -> ../packages/b', 'node_modules/is-number/', 'node_modules/is-odd/'])
    assert.equal(JSON.parse(vfs.readText('/node_modules/is-number/package.json')).version, '6.0.0')
  })
})
