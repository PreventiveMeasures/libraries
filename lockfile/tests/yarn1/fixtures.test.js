import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError, parseYarn1Lockfile } from '../../yarn1.js'
import { semver } from './semver.js'

// The baseline: real lockfiles, each with the manifests it was written
// for, by directory. yarn 1.22.22 and 1.22.19 wrote one workspace that
// pulls in every kind of dependency yarn 1 records; yarn 1.9.4, 1.22.19
// and 1.22.22 a plain project; yarn 1.22.22 a workspace a package asks
// for, a resolution of the root's own through the workspaces' aggregator,
// one of what another rewrites, and one to a workspace; and the last are
// yarn's ways of installing something other than its lockfile says, the
// aliases 1.22.19 merges, a resolution the root's own dependency is not
// given, or given where its range does not take it, one entry for a
// request a resolution rewrites and one it does not, a resolution's
// tarball given to a dependency it does not apply to, and two entries of
// one name and version, beside resolutions to tarballs it applies to
// wherever they are asked for. scripts/record-yarn1.js builds them; its
// header says what is in them.

const FIXTURES = new URL('fixtures/', import.meta.url)
const parse = (text, manifests) => parseYarn1Lockfile(text, { manifests, semver })
const text = (name) => readFileSync(new URL(`${name}.lock`, FIXTURES), 'utf8')
const manifests = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
const read = (name) => parse(text(name), manifests(name))

const plain = (value) => structuredClone(value)
const unique = (lock) => [...new Set(Object.values(lock.packages))]

// Refused with the manifests with `message`, and without them with `alone`.
const refuses = (name, message, alone = message) => {
  for (const [given, expected] of [[undefined, alone], [manifests(name), message]]) {
    assert.throws(() => parse(text(name), given), (error) => error instanceof LockfileError && error.message === expected)
  }
}

describe('a workspace, as yarn 1.22.22 writes it', () => {
  const lock = read('yarn-1.22.22')
  const { packages, importers } = lock

  it('every package, once for each entry', () => {
    assert.equal(Object.keys(packages).length, 35)
    assert.equal(unique(lock).length, 27)
  })

  it('the importers: the project and its workspaces, linked', () => {
    assert.deepEqual(Object.keys(importers), ['.', 'packages/ws-a', 'packages/ws-b'])
    assert.equal(importers['.'].dependencies['ws-a'], 'link:packages/ws-a')
    assert.equal(importers['packages/ws-a'].dependencies['ws-b'], 'link:packages/ws-b')
    assert.equal(importers['packages/ws-a'].devDependencies.mkdirp, 'mkdirp@^1.0.0')
    assert.equal(packages['mkdirp@^1.0.0'], packages[importers['.'].devDependencies.mkdirp])
    assert.deepEqual(plain(importers['.'].optionalDependencies), { '@img/sharp-linux-x64': '@img/sharp-linux-x64@0.33.5', fsevents: 'fsevents@2.3.3' })
  })

  it('a workspace\'s directories, as yarn records them from the lockfile\'s', () => {
    assert.deepEqual(plain(importers['packages/ws-b'].dependencies), {
      'is-number': 'is-number@6.0.0', linked: 'linked@link:linked', 'local-dir': 'local-dir@file:local-dir', 'object-assign': 'object-assign@', q: 'q@1.5.1',
    })
    assert.equal(packages['local-dir@file:local-dir'], packages['local-dir@file:./local-dir'])
    assert.notEqual(packages['linked@link:linked'], packages['linked@link:./linked'])
  })

  it('a link and a directory, which the lockfile does not lock', () => {
    const link = packages['linked@link:./linked']
    assert.deepEqual([link.version, link.uid, link.resolution], ['0.0.0', '', undefined])
    assert.deepEqual([packages['linked@link:linked'].version, packages['linked@link:linked'].uid], ['0.0.1', undefined])
    assert.equal(packages['local-dir@file:./local-dir'].resolution, undefined)
    assert.equal(packages['local-dir@file:./local-dir'].dependencies['is-number'], 'is-number@^7.0.0')
  })

  it('a git repository, a tarball by URL under its name and an alias, a local tarball', () => {
    assert.deepEqual(packages['isarray@git+https://github.com/juliangruber/isarray.git#v2.0.5'].resolution, {
      type: 'git', repo: 'git+https://github.com/juliangruber/isarray.git', commit: '63ea4ca0a0d6b0574d6a470ebd26880c3026db4a',
    })
    const odd = packages['is-odd@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz']
    const alias = packages['odd-alias@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz']
    assert.deepEqual([odd.name, alias.name], ['is-odd', 'odd-alias'])
    assert.deepEqual(plain(alias.resolution), plain(odd.resolution))
    assert.deepEqual(odd.resolution, { type: 'tarball', tarball: 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz', sha1: '65101baf3727d728b66fa62f50cda7f2d3989601', integrity: undefined })
    assert.equal(packages['local-tgz@file:vendor/local-tgz-1.0.0.tgz'].resolution.tarball, 'file:vendor/local-tgz-1.0.0.tgz')
  })

  it('an npm alias, apart from the package it aliases', () => {
    assert.equal(packages['my-q@npm:q@1.5.1'].name, 'my-q')
    assert.notEqual(packages['my-q@npm:q@1.5.1'], packages['q@1.5.1'])
    assert.equal(packages['my-q@npm:q@1.5.1'].resolution.tarball, packages['q@1.5.1'].resolution.tarball)
  })

  it('a resolution, beside the patterns it was applied to', () => {
    assert.deepEqual(packages['loose-envify@1.4.0'].patterns, ['loose-envify@1.4.0', 'loose-envify@^1.1.0', 'loose-envify@^1.4.0'])
    assert.equal(packages['react@18.2.0'].dependencies['loose-envify'], 'loose-envify@^1.1.0')
  })

  it('a range left empty', () => {
    assert.deepEqual(packages['object-assign@'].patterns, ['object-assign@', 'object-assign@^4.1.1'])
  })

  it('optional platform packages, and theirs', () => {
    assert.deepEqual(plain(packages['@img/sharp-linux-x64@0.33.5'].optionalDependencies), { '@img/sharp-libvips-linux-x64': '@img/sharp-libvips-linux-x64@1.0.4' })
    assert.match(packages['fsevents@2.3.3'].resolution.integrity, /^sha512-/u)
  })
})

describe('a plain project, as yarn 1.9.4, 1.22.19 and 1.22.22 write it', () => {
  const locks = Object.fromEntries(['1.9.4', '1.22.19', '1.22.22'].map((version) => [version, read(`yarn-${version}-plain`)]))
  const without = (lock) => plain(Object.fromEntries(Object.entries(lock.packages).map(([key, pkg]) => [key, { ...pkg, resolution: pkg.resolution && { ...pkg.resolution, integrity: undefined } }])))

  it('reads to the same packages, but for the integrity 1.9.4 does not write', () => {
    assert.equal(Object.keys(locks['1.22.22'].packages).length, 9)
    for (const version of ['1.9.4', '1.22.19']) assert.deepEqual(without(locks[version]), without(locks['1.22.22']), version)
    assert.ok(unique(locks['1.9.4']).every((pkg) => pkg.resolution.integrity === undefined))
    assert.ok(unique(locks['1.22.19']).every((pkg) => pkg.resolution.type === 'git' || pkg.resolution.integrity !== undefined))
    assert.deepEqual(plain(locks['1.22.19']), plain(locks['1.22.22']))
  })

  it('with the versions of yarn and Node that wrote it, where yarn is set to', () => {
    assert.match(text('yarn-1.22.22-plain'), /^# yarn lockfile v1\n# yarn v1\.22\.22\n# node v\d+/mu)
  })
})

describe('a workspace a package asks for, which yarn links and writes no entry for', () => {
  it('read with the manifests, and refused without, as nothing else says it is a workspace', () => {
    assert.equal(read('yarn-1.22.22-linked').packages['to-regex-range@5.0.1'].dependencies['is-number'], 'link:packages/is-number')
    assert.throws(() => parse(text('yarn-1.22.22-linked')), /"is-number@\^7\.0\.0" is not a pattern of the lockfile, nor a workspace's, as only the manifests may say$/u)
  })
})

describe('a resolution, which yarn applies to no dependency of the root\'s own, and does not say so', () => {
  it('refused where it would apply to the project\'s is-number@^6.0.0, which keeps 6.0.0', () => {
    assert.deepEqual(Object.keys(parse(text('yarn-1.22.22-resolution-root')).packages), ['is-number@7.0.0', 'is-number@^6.0.0'])
    assert.throws(() => read('yarn-1.22.22-resolution-root'), { message: 'manifests["."].dependencies["is-number"]: "is-number@^6.0.0" is not given "is-number@7.0.0" as the resolution "is-number" says, which yarn ignores for the root\'s own dependencies' })
  })

  it('refused where one entry of the same range serves the project and is-odd, which it applies to', () => {
    refuses('yarn-1.22.22-resolution-same-range', '["is-odd@3.0.1"].dependencies["is-number"]: "is-number@^6.0.0" is asked for both where the resolution "is-number" applies and where none does, and yarn writes one entry for both', '["is-number@^6.0.0"]: 7.0.0 does not satisfy "^6.0.0", which only a resolution may excuse, as the manifests would say')
  })

  it('refused where the resolution is given to it all the same', () => {
    const merged = text('yarn-1.22.22-resolution-root').replace(/\n\nis-number@\^6\.0\.0:\n[^]*$/u, '\n').replace('is-number@7.0.0:', 'is-number@7.0.0, is-number@^6.0.0:')
    assert.throws(() => parse(merged, manifests('yarn-1.22.22-resolution-root')), { message: '["is-number@^6.0.0"]: 7.0.0 does not satisfy "^6.0.0", and no resolution gives it' })
  })
})

describe('a resolution of the root\'s own, which yarn applies through the workspaces\' aggregator', () => {
  it('the project\'s is-number@6.0.0 given the tarball, with workspaces, and refused without', () => {
    const { packages, importers } = read('yarn-1.22.22-resolution-aggregated')
    assert.equal(importers['.'].dependencies['is-number'], 'is-number@6.0.0')
    assert.equal(packages['is-number@6.0.0'].resolution.tarball, 'file:./vendor/is-number-6.0.0.tgz')
    const root = { ...manifests('yarn-1.22.22-resolution-aggregated')['.'], workspaces: undefined }
    assert.throws(() => parse(text('yarn-1.22.22-resolution-aggregated'), { '.': root }), { message: 'manifests["."].dependencies["is-number"]: "is-number@6.0.0" is given what the resolution "is-number" resolves to, which yarn applies to no dependency of the root\'s own' })
  })

  it('refused where the version does not satisfy the range, which the root asks for first', () => {
    refuses('yarn-1.22.22-resolution-root-aggregated', '["is-number@^6.0.0"]: 7.0.0 does not satisfy "^6.0.0", which the root asks for before the resolution "is-number" applies, so yarn takes it as outdated', '["is-number@^6.0.0"]: 7.0.0 does not satisfy "^6.0.0", which only a resolution may excuse, as the manifests would say')
  })
})

describe('a resolution to a workspace, which yarn links, and writes an entry for apart', () => {
  const name = 'yarn-1.22.22-resolution-workspace'

  it('is-odd\'s is-number@^6.0.0 linked as to-regex-range\'s is-number@^7.0.0 is, its entry left out', () => {
    const { packages, importers } = read(name)
    assert.equal(importers['packages/is-number'].dependencies.other, 'link:packages/other')
    assert.equal(packages['is-odd@3.0.1'].dependencies['is-number'], 'link:packages/is-number')
    assert.equal(packages['to-regex-range@5.0.1'].dependencies['is-number'], 'link:packages/is-number')
    assert.deepEqual(Object.keys(packages), ['is-odd@3.0.1', 'isarray@2.0.5', 'to-regex-range@5.0.1'])
  })

  it('refused where the entry is not of the workspace, or without the manifests', () => {
    const stale = text(name).replace('  version "7.0.0"', '  version "6.0.0"')
    assert.throws(() => parse(stale, manifests(name)), { message: '["is-number@^6.0.0"].version: another version than the workspace "packages/is-number", which the resolution "is-number" gives it, 7.0.0' })
    const other = text(name).replace('    isarray "2.0.5"\n', '    is-odd "3.0.1"\n    isarray "2.0.5"\n')
    assert.notEqual(other, text(name))
    assert.throws(() => parse(other, manifests(name)), { message: '["is-number@^6.0.0"].dependencies: other dependencies than the workspace "packages/is-number", which the resolution "is-number" gives it' })
    assert.throws(() => parse(text(name)), { message: '["is-number@^6.0.0"].dependencies.other: "other@1.0.0" is not a pattern of the lockfile, nor a workspace\'s, as only the manifests may say' })
  })

  it('refused where the root asks for it too, which the aggregator asks for as the workspace instead', () => {
    const asked = manifests(name)
    asked['.'].dependencies['is-number'] = '^6.0.0'
    assert.throws(() => parse(text(name), asked), { message: 'manifests["."].dependencies["is-number"]: "is-number@^6.0.0" is given what the resolution "is-number" resolves to, which yarn applies to no dependency of the root\'s own' })
  })
})

describe('a resolution of what one rewrites, which yarn reads from the root alone', () => {
  it('is-even\'s is-odd given 3.0.1, whose is-number is-odd/is-number gives 7.0.0', () => {
    const { packages } = read('yarn-1.22.22-resolution-nested')
    assert.equal(packages['is-odd@^0.1.2'].version, '3.0.1')
    assert.equal(packages['is-number@^6.0.0'].version, '7.0.0')
  })
})

describe('what yarn installs otherwise than it says is refused', () => {
  it('the workspace as yarn 1.22.19 writes it, an alias in one entry with the package', () => {
    refuses('yarn-1.22.19', '["is-odd@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz"]: "is-odd@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz" and "odd-alias@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz" give it two names, of which yarn installs it under one alone')
  })

  it('the aliases yarn 1.22.19 merges, then names after the alias, and 1.22.22 writes apart', () => {
    assert.match(text('yarn-1.22.19-aliases'), /^"string-width-cjs@npm:string-width@\^4\.2\.0", string-width@\^4\.2\.0:\n {2}name string-width-cjs$/mu)
    refuses('yarn-1.22.19-aliases', '["string-width-cjs@npm:string-width@^4.2.0"]: "string-width-cjs@npm:string-width@^4.2.0" and "string-width@^4.2.0" give it two names, of which yarn installs it under one alone')
    const { packages } = read('yarn-1.22.22-aliases')
    assert.notEqual(packages['string-width-cjs@npm:string-width@^4.2.0'], packages['string-width@^4.2.0'])
    assert.equal(packages['string-width@^4.2.0'].name, 'string-width')
  })

  const unresolved = '"is-number@^6.0.0" asks for the registry, and is given what "is-number@file:./vendor/is-number-6.0.0.tgz" names, which only a resolution may, as the manifests would say'

  it('a resolution of one dependency\'s is-number, given to the project\'s', () => {
    refuses(
      'yarn-1.22.22-resolution',
      'manifests["."].dependencies["is-number"]: "is-number@6.0.0" is given what the resolution "is-odd/is-number" resolves to, which yarn applies to no dependency of the root\'s own',
      `["is-number@6.0.0"]: ${unresolved.replace('^6.0.0', '6.0.0')}`,
    )
  })

  it('a resolution\'s tarball, which a dependency asks for as well', () => {
    refuses('yarn-1.22.22-resolution-shared', '["num@file:./vendor/is-number-6.0.0.tgz"]: asks for what the resolution "is-number" resolves to, as a dependency of its own', `["is-number@^6.0.0"]: ${unresolved}`)
  })

  it('two entries of is-number 7.0.0, of which yarn gives the registry\'s range whichever it resolves first', () => {
    refuses('yarn-1.22.22-race', '["is-number@file:./vendor/is-number-7.0.0.tgz"]: is is-number 7.0.0, as "is-number@^7.0.0" is, and yarn gives "is-number@^7.0.0" whichever it resolves first')
  })

  it('a resolution of a workspace\'s is-number that does not reach it, as yarn asks through its aggregator', () => {
    refuses('yarn-1.22.22-resolution-scoped', 'manifests["packages/ws-a"].dependencies["is-number"]: "is-number@^6.0.0" is given what the resolution "ws-a/is-number" resolves to, which yarn does not apply to it here', `["is-number@^6.0.0"]: ${unresolved}`)
  })
})

describe('resolutions to tarballs, where yarn applies them to every request', () => {
  const { packages, importers } = read('yarn-1.22.22-resolutions')

  it('a local tarball for is-number, wherever it is asked for, a workspace\'s own among them', () => {
    assert.equal(importers['packages/ws-a'].dependencies['is-number'], 'is-number@^6.0.0')
    assert.deepEqual(packages['is-number@^6.0.0'].patterns, ['is-number@^6.0.0', 'is-number@file:./vendor/is-number-6.0.0.tgz'])
    assert.equal(packages['is-number@^6.0.0'].resolution.tarball, 'file:./vendor/is-number-6.0.0.tgz')
  })

  it('a URL for is-even\'s is-odd alone', () => {
    assert.equal(packages['is-even@1.0.0'].dependencies['is-odd'], 'is-odd@^0.1.2')
    assert.deepEqual([packages['is-odd@^0.1.2'].version, packages['is-odd@^0.1.2'].resolution.tarball], ['3.0.1', 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz'])
  })

  it('without the manifests, refused, as it cannot say what is a resolution', () => {
    assert.throws(() => parse(text('yarn-1.22.22-resolutions')), /which only a resolution may, as the manifests would say$/u)
  })
})
