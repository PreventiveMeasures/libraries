import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { DeptreeError } from '../pnpm.js'
import { parseNpmrc } from '../src/pnpm/npmrc.js'
import { readSettings } from '../src/pnpm/settings.js'

const read = ({ workspace, npmrc, manifest = {}, os = 'linux' } = {}) => readSettings({ workspace: workspace === undefined ? undefined : parseYaml(workspace), npmrc, manifest, os })

const DEFAULTS = {
  virtualStoreDirMaxLength: 120,
  hoistPattern: ['*'],
  publicHoistPattern: [],
  hoistWorkspacePackages: true,
  engineStrict: false,
  nodeVersion: undefined,
  supportedArchitectures: undefined,
  patchedDependencies: undefined,
  overrides: undefined,
  catalogs: Object.create(null),
  packageExtensions: undefined,
  ignoredOptionalDependencies: [],
  autoInstallPeers: true,
  dedupePeers: false,
  peersSuffixMaxLength: 1000,
  packages: undefined,
}

describe('parseNpmrc', () => {
  it('reads keys, values, lists and comments as ini does', () => {
    assert.deepEqual(parseNpmrc('# c\n; c\n a = b \nflag\nlist[]=x\r\nlist[]=y\n'), [
      { key: 'a', value: 'b', list: false, line: 3 },
      { key: 'flag', value: 'true', list: false, line: 4 },
      { key: 'list', value: 'x', list: true, line: 5 },
      { key: 'list', value: 'y', list: true, line: 6 },
    ])
  })

  it('refuses a section', () => {
    assert.throws(() => parseNpmrc('[s]\n'), /^DeptreeError: \.npmrc:1: a section is not supported$/u)
  })
})

describe('readSettings', () => {
  it('is pnpm 10\'s defaults with nothing set', () => {
    assert.deepEqual(read(), DEFAULTS)
    assert.equal(read({ os: 'darwin' }).virtualStoreDirMaxLength, 120)
  })

  it('reads the .npmrc, and pnpm-workspace.yaml over it', () => {
    const npmrc = 'hoist-pattern[]=*\nhoist-pattern[]=!a\npublic-hoist-pattern=*types*\nvirtual-store-dir-max-length=60\nengine-strict=true\n'
    assert.deepEqual(read({ npmrc }), { ...DEFAULTS, hoistPattern: ['*', '!a'], publicHoistPattern: ['*types*'], virtualStoreDirMaxLength: 60, engineStrict: true })
    assert.deepEqual(read({ npmrc, workspace: 'virtualStoreDirMaxLength: 90\nhoistPattern: b\n' }).virtualStoreDirMaxLength, 90)
    assert.deepEqual(read({ npmrc, workspace: 'hoistPattern: b\n' }).hoistPattern, ['b'])
  })

  it('derives the patterns as pnpm does', () => {
    assert.equal(read({ npmrc: 'hoist=false\n' }).hoistPattern, undefined)
    assert.deepEqual(read({ workspace: 'shamefullyHoist: true\n' }).publicHoistPattern, ['*'])
    assert.equal(read({ workspace: 'shamefullyHoist: false\n' }).publicHoistPattern, undefined)
    assert.equal(read({ npmrc: 'public-hoist-pattern=\n' }).publicHoistPattern, undefined)
  })

  it('passes over what leaves the tree as it is', () => {
    const npmrc = 'registry=https://registry.npmjs.org/\n@s:registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=abc\nstore-dir=/x\nauto-install-peers=true\nstrict-ssl=false\n'
    const workspace = 'allowBuilds:\n  esbuild: false\nminimumReleaseAge: 1440\npeerDependencyRules:\n  ignoreMissing: [x]\nignoreWorkspaceRootCheck: true\n'
    const manifest = { name: 'x', scripts: { postinstall: 'x' }, pnpm: { nodeLinker: 'hoisted', updateConfig: {}, allowedDeprecatedVersions: {} } }
    assert.deepEqual(read({ npmrc, workspace, manifest }), DEFAULTS)
  })

  it('reads pnpm-workspace.yaml\'s packages, and only there', () => {
    assert.deepEqual(read({ workspace: 'packages: [a, "!b"]\n' }).packages, ['a', '!b'])
    assert.throws(() => read({ npmrc: 'packages=a\n' }), /^DeptreeError: \.npmrc:1: packages: unsupported setting$/u)
  })

  // Scripts are never run, as with --ignore-scripts: what a setting would
  // allow to build is built by nothing here.
  it('passes over what would allow a script to run', () => {
    const workspace = 'allowBuilds:\n  esbuild: true\nonlyBuiltDependencies: [esbuild]\nneverBuiltDependencies: [x]\ndangerouslyAllowAllBuilds: true\n'
    assert.deepEqual(read({ workspace, npmrc: 'ignore-scripts=false\n' }), DEFAULTS)
  })

  describe('overrides', () => {
    const overrides = (input) => ({ ...read(input).overrides })

    it('are resolutions, and pnpm.overrides over them', () => {
      const manifest = { resolutions: { a: '1', b: '1' }, pnpm: { overrides: { b: '2', c: '2' } } }
      assert.deepEqual(overrides({ manifest }), { a: '1', b: '2', c: '2' })
    })

    // pnpm install spreads the package.json's settings over the config it
    // read pnpm-workspace.yaml into, so its overrides replace those whole.
    it('are the package.json\'s where it names any, and pnpm-workspace.yaml\'s only where it names none', () => {
      const manifest = { resolutions: { a: '1' }, pnpm: { overrides: { b: '2' } } }
      assert.deepEqual(overrides({ manifest, workspace: 'overrides:\n  c: "3"\n' }), { a: '1', b: '2' })
      assert.deepEqual(overrides({ manifest: { resolutions: {} }, workspace: 'overrides:\n  c: "3"\n' }), { c: '3' })
      assert.deepEqual(overrides({ workspace: 'overrides:\n  c: "3"\n' }), { c: '3' })
      assert.equal(read({ manifest: { resolutions: {} }, workspace: 'overrides: {}\n' }).overrides, undefined)
    })

    it('take $name from the root package.json, optional over regular over dev', () => {
      const manifest = { devDependencies: { a: '1', b: '1' }, dependencies: { b: '2', c: '2' }, optionalDependencies: { c: '3' }, pnpm: { overrides: { x: '$a', y: '$b', z: '$c' } } }
      assert.deepEqual(overrides({ manifest }), { x: '1', y: '2', z: '3' })
      assert.deepEqual(overrides({ manifest: { ...manifest, pnpm: {} }, workspace: 'overrides:\n  w: $b\n' }), { w: '2' })
      assert.throws(() => read({ manifest: { pnpm: { overrides: { x: '$nope' } } } }), /"\$nope" names no dependency of the root package\.json/u)
      assert.throws(() => read({ manifest: { resolutions: { x: 1 } } }), /expected a string for "x"/u)
    })

    it('are refused where the root package.json misspells them', () => {
      assert.throws(() => read({ manifest: { resolutions: ['a'] } }), /^DeptreeError: package\.json: resolutions: expected a mapping, found a list$/u)
      assert.throws(() => read({ manifest: { pnpm: 'x' } }), /^DeptreeError: package\.json: pnpm: expected a mapping/u)
    })
  })

  it('reads the root package.json\'s pnpm field, over pnpm-workspace.yaml', () => {
    const manifest = { pnpm: { supportedArchitectures: { os: ['current', 'darwin'] }, ignoredOptionalDependencies: ['x'] } }
    assert.deepEqual(read({ manifest }).supportedArchitectures, { os: ['current', 'darwin'] })
    assert.deepEqual(read({ manifest }).ignoredOptionalDependencies, ['x'])
    assert.deepEqual(read({ manifest, workspace: 'supportedArchitectures:\n  os: [linux]\n' }).supportedArchitectures.os, ['current', 'darwin'])
    assert.deepEqual(read({ workspace: 'supportedArchitectures:\n  os: [linux]\n' }).supportedArchitectures.os, ['linux'])
    // A hoist pattern alone is a list of it, as pnpm reads one.
    assert.deepEqual(read({ workspace: 'hoistPattern: color-*\npublicHoistPattern: eslint\n' }), { ...DEFAULTS, hoistPattern: ['color-*'], publicHoistPattern: ['eslint'] })
    assert.throws(() => read({ manifest: { pnpm: { configDependencies: {} } } }), /^DeptreeError: package\.json: pnpm\.configDependencies: unsupported setting$/u)
  })

  it('reads the catalogs, and refuses the default one twice', () => {
    const { catalogs } = read({ workspace: 'catalog:\n  a: ^1\ncatalogs:\n  next:\n    a: ^2\n' })
    assert.deepEqual(JSON.parse(JSON.stringify(catalogs)), { default: { a: '^1' }, next: { a: '^2' } })
    assert.throws(() => read({ workspace: 'catalog:\n  a: ^1\ncatalogs:\n  default:\n    a: ^2\n' }), /the default catalog is defined twice/u)
    assert.throws(() => read({ npmrc: 'overrides=x\n' }), /^DeptreeError: \.npmrc:1: overrides: unsupported setting$/u)
  })

  const refused = [
    [{ workspace: 'nodeLinker: hoisted\n' }, /^pnpm-workspace\.yaml: nodeLinker: "hoisted" is not supported/u],
    [{ npmrc: 'node-linker=pnp\n' }, /^\.npmrc:1: node-linker: "pnp" is not supported/u],
    [{ workspace: 'someNewSetting: 1\n' }, /^pnpm-workspace\.yaml: someNewSetting: unsupported setting$/u],
    [{ npmrc: 'some-new-setting=1\n' }, /^\.npmrc:1: some-new-setting: unsupported setting$/u],
    [{ npmrc: 'publicHoistPattern=*\n' }, /^\.npmrc:1: publicHoistPattern: unsupported setting$/u],
    [{ npmrc: 'registry=https://npm.example.com/\n' }, /packages are fetched from https:\/\/registry\.npmjs\.org\/ alone/u],
    [{ npmrc: '@s:registry=https://npm.example.com/\n' }, /^\.npmrc:1: @s:registry:/u],
    [{ npmrc: '//registry.npmjs.org/:_authToken=${TOKEN}\n' }, /is taken from the environment/u],
    [{ workspace: 'storeDir: ${HOME}/store\n' }, /is taken from the environment/u],
    [{ npmrc: 'hoist="false"\n' }, /is quoted, escaped or commented/u],
    [{ npmrc: 'hoist=false ; no\n' }, /is quoted, escaped or commented/u],
    [{ npmrc: 'hoist=false\nhoist=true\n' }, /^\.npmrc:2: hoist: set more than once$/u],
    [{ npmrc: 'hoist[]=false\n' }, /^\.npmrc:1: hoist: not a list$/u],
    [{ npmrc: 'hoist=maybe\n' }, /expected true or false/u],
    [{ workspace: 'virtualStoreDirMaxLength: 0\n' }, /expected a positive integer/u],
    [{ workspace: 'enableGlobalVirtualStore: true\n' }, /a global virtual store is not built/u],
    [{ workspace: 'supportedArchitectures:\n  arch: [x64]\n' }, /unsupported key "arch"/u],
    // A string alone where pnpm maps or sorts a list, which pnpm fails on.
    [{ workspace: 'supportedArchitectures:\n  os: darwin\n' }, /^pnpm-workspace\.yaml: supportedArchitectures\.os: expected a list of strings, found "darwin"$/u],
    [{ manifest: { pnpm: { supportedArchitectures: { cpu: 'arm64' } } } }, /^package\.json: pnpm\.supportedArchitectures\.cpu: expected a list of strings/u],
    [{ workspace: 'ignoredOptionalDependencies: x\n' }, /^pnpm-workspace\.yaml: ignoredOptionalDependencies: expected a list of strings, found "x"$/u],
    [{ workspace: 'nodeVersion: "20"\n' }, /"20" is not an exact version/u],
    [{ workspace: 'patchedDependencies:\n  a@1.0.0: /abs.patch\n' }, /an absolute patch path is not supported/u],
    [{ npmrc: 'production=true\n' }, /devDependencies are installed/u],
  ]
  for (const [input, pattern] of refused) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      assert.throws(() => read(input), (error) => error instanceof DeptreeError && pattern.test(error.message))
    })
  }
})
