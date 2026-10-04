import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { DeptreeError } from '../pnpm.js'
import { parseNpmrc } from '../src/npmrc.js'
import { readSettings } from '../src/pnpm/settings.js'

const read = ({ workspace, npmrc, manifest = {}, locked, major } = {}) => readSettings({ workspace: workspace === undefined ? undefined : parseYaml(workspace), npmrc, manifest, locked, major })

const DEFAULTS = {
  virtualStoreDirMaxLength: 120,
  hoistPattern: ['*'],
  publicHoistPattern: [],
  hoistWorkspacePackages: true,
  engineStrict: false,
  nodeVersion: undefined,
  runtimeNodeVersion: undefined,
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
  linkWorkspacePackages: false,
  pmOnFail: undefined,
  runtimeOnFail: undefined,
  packageImportMethod: 'auto',
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

  // Whether a package installed from a directory is one copy or many.
  it('reads packageImportMethod', () => {
    assert.equal(read({ npmrc: 'package-import-method=copy\n' }).packageImportMethod, 'copy')
    assert.equal(read({ workspace: 'packageImportMethod: clone-or-copy\n', major: 11 }).packageImportMethod, 'clone-or-copy')
    assert.throws(() => read({ workspace: 'packageImportMethod: symlink\n' }), /^DeptreeError: pnpm-workspace\.yaml: packageImportMethod: expected one of auto, hardlink, copy, clone, clone-or-copy, found "symlink"$/u)
  })

  it('passes over what leaves the tree as it is', () => {
    const npmrc = 'registry=https://registry.npmjs.org/\n@s:registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=abc\nstore-dir=/x\nauto-install-peers=true\nstrict-ssl=false\n'
    const workspace = 'allowBuilds:\n  esbuild: false\nminimumReleaseAge: 1440\npeerDependencyRules:\n  ignoreMissing: [x]\nignoreWorkspaceRootCheck: true\n'
    const manifest = { name: 'x', scripts: { postinstall: 'x' }, pnpm: { nodeLinker: 'hoisted', updateConfig: {}, allowedDeprecatedVersions: {} } }
    assert.deepEqual(read({ npmrc, workspace, manifest }), DEFAULTS)
  })

  it('reads pnpm-workspace.yaml\'s packages, and only there', () => {
    assert.deepEqual(read({ workspace: 'packages: [a, "!b"]\n' }).packages, ['a', '!b'])
    assert.deepEqual(read({ npmrc: 'packages=a\n' }), DEFAULTS)
  })

  // pnpm reads only the kebab-case names it has types for: npm's own,
  // publishing's, and any other name or spelling are passed over.
  it('passes over in an .npmrc what pnpm does not read for an install', () => {
    const npmrc = 'fund=false\naudit=false\nlegacy-peer-deps=true\naccess=public\nprovenance=true\nignore-compatibility-db=true\nsome-new-setting=1\npublicHoistPattern=*\nNODE_LINKER=hoisted\nsave-exact=true\n'
    assert.deepEqual(read({ npmrc }), DEFAULTS)
  })

  // pnpm drops the whole .npmrc where a variable in it is unset: one in a
  // line passed over is taken where dropping the file would change nothing.
  it('takes a variable from the environment only where the rest of the file cannot turn on it', () => {
    const token = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'
    assert.deepEqual(read({ npmrc: `${token}_auth=\${AUTH}\nsave-exact=true\n` }), DEFAULTS)
    assert.deepEqual(read({ npmrc: `${token}auto-install-peers=true\n` }), DEFAULTS)
    assert.deepEqual(read({ npmrc: `${token}hoist=false\n`, workspace: 'hoist: false\n' }).hoistPattern, undefined)
    assert.throws(() => read({ npmrc: `${token}hoist=false\n` }), /^DeptreeError: \.npmrc: a line takes a value from the environment, which pnpm drops the whole file for where it is unset/u)
    assert.throws(() => read({ npmrc: 'registry=${REGISTRY}\n' }), /^DeptreeError: \.npmrc:1: registry: "\$\{REGISTRY\}" is taken from the environment/u)
  })

  // A frozen install refuses a lockfile whose own settings differ from those
  // it reads, so where they fit the file only read or only dropped, the other
  // installs nothing, and the whole file goes with the one that does.
  it('reads an .npmrc pnpm may drop as the lockfile\'s settings tell', () => {
    const token = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'
    const npmrc = `${token}auto-install-peers=false\nhoist=false\n`
    assert.deepEqual(read({ npmrc, locked: { autoInstallPeers: false } }), { ...DEFAULTS, autoInstallPeers: false, hoistPattern: undefined })
    assert.deepEqual(read({ npmrc, locked: { autoInstallPeers: true } }), DEFAULTS)
    assert.deepEqual(read({ npmrc: `${token}dedupe-peers=true\n`, locked: { dedupePeers: true } }), { ...DEFAULTS, dedupePeers: true })
    assert.deepEqual(read({ npmrc: `${token}dedupe-peers=true\n` }), DEFAULTS, 'a lockfile without dedupePeers has it false')
    assert.deepEqual(read({ npmrc: `${token}peers-suffix-max-length=100\n`, locked: { peersSuffixMaxLength: 100 } }), { ...DEFAULTS, peersSuffixMaxLength: 100 })
    assert.throws(() => read({ npmrc: `${token}auto-install-peers=true\nhoist=false\n`, locked: { autoInstallPeers: true } }), /, which the lockfile's settings fit read and dropped alike$/u)
    assert.throws(() => read({ npmrc, locked: {} }), /fit read and dropped alike$/u, 'a lockfile without autoInstallPeers tells nothing of it')
    const neither = read({ npmrc: `${token}auto-install-peers=false\ndedupe-peers=true\n`, locked: { autoInstallPeers: false } })
    assert.deepEqual(neither, { ...DEFAULTS, autoInstallPeers: false, dedupePeers: true }, 'read, for uptodate.js to refuse')
    assert.equal(read({ npmrc, locked: { autoInstallPeers: false }, major: 9 }).hoistPattern, undefined, 'pnpm 9 drops it alike')
  })

  // pnpm 9 reads of pnpm-workspace.yaml its projects and catalogs alone,
  // and of an .npmrc and the package.json what it has settings for.
  it('reads settings as pnpm 9 does', () => {
    const DEFAULTS_9 = { ...DEFAULTS, publicHoistPattern: ['*eslint*', '*prettier*'], packageManagerChecks: { manage: false, strict: true, strictVersion: false } }
    assert.deepEqual(read({ major: 9 }), DEFAULTS_9)
    const settings = read({ workspace: 'packages: [a]\nnodeLinker: hoisted\nhoist: false\noverrides:\n  ms: 1.0.0\ncatalog:\n  ms: 2.1.3\ncatalogs: null\n', major: 9 })
    assert.deepEqual({ ...settings, catalogs: { ...settings.catalogs.default } }, { ...DEFAULTS_9, packages: ['a'], catalogs: { ms: '2.1.3' } })
    assert.throws(() => read({ workspace: 'packages: [a]\ncatalog: [ms]\n', major: 9 }), /^DeptreeError: pnpm-workspace\.yaml: catalog: expected a mapping, found a list$/u)
    const npmrc = 'dedupe-peers=true\nenable-global-virtual-store=true\ninject-workspace-packages=true\npackage-manager-strict=false\nmanage-package-manager-versions=true\n'
    assert.deepEqual(read({ npmrc, major: 9 }), { ...DEFAULTS_9, packageManagerChecks: { manage: true, strict: false, strictVersion: false } })
    assert.throws(() => read({ npmrc: 'enable-global-virtual-store=true\n' }), /a global virtual store is not built/u, 'pnpm 10 reads it')
    const manifest = { resolutions: { a: '1' }, pnpm: { configDependencies: { c: '1' }, ignorePatchFailures: true, allowUnusedPatches: true, supportedArchitectures: { os: ['darwin'] } } }
    assert.deepEqual({ ...read({ manifest, major: 9 }), overrides: { ...read({ manifest, major: 9 }).overrides } }, { ...DEFAULTS_9, overrides: { a: '1' }, supportedArchitectures: { os: ['darwin'] } })
  })

  // pnpm 11 reads settings from pnpm-workspace.yaml alone: an .npmrc for
  // its registries, and nothing of the package.json, `resolutions` none.
  it('reads settings as pnpm 11 does', () => {
    const manifest = { resolutions: { ms: '2.1.2' }, pnpm: { overrides: { ms: '2.1.3' }, nodeLinker: 'hoisted' } }
    const npmrc = 'hoist=false\nnode-linker=hoisted\nregistry=${REGISTRY}\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'
    assert.deepEqual(read({ manifest, npmrc, major: 11 }), DEFAULTS)
    assert.deepEqual({ ...read({ workspace: 'overrides:\n  ms: 2.1.3\n', major: 11 }).overrides }, { ms: '2.1.3' })
    assert.throws(() => read({ npmrc: 'registry=https://npm.example.com/\n', major: 11 }), /packages are fetched from https:\/\/registry\.npmjs\.org\/ alone/u)
  })

  // pnpm 11 passes over a kebab-case key of pnpm-workspace.yaml; of its own
  // settings, those that leave the tree as it is are passed over.
  it('reads pnpm 11\'s own settings', () => {
    const workspace = 'node-linker: hoisted\ntrustLockfile: false\nminimumReleaseAge: 1440\noptimisticRepeatInstall: true\nignorePatchFailures: true\nstoreDir: /s\nvirtualStoreType: project\nregistries:\n  default: https://registry.npmjs.org/\nsideEffectsCache: false\npackageConfigs:\n  root:\n    saveExact: true\n'
    assert.deepEqual(read({ workspace, major: 11 }), DEFAULTS)
    assert.deepEqual(read({ workspace: 'linkWorkspacePackages: deep\npmOnFail: ignore\nruntimeOnFail: warn\n', major: 11 }), { ...DEFAULTS, linkWorkspacePackages: true, pmOnFail: 'ignore', runtimeOnFail: 'warn' })
    assert.throws(() => read({ workspace: 'node-linker: hoisted\n' }), /^DeptreeError: pnpm-workspace\.yaml: node-linker: unsupported setting$/u, 'pnpm 10 does not pass over it')
    const refused = [
      ['virtualStoreType: global\n', /"global" is not supported/u],
      ['virtualStoreOnly: true\n', /true is not supported/u],
      ['nodeExperimentalPackageMap: true\n', /package-map/u],
      ['registries:\n  default: https://npm.example.com/\n', /registries\.default: "https:\/\/npm\.example\.com\/" is not supported/u],
      ['namedRegistries:\n  work: https://registry.npmjs.org/\n', /namedRegistries: a mapping is not supported/u],
      ['sideEffectsCache:\n  remote:\n    url: https://cache.example.com/\n', /sideEffectsCache\.remote: a mapping is not supported/u],
      ['packageConfigs:\n  root:\n    modulesDir: m\n', /packageConfigs\["root"\]: "modulesDir" is not supported/u],
      ['packageConfigs:\n  - match: [root]\n    hoist: false\n', /packageConfigs\["0"\]: "hoist" is not supported/u],
      ['pmOnFail: sometimes\n', /pmOnFail: expected one of download, error, warn, ignore/u],
    ]
    for (const [text, pattern] of refused) assert.throws(() => read({ workspace: text, major: 11 }), pattern, text)
  })

  // From the root package.json, devEngines first.
  it('takes nodeVersion for pnpm 11 from the Node engines.runtime pins', () => {
    const runtime = (version, onFail = 'error') => ({ name: 'node', version, onFail })
    assert.equal(read({ manifest: { engines: { runtime: runtime('22.1.0') } }, major: 11 }).runtimeNodeVersion, '22.1.0')
    assert.equal(read({ manifest: { devEngines: { runtime: [{ name: 'deno' }, runtime('20.0.0', 'warn')] }, engines: { runtime: runtime('22.1.0') } }, major: 11 }).runtimeNodeVersion, '20.0.0')
    assert.equal(read({ manifest: { devEngines: { runtime: runtime('>=20') }, engines: { runtime: runtime('22.1.0') } }, major: 11 }).runtimeNodeVersion, undefined, 'a range decides, and pins nothing')
    const both = read({ manifest: { engines: { runtime: runtime('22.1.0') } }, workspace: 'nodeVersion: 24.0.0\n', major: 11 })
    assert.deepEqual([both.nodeVersion, both.runtimeNodeVersion], ['24.0.0', '22.1.0'], 'nodeVersion wins where it is read')
    assert.equal(read({ manifest: { engines: { runtime: runtime('22.1.0') } } }).runtimeNodeVersion, undefined, 'pnpm 10 takes none')
    assert.throws(() => read({ manifest: { engines: { runtime: runtime('22.1.0', 'download') } }, major: 11 }), /a Node runtime to download is not supported/u)
    assert.throws(() => read({ manifest: { engines: { runtime: runtime('22.1.0') } }, workspace: 'runtimeOnFail: download\n', major: 11 }), /a Node runtime to download is not supported/u)
  })

  // Scripts are never run, as with --ignore-scripts.
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
    assert.deepEqual(read({ manifest }), { ...DEFAULTS, supportedArchitectures: { os: ['current', 'darwin'] }, ignoredOptionalDependencies: ['x'] })
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
    assert.deepEqual(read({ npmrc: 'overrides=x\n' }), DEFAULTS)
  })

  const refused = [
    [{ workspace: 'nodeLinker: hoisted\n' }, /^pnpm-workspace\.yaml: nodeLinker: "hoisted" is not supported/u],
    [{ npmrc: 'node-linker=pnp\n' }, /^\.npmrc:1: node-linker: "pnp" is not supported/u],
    [{ workspace: 'someNewSetting: 1\n' }, /^pnpm-workspace\.yaml: someNewSetting: unsupported setting$/u],
    [{ npmrc: 'registry=https://npm.example.com/\n' }, /packages are fetched from https:\/\/registry\.npmjs\.org\/ alone/u],
    [{ npmrc: '@s:registry=https://npm.example.com/\n' }, /^\.npmrc:1: @s:registry:/u],
    [{ npmrc: 'force=true\n' }, /^\.npmrc:1: force: true is not supported: optional packages the host cannot run are left out$/u],
    [{ npmrc: 'recursive-install=false\n' }, /every project is installed/u],
    [{ npmrc: 'lockfile-dir=..\n' }, /the lockfile is the one given/u],
    [{ npmrc: 'only=prod\n' }, /dependencies and devDependencies are both installed/u],
    [{ npmrc: 'shamefully-flatten=true\n' }, /its old name is not read/u],
    [{ npmrc: 'use-node-version=20.0.0\n' }, /the Node a tree is built for/u],
    [{ npmrc: 'git-branch-lockfile=true\n' }, /the lockfile is the one given/u],
    [{ npmrc: 'filter=a\n' }, /every project is installed/u],
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
