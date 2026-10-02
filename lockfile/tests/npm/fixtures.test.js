import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError } from '../../npm.js'
import { fixture, parse, plain } from './base.js'

// The baseline: real lockfiles. npm 9, 10, 11 and 12 wrote one workspace
// that pulls in every kind of dependency a lockfile records; npm 11 a plain
// project indented with a tab, with CRLF line ends, once more with the
// registry's URLs left out; a project of peers and of packages both dev and
// optional; one that asks for a directory out of it; and one an override
// gives a version of a package its dependent does not ask for.
// scripts/record-npm.js builds them; its header says what is in them.

const read = (name, options) => parse(fixture(name), options)
const VERSIONS = ['npm-9', 'npm-10', 'npm-11', 'npm-12']

const flags = (node) => ['dev', 'optional', 'devOptional', 'peer'].filter((flag) => node[flag])

describe('every version reads to the same workspace', () => {
  const locks = Object.fromEntries(VERSIONS.map((name) => [name, read(name)]))
  const base = locks['npm-11']

  it('the same packages, where npm installs them, from the same places', () => {
    assert.equal(Object.keys(base.packages).length, 23)
    for (const name of VERSIONS) {
      const lock = locks[name]
      assert.deepEqual(Object.keys(lock.packages), Object.keys(base.packages), name)
      for (const [location, pkg] of Object.entries(lock.packages)) {
        const { name: pkgName, version, resolution } = base.packages[location]
        assert.deepEqual([pkg.name, pkg.version], [pkgName, version], `${name} ${location}`)
        if (resolution?.type !== 'git') assert.deepEqual(pkg.resolution, resolution, `${name} ${location}`)
      }
    }
  })

  it('the same importers, links and edges', () => {
    for (const name of VERSIONS) {
      const lock = locks[name]
      assert.deepEqual(plain(lock.links), plain(base.links), name)
      assert.deepEqual(Object.keys(lock.importers), ['.', 'local-dir', 'packages/ws-a', 'packages/ws-b', 'packages/ws-c'], name)
      for (const [location, node] of [...Object.entries(lock.importers), ...Object.entries(lock.packages)]) {
        const other = base.importers[location] ?? base.packages[location]
        assert.deepEqual(plain(node.edges), plain(other.edges), `${name} ${location}`)
        assert.deepEqual(flags(node), flags(other), `${name} ${location}`)
      }
    }
  })

  it('a repository on GitHub by ssh, and by https from npm 12', () => {
    for (const name of VERSIONS) {
      const { resolution } = locks[name].packages['node_modules/isarray']
      const repo = name === 'npm-12' ? 'git+https://github.com/juliangruber/isarray.git' : 'git+ssh://git@github.com/juliangruber/isarray.git'
      assert.deepEqual(resolution, { type: 'git', repo, commit: '63ea4ca0a0d6b0574d6a470ebd26880c3026db4a' }, name)
    }
  })

  it('licenses from npm 10, libc from npm 11', () => {
    const sharp = (name) => locks[name].packages['node_modules/@img/sharp-linux-x64']
    assert.deepEqual(VERSIONS.map((name) => sharp(name).license), [undefined, 'Apache-2.0', 'Apache-2.0', 'Apache-2.0'])
    assert.deepEqual(VERSIONS.map((name) => sharp(name).libc), [undefined, undefined, ['glibc'], ['glibc']])
  })
})

describe('a workspace, as npm 11 writes it', () => {
  const { importers, packages, links } = read('npm-11')
  const root = importers['.']

  it('the workspaces, linked from the project\'s node_modules, one under another name', () => {
    assert.deepEqual(['packages/ws-a', 'packages/ws-b', 'packages/ws-c', 'local-dir'].map((dir) => importers[dir].workspace), [true, true, true, false])
    assert.equal(links['node_modules/@fixture/ws-c'], 'packages/ws-c')
    assert.equal(importers['packages/ws-c'].name, '@fixture/ws-c')
    assert.deepEqual(plain(root.edges['@fixture/ws-c']), { type: 'workspace', spec: 'file:packages/ws-c', accept: undefined, target: 'link:packages/ws-c' })
    assert.equal(root.edges['ws-a'].type, 'workspace')
  })

  it('a dependency nested where two versions meet, in a workspace and in a package', () => {
    assert.equal(importers['packages/ws-a'].edges['is-number'].target, 'packages/ws-a/node_modules/is-number')
    assert.equal(importers['packages/ws-b'].edges['is-number'].target, 'node_modules/is-number')
    assert.equal(packages['node_modules/local-tgz'].edges['is-number'].target, 'node_modules/local-tgz/node_modules/is-number')
    assert.deepEqual([packages['node_modules/is-number'].version, packages['packages/ws-a/node_modules/is-number'].version], ['6.0.0', '7.0.0'])
  })

  it('a directory, linked, with what it asks for in its own node_modules', () => {
    assert.equal(root.edges['local-dir'].target, 'link:local-dir')
    assert.equal(importers['local-dir'].edges['is-number'].target, 'local-dir/node_modules/is-number')
  })

  it('a tarball by URL, under its name and an alias, and an npm alias', () => {
    assert.deepEqual([packages['node_modules/odd-alias'].name, packages['node_modules/my-q'].name], ['is-odd', 'q'])
    assert.deepEqual(packages['node_modules/odd-alias'].resolution, packages['node_modules/is-odd'].resolution)
    assert.equal(root.edges['my-q'].spec, 'npm:q@1.5.1')
  })

  it('a local tarball with a bin and an install script, and one that bundles a package', () => {
    const tgz = packages['node_modules/local-tgz']
    assert.deepEqual([plain(tgz.bin), tgz.hasInstallScript, tgz.resolution.tarball], [{ 'local-tgz': 'cli.js' }, true, 'file:vendor/local-tgz-1.0.0.tgz'])
    assert.deepEqual(packages['node_modules/bundler'].bundleDependencies, ['is-number'])
    const bundled = packages['node_modules/bundler/node_modules/is-number']
    assert.deepEqual([bundled.inBundle, bundled.resolution], [true, undefined])
    assert.equal(packages['node_modules/bundler'].edges['is-odd'].target, 'node_modules/is-odd')
  })

  it('peers, an optional one left out, dev and optional ones and platform packages', () => {
    assert.equal(packages['node_modules/react-dom'].edges.react.type, 'peer')
    assert.deepEqual(plain(packages['node_modules/ws'].edges.bufferutil), { type: 'peerOptional', spec: '^4.0.1', accept: undefined, target: undefined })
    assert.deepEqual(flags(packages['node_modules/mkdirp']), ['dev', 'devOptional'])
    const fsevents = packages['node_modules/fsevents']
    assert.deepEqual([flags(fsevents), fsevents.os, fsevents.hasInstallScript], [['optional', 'devOptional'], ['darwin'], true])
    assert.deepEqual(flags(packages['node_modules/@img/sharp-libvips-linux-x64']), ['optional', 'devOptional'])
    assert.deepEqual(flags(packages['node_modules/is-number']), [])
  })

  it('a deprecated package', () => {
    assert.equal(packages['node_modules/left-pad'].deprecated, 'use String.prototype.padStart()')
  })
})

describe('a plain project, as npm 11 writes it', () => {
  it('indented with a tab, with CRLF line ends, as its package.json is', () => {
    assert.match(fixture('npm-11-plain'), /^\{\r\n\t"name": "plain",\r\n/u)
    assert.equal(Object.keys(read('npm-11-plain').packages).length, 3)
  })

  it('with the registry\'s URLs left out, the same but for them', () => {
    const omitted = read('npm-11-plain-omitted')
    const full = read('npm-11-plain')
    for (const [location, pkg] of Object.entries(full.packages)) {
      assert.deepEqual(omitted.packages[location].resolution, { ...pkg.resolution, tarball: undefined }, location)
    }
  })
})

describe('the flags npm works out', () => {
  const { importers, packages } = read('npm-11-flags')

  it('a peer npm installs, of a dependency\'s', () => {
    assert.deepEqual([packages['node_modules/react'].version, flags(packages['node_modules/react'])], ['18.3.1', ['peer']])
  })

  it('a package both dev and optional', () => {
    assert.deepEqual(flags(packages['node_modules/is-number']), ['devOptional'])
    assert.deepEqual(flags(packages['node_modules/to-regex-range']), ['dev', 'devOptional'])
  })

  it('a name both in dependencies and in devDependencies, a dev dependency alone', () => {
    assert.equal(importers['.'].edges['left-pad'].type, 'dev')
    assert.deepEqual(flags(packages['node_modules/left-pad']), ['dev', 'devOptional'])
  })
})

describe('a directory out of the project', () => {
  it('linked, and what it asks for left to it', () => {
    const { importers, links } = read('npm-11-outside')
    assert.equal(links['node_modules/outside'], '../outside')
    assert.deepEqual(Object.values(importers['../outside'].edges).map((edge) => edge.target), [undefined, undefined])
  })
})

describe('an override, which the lockfile does not record', () => {
  it('refused where versions are checked, and read where not', () => {
    assert.throws(() => read('npm-11-overrides'), (error) => error instanceof LockfileError && error.message === 'packages["node_modules/react-dom"].dependencies.scheduler: "^0.23.0" is not satisfied by "node_modules/scheduler", 0.20.2, so npm would install another')
    assert.equal(read('npm-11-overrides', { checkVersions: false }).packages['node_modules/scheduler'].version, '0.20.2')
  })
})
