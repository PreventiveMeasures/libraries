import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { DeptreeError } from '../pnpm.js'
import { parseNpmrc } from '../src/pnpm/npmrc.js'
import { readSettings } from '../src/pnpm/settings.js'

const read = ({ workspace, npmrc, os = 'linux' } = {}) => readSettings({ workspace: workspace === undefined ? undefined : parseYaml(workspace), npmrc, os })

const DEFAULTS = {
  virtualStoreDirMaxLength: 120,
  hoistPattern: ['*'],
  publicHoistPattern: [],
  hoistWorkspacePackages: true,
  engineStrict: false,
  nodeVersion: undefined,
  supportedArchitectures: undefined,
  patchedDependencies: undefined,
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
    const workspace = 'packages: [a]\ncatalog:\n  x: ^1\noverrides:\n  x: 1\nallowBuilds:\n  esbuild: false\nminimumReleaseAge: 1440\n'
    assert.deepEqual(read({ npmrc, workspace }), DEFAULTS)
  })

  // Scripts are never run, as with --ignore-scripts: what a setting would
  // allow to build is built by nothing here.
  it('passes over what would allow a script to run', () => {
    const workspace = 'allowBuilds:\n  esbuild: true\nonlyBuiltDependencies: [esbuild]\nneverBuiltDependencies: [x]\ndangerouslyAllowAllBuilds: true\n'
    assert.deepEqual(read({ workspace, npmrc: 'ignore-scripts=false\n' }), DEFAULTS)
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
