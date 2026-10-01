import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError, parseYarn1Lockfile } from '../../yarn1.js'

// The baseline: real lockfiles, each with the manifests it was written
// for, by directory. yarn 1.22.22 and 1.22.19 wrote one workspace that
// pulls in every kind of dependency yarn 1 records; yarn 1.9.4, 1.22.19
// and 1.22.22 a plain project; and the last are yarn's two ways of
// installing something other than its lockfile says, the aliases 1.22.19
// merges and a resolution's tarball given to a dependency it does not
// apply to, beside resolutions to tarballs it applies to wherever they are
// asked for. scripts/record-yarn1.js builds them; its header says what is
// in them.

const FIXTURES = new URL('fixtures/', import.meta.url)
const text = (name) => readFileSync(new URL(`${name}.lock`, FIXTURES), 'utf8')
const manifests = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
const read = (name) => parseYarn1Lockfile(text(name), manifests(name))

const plain = (value) => structuredClone(value)
const unique = (lock) => [...new Set(Object.values(lock.packages))]

// Refused with the manifests with `message`, and without them with `alone`.
const refuses = (name, message, alone = message) => {
  for (const [given, expected] of [[undefined, alone], [manifests(name), message]]) {
    assert.throws(() => parseYarn1Lockfile(text(name), given), (error) => error instanceof LockfileError && error.message === expected)
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
    assert.throws(() => parseYarn1Lockfile(text('yarn-1.22.22-resolutions')), /which only a resolution may, as the manifests would say$/u)
  })
})
