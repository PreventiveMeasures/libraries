import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, YamlError, packageKeyOf, parsePnpmLockfile } from '../pnpm.js'
import { YamlError as YamlErrorOfYaml } from '../yaml.js'

// One small lockfile with a package of every kind — registry, with its
// tarball URL and without, a peer, a patch, a directory, git, a remote
// tarball — and a link, in the shape pnpm writes; then one edit at a time,
// each of which is refused with a message that says where and why.

const I = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='
const C = '0123456789abcdef0123456789abcdef01234567'
// A patch hash as pnpm 10 and later write it: a sha256, in hex.
const P = '25beca4d543c6a7ba195f72529648450abd9451553893a0dfa5a5fda314bf342'
const P2 = `${P.slice(0, -1)}3`

const BASE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

patchedDependencies:
  b@1.0.0: ${P}

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0(c@2.0.0)
      e:
        specifier: git+https://example.com/e.git
        version: git+https://example.com/e.git#${C}
      f:
        specifier: https://example.com/f.tgz
        version: https://example.com/f.tgz
      l:
        specifier: link:../l
        version: link:../l
    devDependencies:
      d:
        specifier: file:d
        version: file:d

packages:

  a@1.0.0:
    resolution: {integrity: ${I}}
    peerDependencies:
      c: ^2.0.0

  b@1.0.0:
    resolution: {integrity: ${I}}

  c@2.0.0:
    resolution: {integrity: ${I}, tarball: https://registry.npmjs.org/c/-/c-2.0.0.tgz}

  d@file:d:
    resolution: {directory: d, type: directory}

  e@git+https://example.com/e.git#${C}:
    resolution: {commit: ${C}, repo: https://example.com/e.git, type: git}
    version: 3.0.0

  f@https://example.com/f.tgz:
    resolution: {tarball: https://example.com/f.tgz}
    version: 4.0.0

snapshots:

  a@1.0.0(c@2.0.0):
    dependencies:
      b: 1.0.0(patch_hash=${P})
      c: 2.0.0

  b@1.0.0(patch_hash=${P}): {}

  c@2.0.0: {}

  d@file:d: {}

  e@git+https://example.com/e.git#${C}: {}

  f@https://example.com/f.tgz: {}
`

// An env document, as pnpm writes it before the lockfile: config
// dependencies and the package manager, then the `---` that ends it.
const ENV = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies:\n      c:\n        specifier: 2.0.0\n        version: 2.0.0\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.6.0\n        version: 12.6.0\n\npackages:\n\n  c@2.0.0:\n    resolution: {integrity: ${I}}\n\n  pnpm@12.6.0:\n    resolution: {integrity: ${I}}\n\nsnapshots:\n\n  c@2.0.0: {}\n\n  pnpm@12.6.0: {}\n\n---\n`

// BASE with each `[from, to]` replaced, once; `from` has to be there.
function edit(...edits) {
  let text = BASE
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `BASE has no ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  return text
}

const refuses = (text, message, where) => assert.throws(() => parsePnpmLockfile(text), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, message)
  if (where !== undefined) assert.equal(error.where, where)
  return true
})

const plain = (value) => structuredClone(value)

// The project's lockfile, of a file that has one.
const parse = (text) => parsePnpmLockfile(text).lockfile

// A key or value as a message quotes it: past 200 characters, cut.
const shown = (text) => JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)

describe('the base lockfile', () => {
  const lock = parse(BASE)

  it('reads', () => {
    assert.deepEqual(Object.keys(lock.packages), ['a@1.0.0(c@2.0.0)', `b@1.0.0(patch_hash=${P})`, 'c@2.0.0', 'd@file:d', `e@git+https://example.com/e.git#${C}`, 'f@https://example.com/f.tgz'])
    assert.deepEqual(plain(lock.importers['.'].dependencies), {
      a: 'a@1.0.0(c@2.0.0)',
      e: `e@git+https://example.com/e.git#${C}`,
      f: 'f@https://example.com/f.tgz',
      l: 'link:../l',
    })
    assert.deepEqual(plain(lock.patchedDependencies), { 'b@1.0.0': { hash: P, path: undefined } })
    assert.equal(lock.packages[`b@1.0.0(patch_hash=${P})`].patchHash, P)
    assert.equal(lock.packages['c@2.0.0'].resolution.tarball, 'https://registry.npmjs.org/c/-/c-2.0.0.tgz')
    assert.deepEqual(lock.packages['f@https://example.com/f.tgz'].resolution, { type: 'tarball', integrity: undefined, tarball: 'https://example.com/f.tgz', path: undefined, gitHosted: false })
    assert.equal(parsePnpmLockfile(BASE).env, undefined)
  })

  it('with CRLF line ends too', () => {
    assert.deepEqual(plain(parse(BASE.replaceAll('\n', '\r\n'))), plain(lock))
  })

  it('an empty workspace', () => {
    const empty = parse("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n")
    assert.deepEqual(plain(empty.packages), {})
    assert.deepEqual(plain(empty.importers['.']), {
      specifiers: {},
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      dependenciesMeta: {},
      publishDirectory: undefined,
      linkDirectory: true,
    })
  })
})

describe('what else pnpm writes is read', () => {
  const read = (...edits) => parse(edit(...edits))

  it('every setting', () => {
    const settings = '  autoInstallPeers: true\n  dedupePeers: true\n  excludeLinksFromLockfile: true\n  injectWorkspacePackages: true\n  peersSuffixMaxLength: 20\n'
    assert.deepEqual(plain(read(['  autoInstallPeers: true\n', settings]).settings), {
      autoInstallPeers: true, dedupePeers: true, excludeLinksFromLockfile: true, injectWorkspacePackages: true, peersSuffixMaxLength: 20,
    })
  })

  it('a peer suffix limit of 0, which hashes every one', () => {
    assert.equal(read(['  autoInstallPeers: true\n', '  peersSuffixMaxLength: 0\n']).settings.peersSuffixMaxLength, 0)
  })

  it('what rewrote the manifests, and the optional dependencies left out', () => {
    const header = (checksums) => read(['settings:', `${checksums}\nignoredOptionalDependencies:\n  - fsevents\n  - '@esbuild/*'\n\nsettings:`])
    const bare = header('packageExtensionsChecksum: 16a1ed6e7ce817a90048c6de502598af\n\npnpmfileChecksum: 4v4g43vz4g3vbbdiawo2fhluvq\n')
    assert.deepEqual([bare.packageExtensionsChecksum, bare.pnpmfileChecksum], ['16a1ed6e7ce817a90048c6de502598af', '4v4g43vz4g3vbbdiawo2fhluvq'])
    assert.deepEqual(bare.ignoredOptionalDependencies, ['fsevents', '@esbuild/*'])
    const sri = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
    const integrity = header(`packageExtensionsChecksum: ${sri}\n\npnpmfileChecksum: ${sri}\n`)
    assert.deepEqual([integrity.packageExtensionsChecksum, integrity.pnpmfileChecksum], [sri, sri])
    const none = parse(BASE)
    assert.deepEqual([none.packageExtensionsChecksum, none.pnpmfileChecksum, none.ignoredOptionalDependencies], [undefined, undefined, []])
  })

  it('when each direct dependency was published, where pnpm resolved by time', () => {
    const lock = read(['settings:', "time:\n  a@1.0.0: '2022-06-14T19:46:38.369Z'\n  d@file:d: '2011-03-15T17:51:47Z'\n\nsettings:"])
    assert.deepEqual(plain(lock.time), { 'a@1.0.0': '2022-06-14T19:46:38.369Z', 'd@file:d': '2011-03-15T17:51:47Z' })
    assert.deepEqual(plain(parse(BASE).time), {})
    assert.deepEqual(plain(read(['settings:', 'time: {}\n\nsettings:']).time), {})
  })

  it('the Node executable a dependency\'s bins run with', () => {
    const lock = read(['    devDependencies:', '    dependenciesMeta:\n      d:\n        node: /usr/local/bin/node18\n        injected: false\n    devDependencies:'])
    assert.deepEqual(plain(lock.importers['.'].dependenciesMeta), { d: { injected: false, node: '/usr/local/bin/node18' } })
  })

  it('a patch with its path, as pnpm 9 and 10 write it', () => {
    const lock = read([`  b@1.0.0: ${P}`, `  b@1.0.0:\n    hash: ${P}\n    path: patches/b@1.0.0.patch`])
    assert.deepEqual(plain(lock.patchedDependencies), { 'b@1.0.0': { hash: P, path: 'patches/b@1.0.0.patch' } })
  })

  it('each integrity algorithm', () => {
    for (const integrity of ['sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=', 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', 'sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb']) {
      assert.equal(read([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {integrity: ${integrity}}`]).packages[`b@1.0.0(patch_hash=${P})`].resolution.integrity, integrity)
    }
  })

  it('a git host\'s tarball of a subdirectory, as pnpm 11 marks it', () => {
    const lock = read(['    resolution: {tarball: https://example.com/f.tgz}', `    resolution: {integrity: ${I}, tarball: https://example.com/f.tgz, gitHosted: true, path: /packages/f}`])
    assert.deepEqual(lock.packages['f@https://example.com/f.tgz'].resolution, { type: 'tarball', integrity: I, tarball: 'https://example.com/f.tgz', path: '/packages/f', gitHosted: true })
  })

  it('a git subdirectory and a sha256 repository', () => {
    const long = `${C}${C.slice(0, 24)}`
    const text = edit([`repo: https://example.com/e.git, type: git}`, `repo: https://example.com/e.git, type: git, path: /packages/e}`]).replaceAll(C, long)
    const lock = parse(text)
    assert.deepEqual(lock.packages[`e@git+https://example.com/e.git#${long}`].resolution, { type: 'git', repo: 'https://example.com/e.git', commit: long, path: '/packages/e' })
  })

  it('what the manifest says', () => {
    const lock = read(['    peerDependencies:\n      c: ^2.0.0\n', `    peerDependencies:
      c: ^2.0.0
    peerDependenciesMeta:
      c:
        optional: true
    engines: {'0': node >=0.6.0, node: '>=18'}
    os: [linux, '!win32']
    cpu: [x64]
    libc: [musl]
    deprecated: gone
    hasBin: true
    bundledDependencies: [x, '@s/y']
    name: a
`])
    const pkg = lock.packages['a@1.0.0(c@2.0.0)']
    assert.deepEqual(plain(pkg.peerDependenciesMeta), { c: { optional: true } })
    assert.deepEqual(plain(pkg.engines), { 0: 'node >=0.6.0', node: '>=18' })
    assert.deepEqual([pkg.os, pkg.cpu, pkg.libc, pkg.deprecated, pkg.hasBin, pkg.bundledDependencies], [['linux', '!win32'], ['x64'], ['musl'], 'gone', true, ['x', '@s/y']])
    assert.equal(read(['  b@1.0.0:\n', '  b@1.0.0:\n    bundledDependencies: true\n']).packages[`b@1.0.0(patch_hash=${P})`].bundledDependencies, true)
  })

  it('what a snapshot says', () => {
    const lock = read(['      c: 2.0.0\n', '      c: 2.0.0\n    optionalDependencies:\n      d: file:d\n    optional: true\n    transitivePeerDependencies:\n      - x\n      - \'@s/y\'\n'])
    const pkg = lock.packages['a@1.0.0(c@2.0.0)']
    assert.deepEqual(plain(pkg.optionalDependencies), { d: 'd@file:d' })
    assert.equal(pkg.optional, true)
    assert.deepEqual(pkg.transitivePeerDependencies, ['x', '@s/y'])
  })

  it('peers past peersSuffixMaxLength, as the one hash pnpm puts in their place', () => {
    const hashed = 'a@1.0.0(3c43e3b4d70b446a2aae7f4f7fbeccdd)'
    const lock = read(['1.0.0(c@2.0.0)', '1.0.0(3c43e3b4d70b446a2aae7f4f7fbeccdd)'], ['a@1.0.0(c@2.0.0):', `${hashed}:`])
    assert.equal(lock.importers['.'].dependencies.a, hashed)
    assert.equal(lock.packages[hashed].name, 'a')
  })

  it('an importer\'s links, from its own directory, over and past the lockfile\'s', () => {
    const lock = read(['  .:\n', `  packages/p:
    dependencies:
      up:
        specifier: link:../..
        version: link:../..
      out:
        specifier: link:../../../x
        version: link:../../../x
      side:
        specifier: link:../q
        version: link:../q
      self:
        specifier: link:.
        version: link:.
    publishDirectory: dist
    linkDirectory: false

  .:
`])
    const importer = lock.importers['packages/p']
    assert.deepEqual(plain(importer.dependencies), { up: 'link:.', out: 'link:../x', side: 'link:packages/q', self: 'link:packages/p' })
    assert.deepEqual([importer.publishDirectory, importer.linkDirectory], ['dist', false])
  })

  it('names a prototype has are names like any other', () => {
    const lock = read(['      e:\n', `      constructor:\n        specifier: 1.0.0\n        version: b@1.0.0(patch_hash=${P})\n      e:\n`])
    assert.equal(lock.importers['.'].dependencies.constructor, `b@1.0.0(patch_hash=${P})`)
    assert.equal(lock.importers['.'].specifiers.constructor, '1.0.0')
  })

  const checkEnv = (env) => {
    assert.deepEqual(plain(env.importers['.']), {
      specifiers: { c: '2.0.0', pnpm: '12.6.0' },
      configDependencies: { c: 'c@2.0.0' },
      packageManagerDependencies: { pnpm: 'pnpm@12.6.0' },
    })
    assert.deepEqual(Object.keys(env.packages), ['c@2.0.0', 'pnpm@12.6.0'])
  }

  it('an env document before the lockfile', () => {
    for (const text of [`${ENV}${BASE}`, `${ENV}${BASE}`.replaceAll('\n', '\r\n'), `${ENV}\n\n${BASE}`]) {
      const { lockfile, env } = parsePnpmLockfile(text)
      checkEnv(env)
      assert.deepEqual(plain(lockfile), plain(parse(BASE)))
    }
  })

  it('an env document alone, which is no lockfile for the project', () => {
    for (const text of [ENV, ENV.replaceAll('\n', '\r\n'), `${ENV}\n  \n`]) {
      const { lockfile, env } = parsePnpmLockfile(text)
      checkEnv(env)
      assert.equal(lockfile, undefined)
    }
  })
})

describe('the document is refused', () => {
  it('when it is not text, or not the YAML pnpm writes', () => {
    assert.throws(() => parsePnpmLockfile(Buffer.from(BASE)), TypeError)
    assert.throws(() => parsePnpmLockfile(`${BASE}\tx: 1\n`), YamlError)
    assert.equal(YamlError, YamlErrorOfYaml, 'pnpm.js and yaml.js hand out one YamlError')
  })

  it('when it is not a mapping', () => {
    refuses('- a\n', 'expected a mapping, found a sequence', undefined)
  })

  it('in any other version', () => {
    refuses(edit(["lockfileVersion: '9.0'", "lockfileVersion: '6.0'"]), 'lockfileVersion: unsupported version: expected "9.0", found the string "6.0"', 'lockfileVersion')
    refuses(edit(["lockfileVersion: '9.0'", 'lockfileVersion: 5.4']), 'lockfileVersion: unsupported version: expected "9.0", found the number 5.4')
    refuses(edit(["lockfileVersion: '9.0'", 'lockfileVersion: 9']), 'lockfileVersion: unsupported version: expected "9.0", found the number 9')
    refuses(edit(["lockfileVersion: '9.0'\n", '']), 'lockfileVersion: unsupported version: expected "9.0", found nothing')
  })

  it('with a field this reader does not know', () => {
    for (const field of ['onlyBuiltDependencies', 'neverBuiltDependencies', 'untrackedPnpmfileReadPackageHook', 'resolutionMode']) {
      refuses(edit(['settings:', `${field}: x\n\nsettings:`]), `unsupported field "${field}"`, undefined)
    }
    refuses(edit(['  autoInstallPeers: true', '  resolutionMode: highest']), 'settings: unsupported field "resolutionMode"', 'settings')
  })

  it('without importers', () => {
    refuses(`lockfileVersion: '9.0'\n`, 'importers: expected a mapping, found nothing')
  })

  it('with a null where pnpm leaves a field out', () => {
    const doc = (header, importer = ' {}') => `lockfileVersion: '9.0'\n\n${header}importers:\n\n  .:${importer}\n`
    for (const field of ['settings', 'catalogs', 'overrides', 'patchedDependencies', 'time', 'packages', 'snapshots']) {
      refuses(doc(`${field}: null\n\n`), `${field}: expected a mapping, found null`, field)
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'dependenciesMeta']) {
      refuses(doc('', `\n    ${field}: null`), `importers["."].${field}: expected a mapping, found null`, `importers["."].${field}`)
    }
    for (const field of ['dependencies', 'optionalDependencies']) {
      refuses(edit(['  c@2.0.0: {}\n', `  c@2.0.0:\n    ${field}: null\n`]), `snapshots["c@2.0.0"].${field}: expected a mapping, found null`)
    }
    for (const kind of ['configDependencies', 'packageManagerDependencies']) {
      refuses(`---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    ${kind}: null\n\n---\n`, `env.importers["."].${kind}: expected a mapping, found null`)
    }
  })

  it('as more than one document, but for the env document first', () => {
    refuses(`${BASE}---\n${BASE}`, 'expected one document, found 2')
    // A `---` with nothing after it is an empty document to YAML.
    assert.throws(() => parsePnpmLockfile(`${BASE}---\n`), { name: 'YamlError', message: /^empty document/u })
  })

  it('with an env document that does not end where pnpm ends it', () => {
    const unended = 'expected the env document the first "---" starts to end at a line of "---"'
    refuses(`---\n${BASE}`, unended)
    refuses('---\n---\n', unended)
    refuses(ENV.slice(0, -1), unended)
    // pnpm ends it at a line of `---` alone, and only there.
    refuses(`---\n${BASE}---  \n${BASE}`, unended)
    refuses(`---\n${BASE}---  \n${BASE}---\n${BASE}`, 'expected the env document and the lockfile between lines of "---" alone, found 3 documents')
    refuses(`---\n${BASE}---  \n${BASE}---\n`, 'expected the env document between lines of "---" alone, found 2 documents')
    refuses(`---\n${BASE}---\n${BASE}---\n${BASE}`, 'expected the env document and the lockfile between lines of "---" alone, found 3 documents')
  })
})

describe('the header is held to what pnpm writes', () => {
  it('settings', () => {
    refuses(edit(['autoInstallPeers: true', "autoInstallPeers: 'true'"]), 'settings.autoInstallPeers: expected true or false, found the string "true"')
    refuses(edit(['autoInstallPeers: true', 'peersSuffixMaxLength: -1']), 'settings.peersSuffixMaxLength: expected a non-negative integer, found the number -1')
    refuses(edit(['autoInstallPeers: true', 'peersSuffixMaxLength: 1.5']), 'settings.peersSuffixMaxLength: expected a non-negative integer, found the number 1.5')
    refuses(edit(['settings:\n  autoInstallPeers: true', 'settings: []']), 'settings: expected a mapping, found a sequence')
  })

  it('patches', () => {
    refuses(edit([`  b@1.0.0: ${P}`, '  b@1.0.0: ABC']), 'patchedDependencies["b@1.0.0"]: "ABC" is not a patch hash')
    for (const hash of ['abc123', P.toUpperCase(), P.slice(0, -2), 'zrvjrhdgfsy5o3tngjlyoyyjcf', 'ZRVJRHDGFSY5O3TNGJLYOYYJCE']) {
      refuses(edit([`  b@1.0.0: ${P}`, `  b@1.0.0: ${hash}`]), `patchedDependencies["b@1.0.0"]: "${hash}" is not a patch hash`)
    }
    refuses(edit([`  b@1.0.0: ${P}`, `  b@1.0.0:\n    hash: ${P}`]), 'patchedDependencies["b@1.0.0"].path: expected a string, found nothing')
    refuses(edit([`  b@1.0.0: ${P}`, `  b@1.0.0:\n    hash: ${P}\n    path: /abs.patch`]), 'patchedDependencies["b@1.0.0"].path: "/abs.patch" is not a relative path in normal form')
    refuses(edit([`  b@1.0.0: ${P}`, `  b@1.0.0:\n    hash: ${P}\n    path: p\n    extra: 1`]), 'patchedDependencies["b@1.0.0"]: unsupported field "extra"')
    refuses(edit([`  b@1.0.0: ${P}`, `  b@1.0.0: ${P2}`]), `snapshots["b@1.0.0(patch_hash=${P})"]: the patch hash "${P}" is not in patchedDependencies`)
  })

  it('checksums and ignored optional dependencies', () => {
    const header = (line) => edit(['settings:', `${line}\n\nsettings:`])
    refuses(header('pnpmfileChecksum: ABC'), 'pnpmfileChecksum: "ABC" is not a checksum')
    for (const checksum of ['16a1ed6e7ce817a90048c6de502598a', '16A1ED6E7CE817A90048C6DE502598AF', '4v4g43vz4g3vbbdiawo2fhluvr', '4v4g43vz4g3vbbdiawo2fhluvq======']) {
      refuses(header(`pnpmfileChecksum: ${checksum}`), `pnpmfileChecksum: "${checksum}" is not a checksum`)
    }
    refuses(header('pnpmfileChecksum: sha512-abc'), 'pnpmfileChecksum: "sha512-abc" is not a checksum')
    refuses(header('pnpmfileChecksum: sha256-abc'), 'pnpmfileChecksum: "sha256-abc" is not a sha1, sha256, sha384 or sha512 integrity')
    refuses(header('packageExtensionsChecksum: 12'), 'packageExtensionsChecksum: expected a string, found the number 12')
    refuses(header('ignoredOptionalDependencies: fsevents'), 'ignoredOptionalDependencies: expected a sequence, found the string "fsevents"')
    refuses(header("ignoredOptionalDependencies: ['']"), 'ignoredOptionalDependencies[0]: expected a non-empty string')
    refuses(header('ignoredOptionalDependencies: null'), 'ignoredOptionalDependencies: expected a sequence, found null')
  })

  it('time', () => {
    const time = (line) => edit(['settings:', `time:\n  ${line}\n\nsettings:`])
    refuses(time("a@1.0.0(c@2.0.0): '2022-06-14T19:46:38.369Z'"), 'time["a@1.0.0(c@2.0.0)"]: "a@1.0.0(c@2.0.0)" is not in packages')
    refuses(time("z@1.0.0: '2022-06-14T19:46:38.369Z'"), 'time["z@1.0.0"]: "z@1.0.0" is not in packages')
    for (const stamp of ['2022-06-14', '2022-06-14T19:46:38', '2022-06-14T19:46:38+01:00', '2022-02-30T00:00:00Z', '2022-06-14T24:00:00Z', '2022-13-01T00:00:00Z', ' 2022-06-14T19:46:38Z']) {
      refuses(time(`a@1.0.0: '${stamp}'`), `time["a@1.0.0"]: ${JSON.stringify(stamp)} is not a UTC timestamp`)
    }
    refuses(time('a@1.0.0: 1655235998'), 'time["a@1.0.0"]: expected a string, found the number 1655235998')
  })

  it('catalogs and overrides', () => {
    refuses(edit(['settings:', 'catalogs:\n  default:\n    a:\n      specifier: ^1.0.0\n\nsettings:']), 'catalogs.default.a.version: expected a string, found nothing')
    refuses(edit(['settings:', 'catalogs:\n  default:\n    A B:\n      specifier: ^1.0.0\n      version: 1.0.0\n\nsettings:']), 'catalogs.default["A B"]: "A B" is not a package name')
    refuses(edit(['settings:', 'overrides:\n  a: 1\n\nsettings:']), 'overrides.a: expected a string, found the number 1')
  })
})

describe('a package is held to what pnpm writes', () => {
  it('with no field it does not know', () => {
    refuses(edit(['    version: 4.0.0', '    version: 4.0.0\n    id: x']), 'packages["f@https://example.com/f.tgz"]: unsupported field "id"')
    refuses(edit(['  b@1.0.0:\n', '  b@1.0.0:\n    patched: true\n']), 'packages["b@1.0.0"]: unsupported field "patched"')
    refuses(edit(['  c@2.0.0: {}', '  c@2.0.0:\n    dev: false']), 'snapshots["c@2.0.0"]: unsupported field "dev"')
  })

  it('with a resolution it knows', () => {
    refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {integrity: ${I}, revision: 2}`]), 'packages["b@1.0.0"].resolution: unsupported field "revision"')
    refuses(edit(['{directory: d, type: directory}', '{type: binary, url: https://x/y.zip}']), 'packages["d@file:d"].resolution.type: unsupported resolution type, the string "binary"')
    refuses(edit(['{directory: d, type: directory}', '{type: variations}']), 'packages["d@file:d"].resolution.type: unsupported resolution type, the string "variations"')
    refuses(edit(['{directory: d, type: directory}', "{type: 'custom:cdn'}"]), 'packages["d@file:d"].resolution.type: unsupported resolution type, the string "custom:cdn"')
    refuses(edit(['{directory: d, type: directory}', '{directory: d, type: directory, path: x}']), 'packages["d@file:d"].resolution: unsupported field "path"')
    refuses(edit(['    resolution: {tarball: https://example.com/f.tgz}', '    resolution: {}']), 'packages["f@https://example.com/f.tgz"].resolution: expected an integrity or a tarball')
    refuses(edit(['    resolution: {tarball: https://example.com/f.tgz}', '    resolution: {tarball: https://example.com/f.tgz, gitHosted: false}']), 'packages["f@https://example.com/f.tgz"].resolution.gitHosted: expected true, found the boolean false')
  })

  it('with an integrity of one known hash, at its length', () => {
    const where = 'packages["b@1.0.0"].resolution.integrity'
    for (const integrity of ['sha512-abc', 'md5-1B2M2Y8AsgTpgAmY7PhCfg==', `${I} ${I}`, `${I.slice(0, -1)}`, `sha1-${I.slice(7)}`]) {
      refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {integrity: '${integrity}'}`]), `${where}: ${shown(integrity)} is not a sha1, sha256, sha384 or sha512 integrity`)
    }
  })

  it('with a full commit, a repository and a tarball URL', () => {
    refuses(edit([`{commit: ${C},`, '{commit: 0123abc,']), `packages["e@git+https://example.com/e.git#${C}"].resolution.commit: "0123abc" is not a full commit hash`)
    refuses(edit([`{commit: ${C},`, `{commit: ${C.toUpperCase()},`]), `packages["e@git+https://example.com/e.git#${C}"].resolution.commit: "${C.toUpperCase()}" is not a full commit hash`)
    refuses(edit(['repo: https://example.com/e.git,', "repo: 'https://example.com/e.git --upload-pack=x',"]), `packages["e@git+https://example.com/e.git#${C}"].resolution.repo: "https://example.com/e.git --upload-pack=x" is not a repository URL`)
    for (const tarball of ['/c/-/c-2.0.0.tgz', 'c-2.0.0.tgz', 'ftp://example.com/c.tgz', 'https://', 'file:/abs/c.tgz', 'file:../x/./c.tgz']) {
      refuses(edit(['tarball: https://registry.npmjs.org/c/-/c-2.0.0.tgz', `tarball: '${tarball}'`]), `packages["c@2.0.0"].resolution.tarball: ${tarball.startsWith('file:') ? `"${tarball.slice(5)}" is not a relative path in normal form` : `"${tarball}" is not an http(s) URL or a file: path`}`)
    }
  })

  it('with a directory in normal form', () => {
    const where = 'packages["d@file:d"].resolution.directory'
    for (const directory of ['/d', './d', 'd/', 'd//e', 'd/../e', 'd\\e', 'C:/d', '']) {
      refuses(edit(['{directory: d, type: directory}', `{directory: '${directory}', type: directory}`]), directory === '' ? `${where}: expected a non-empty string` : directory.startsWith('C:') ? `${where}: "C:/d" starts with a drive letter` : `${where}: ${JSON.stringify(directory)} is not a relative path in normal form`)
    }
  })

  it('with a key of the form name@version', () => {
    for (const [key, message] of [
      ['A B@1.0.0', '"A B" is not a package name'],
      ['.a@1.0.0', '".a" is not a package name'],
      ['_a@1.0.0', '"_a" is not a package name'],
      ['a(b@1.0.0', '"a(b" is not a package name'],
      ['@s@1.0.0', '"@s" is not a package name'],
      [`${'n'.repeat(215)}@1.0.0`, `${shown('n'.repeat(215))} is not a package name`],
      ['b', '"b" is not a key of the form name@version'],
      ['b@', '"b@" is not a key of the form name@version'],
    ]) {
      refuses(edit(['  b@1.0.0:\n', `  '${key}':\n`]), `packages${key === 'b' ? '.b' : `[${shown(key)}]`}: ${message}`)
    }
    refuses(edit(['  b@1.0.0:\n', '  b@1.0.0(x@1.0.0):\n']), 'packages["b@1.0.0(x@1.0.0)"]: "b@1.0.0(x@1.0.0)" carries a peer or patch suffix, which only a snapshot key does')
    refuses(edit(['    peerDependencies:\n      c: ^2.0.0', '    name: z']), 'packages["a@1.0.0"].name: expected the name in the key, "a"')
  })

  it('with a version where pnpm writes one', () => {
    refuses(edit(['    peerDependencies:\n      c: ^2.0.0', '    version: 1.0.0']), 'packages["a@1.0.0"].version: a registry package has its version in its key')
    refuses(edit(['    version: 3.0.0\n', '']), `packages["e@git+https://example.com/e.git#${C}"]: expected a version, for a package not from the registry`)
    for (const version of ['v3.0.0', '3.0', '03.0.0', '3.0.0-', ' 3.0.0', `3.0.${2 ** 53}`, `3.0.0-${'x'.repeat(251)}`]) {
      refuses(edit(['    version: 3.0.0', `    version: '${version}'`]), `packages["e@git+https://example.com/e.git#${C}"].version: ${shown(version)} is not a version`)
    }
    refuses(edit(['    resolution: {directory: d, type: directory}', '    resolution: {directory: d, type: directory}\n    version: 1.0.0']), 'packages["d@file:d"].version: a directory has no version in the lockfile')
  })

  it('with a key that agrees with its resolution', () => {
    refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {commit: ${C}, repo: r, type: git}`]), 'packages["b@1.0.0"].resolution: expected a registry tarball with an integrity, for the version "1.0.0"')
    refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, '  b@1.0.0:\n    resolution: {tarball: https://example.com/b.tgz}']), 'packages["b@1.0.0"].resolution: expected a registry tarball with an integrity, for the version "1.0.0"')
    refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {integrity: ${I}, tarball: 'file:b.tgz'}`]), 'packages["b@1.0.0"].resolution: expected a registry tarball with an integrity, for the version "1.0.0"')
    refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {integrity: ${I}, path: /x}`]), 'packages["b@1.0.0"].resolution: expected a registry tarball with an integrity, for the version "1.0.0"')
    refuses(edit([`  b@1.0.0:\n    resolution: {integrity: ${I}}`, `  b@1.0.0:\n    resolution: {integrity: ${I}, tarball: https://example.com/b.tgz, gitHosted: true}`]), 'packages["b@1.0.0"].resolution: expected a registry tarball with an integrity, for the version "1.0.0"')
    refuses(edit(['{directory: d, type: directory}', '{directory: e, type: directory}']), 'packages["d@file:d"].resolution: "file:d" is not where the resolution says the package comes from')
    refuses(edit(['{directory: d, type: directory}', `{integrity: ${I}, tarball: 'file:e.tgz'}\n    version: 1.0.0`]), 'packages["d@file:d"].resolution: "file:d" is not where the resolution says the package comes from')
    refuses(edit(['    resolution: {tarball: https://example.com/f.tgz}', `    resolution: {integrity: ${I}}`]), 'packages["f@https://example.com/f.tgz"].resolution: "https://example.com/f.tgz" is not where the resolution says the package comes from')
    refuses(edit(['    resolution: {tarball: https://example.com/f.tgz}', "    resolution: {tarball: 'file:f.tgz'}"]), 'packages["f@https://example.com/f.tgz"].resolution: "https://example.com/f.tgz" is not where the resolution says the package comes from')
  })

  it('from no named registry or runtime', () => {
    const at = (key) => edit(['f@https://example.com/f.tgz:\n    resolution', `'${key}':\n    resolution`], ['version: https://example.com/f.tgz', `version: '${key}'`], ['  f@https://example.com/f.tgz: {}', `  '${key}': {}`])
    refuses(at('f@myreg:1.0.0'), 'packages["f@myreg:1.0.0"]: "myreg:1.0.0" is from a runtime or a named registry, which is not supported')
    refuses(at('f@runtime:22.0.0'), 'packages["f@runtime:22.0.0"]: "runtime:22.0.0" is from a runtime or a named registry, which is not supported')
    refuses(at('f@v4.0.0'), 'packages["f@v4.0.0"]: "v4.0.0" is neither a version nor a source')
  })

  it('with what the manifest says in the shape pnpm writes it', () => {
    const add = (lines) => edit(['  b@1.0.0:\n', `  b@1.0.0:\n${lines}`])
    refuses(add('    hasBin: false\n'), 'packages["b@1.0.0"].hasBin: expected true, found the boolean false')
    refuses(add('    os: linux\n'), 'packages["b@1.0.0"].os: expected a sequence, found the string "linux"')
    refuses(add("    cpu: ['']\n"), 'packages["b@1.0.0"].cpu[0]: expected a non-empty string')
    refuses(add('    engines: {node: 18}\n'), 'packages["b@1.0.0"].engines.node: expected a string, found the number 18')
    refuses(add('    deprecated: false\n'), 'packages["b@1.0.0"].deprecated: expected a string, found the boolean false')
    refuses(add('    bundledDependencies: false\n'), 'packages["b@1.0.0"].bundledDependencies: expected a sequence, found the boolean false')
    refuses(add('    bundledDependencies: [x, ../y]\n'), 'packages["b@1.0.0"].bundledDependencies[1]: "../y" is not a package name')
    refuses(add('    peerDependencies: {../x: 1.0.0}\n'), 'packages["b@1.0.0"].peerDependencies["../x"]: "../x" is not a package name')
    for (const field of ['engines', 'peerDependencies', 'peerDependenciesMeta']) refuses(add(`    ${field}: null\n`), `packages["b@1.0.0"].${field}: expected a mapping, found null`)
    refuses(add('    peerDependenciesMeta:\n      c: {optional: false}\n'), 'packages["b@1.0.0"].peerDependenciesMeta.c.optional: expected true, found the boolean false')
    refuses(add('    peerDependenciesMeta:\n      c: {optional: true, extra: true}\n'), 'packages["b@1.0.0"].peerDependenciesMeta.c: unsupported field "extra"')
  })
})

describe('snapshots and the graph are held together', () => {
  it('a snapshot has its package, and a package its snapshot', () => {
    refuses(edit(['  c@2.0.0: {}\n', '  c@2.0.0: {}\n\n  z@1.0.0: {}\n']), 'snapshots["z@1.0.0"]: "z@1.0.0" is not in packages')
    refuses(edit(['  a@1.0.0(c@2.0.0):\n', '  a@2.0.0(c@2.0.0):\n'], ['version: 1.0.0(c@2.0.0)', 'version: 2.0.0(c@2.0.0)']), 'snapshots["a@2.0.0(c@2.0.0)"]: "a@2.0.0" is not in packages')
    refuses(edit(['  c@2.0.0: {}\n', '']), 'snapshots["a@1.0.0(c@2.0.0)"].dependencies.c: "2.0.0" leads to "c@2.0.0", which is not in snapshots')
    refuses(edit(['  c@2.0.0:\n    resolution', '  z@1.0.0:\n    resolution: {integrity: x}\n\n  c@2.0.0:\n    resolution']), 'packages["z@1.0.0"].resolution.integrity: "x" is not a sha1, sha256, sha384 or sha512 integrity')
    refuses(edit(['  c@2.0.0:\n    resolution', `  z@1.0.0:\n    resolution: {integrity: ${I}}\n\n  c@2.0.0:\n    resolution`]), 'packages["z@1.0.0"]: no snapshot is of this package')
  })

  it('a snapshot key ends in its patch hash and peers, or nothing', () => {
    for (const [key, message] of [
      ['c@2.0.0()', '"c@2.0.0()" does not end in peers in parentheses'],
      [`c@2.0.0(x)(patch_hash=${P})`, `"c@2.0.0(x)(patch_hash=${P})" does not end in peers in parentheses`],
      ['c@2.0.0(patch_hash=ABC)', '"(patch_hash=ABC)" is not a patch hash'],
      ['c@2.0.0(patch_hash=a(b))', '"(patch_hash=a" is not a patch hash'],
    ]) {
      refuses(edit(['  c@2.0.0: {}\n', `  c@2.0.0: {}\n\n  '${key}': {}\n`]), `snapshots[${JSON.stringify(key)}]: ${message}`)
    }
  })

  it('a dependency leads to a snapshot, under one kind', () => {
    refuses(edit([`      b: 1.0.0(patch_hash=${P})`, '      b: 1.0.0']), 'snapshots["a@1.0.0(c@2.0.0)"].dependencies.b: "1.0.0" leads to "b@1.0.0", which is not in snapshots')
    refuses(edit(['      c: 2.0.0\n', '      c: 2.0.0\n    optionalDependencies:\n      c: 2.0.0\n']), 'snapshots["a@1.0.0(c@2.0.0)"].optionalDependencies.c: listed under dependencies too')
    refuses(edit(['      c: 2.0.0\n', '      ../c: 2.0.0\n']), 'snapshots["a@1.0.0(c@2.0.0)"].dependencies["../c"]: "../c" is not a package name')
    refuses(edit(['      c: 2.0.0\n', '      c: link:/c\n      x: 2.0.0\n']), 'snapshots["a@1.0.0(c@2.0.0)"].dependencies.c: "/c" is not a relative path in normal form')
    // pnpm's link into the package's own directory, for its `file:./c`.
    refuses(edit(['      c: 2.0.0\n', '      c: link:<root>/c\n      x: 2.0.0\n']), 'snapshots["a@1.0.0(c@2.0.0)"].dependencies.c: "link:<root>/c" leads into the package that asks for it, which is not supported')
    // An importer's is a directory named `<root>`, as pnpm writes `link:./<root>/l`.
    const literal = parse(edit(['        specifier: link:../l\n        version: link:../l\n', '        specifier: link:./<root>/l\n        version: link:<root>/l\n']))
    assert.equal(literal.importers['.'].dependencies.l, 'link:<root>/l')
  })

  it('every snapshot is reached from an importer', () => {
    refuses(edit(['      a:\n        specifier: ^1.0.0\n        version: 1.0.0(c@2.0.0)\n', '']), 'snapshots["a@1.0.0(c@2.0.0)"]: no importer depends on it, directly or not')
    refuses(edit([`      b: 1.0.0(patch_hash=${P})\n`, '']), `snapshots["b@1.0.0(patch_hash=${P})"]: no importer depends on it, directly or not`)
  })
})

describe('an importer is held to what pnpm writes', () => {
  it('its directory', () => {
    for (const id of ['./x', '/x', 'x/', 'x\\y']) {
      refuses(edit(['  .:\n', `  '${id}': {}\n\n  .:\n`]), `importers[${JSON.stringify(id)}]: ${JSON.stringify(id)} is not a relative path in normal form`)
    }
  })

  it('its fields', () => {
    refuses(edit(['    devDependencies:', '    specifiers: {}\n    devDependencies:']), 'importers["."]: unsupported field "specifiers"')
    refuses(edit(['    devDependencies:', '    dependenciesMeta:\n      d:\n        patch: x.patch\n    devDependencies:']), 'importers["."].dependenciesMeta.d: unsupported field "patch"')
    refuses(edit(['    devDependencies:', '    dependenciesMeta:\n      d:\n        node: 18\n    devDependencies:']), 'importers["."].dependenciesMeta.d.node: expected a string, found the number 18')
    refuses(edit(['    devDependencies:', '    dependenciesMeta:\n      d:\n        injected: yes\n    devDependencies:']), 'importers["."].dependenciesMeta.d.injected: expected true or false, found the string "yes"')
    refuses(edit(['    devDependencies:', '    linkDirectory: true\n    devDependencies:']), 'importers["."].linkDirectory: expected false, the only value pnpm writes')
    refuses(edit(['    devDependencies:', '    publishDirectory: ../../x/../y\n    devDependencies:']), 'importers["."].publishDirectory: "../../x/../y" is not a relative path in normal form')
  })

  it('its dependencies, each once, with a specifier and a target', () => {
    refuses(edit(['        specifier: file:d\n', '']), 'importers["."].devDependencies.d.specifier: expected a string, found nothing')
    refuses(edit(['        specifier: file:d\n', '        specifier: file:d\n        extra: 1\n']), 'importers["."].devDependencies.d: unsupported field "extra"')
    refuses(edit(['      d:\n        specifier: file:d\n        version: file:d', '      d: file:d']), 'importers["."].devDependencies.d: expected a mapping, found the string "file:d"')
    refuses(edit(['      d:\n        specifier: file:d', '      a:\n        specifier: file:d']), 'importers["."].devDependencies.a: listed under dependencies too')
    refuses(edit(['        version: file:d', '        version: file:e']), 'importers["."].devDependencies.d.version: "file:e" leads to "d@file:e", which is not in snapshots')
    refuses(edit(['        version: link:../l', "        version: 'link:'"]), 'importers["."].dependencies.l.version: expected a non-empty string')
    refuses(edit(['        version: link:../l', '        version: link:../l/']), 'importers["."].dependencies.l.version: "../l/" is not a relative path in normal form')
  })
})

describe('the env document is held to what pnpm writes', () => {
  const env = (importers, extra = '') => `---\nlockfileVersion: '9.0'\n${extra}\nimporters:\n${importers}\n---\n${BASE}`
  const pm = '    configDependencies: {}\n'

  it('one importer, `.`, with its two kinds', () => {
    refuses(env(`  .:\n${pm}  x:\n${pm}`), 'env.importers.x: the env document has no importer but "."')
    refuses(env('  .:\n    dependencies: {}\n'), 'env.importers["."]: unsupported field "dependencies"')
    refuses(env('  {}\n'), 'env.importers: expected the "." importer')
  })

  it('no header of its own', () => {
    refuses(env(`  .:\n${pm}`, 'settings: {}\n'), 'env: unsupported field "settings"')
    refuses(`---\nlockfileVersion: '6.0'\nimporters: {}\n---\n${BASE}`, 'env.lockfileVersion: unsupported version: expected "9.0", found the string "6.0"')
  })
})

describe('messages quote what they show', () => {
  it('controls and bidirectional marks are escaped, and length cut', () => {
    refuses(edit(['  b@1.0.0:\n', '  "b\\e[2J\\u202E@1.0.0":\n']), 'packages["b\\u001b[2J\\u202e@1.0.0"]: "b\\u001b[2J\\u202e" is not a package name')
  })
})

describe('packageKeyOf, from the front door', () => {
  it('drops the patch hash and the peers of a key in packages', () => {
    const lock = parse(BASE)
    assert.deepEqual(Object.keys(lock.packages).map(packageKeyOf), ['a@1.0.0', 'b@1.0.0', 'c@2.0.0', 'd@file:d', `e@git+https://example.com/e.git#${C}`, 'f@https://example.com/f.tgz'])
    assert.equal(packageKeyOf('ws@file:packages/ws(patch_hash=abc)(react@18.2.0)'), 'ws@file:packages/ws')
    assert.equal(packageKeyOf('a@1.0.0(3c43e3b4d70b446a2aae7f4f7fbeccdd)'), 'a@1.0.0')
  })

  it('leaves a key without a suffix as it is, and refuses anything but a string', () => {
    assert.equal(packageKeyOf('a@1.0.0'), 'a@1.0.0')
    assert.equal(packageKeyOf(''), '')
    assert.throws(() => packageKeyOf(undefined), { name: 'TypeError', message: 'expected a string' })
    assert.throws(() => packageKeyOf(['a@1.0.0']), TypeError)
  })
})
