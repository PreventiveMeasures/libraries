import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseNpmLockfile } from '../../npm.js'
import { at } from '../../src/error.js'
import { random } from '../random.js'
import { semver } from '../yarn1/semver.js'
import { BASE, C, I, S1, edit, parse, plain, registry, write } from './base.js'

// The small lockfile of base.js, and then one edit at a time, each refused
// with a message that says where and why.

const refuses = (text, message, where, options) => assert.throws(() => parse(text, options), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

const P = (location) => at('packages', location)

describe('the base lockfile', () => {
  const lock = parse(write(BASE))

  it('reads to the project, its packages and its links', () => {
    assert.deepEqual([lock.lockfileVersion, lock.name, lock.version], [3, 'base', '1.0.0'])
    assert.deepEqual(Object.keys(lock.importers), ['.', 'd', 'packages/ws'])
    assert.deepEqual(Object.keys(lock.packages), [
      'node_modules/@s/o', 'node_modules/a', 'node_modules/b', 'node_modules/c', 'node_modules/dv', 'node_modules/e',
      'node_modules/f', 'node_modules/my-q', 'node_modules/t', 'node_modules/t/node_modules/x', 'packages/ws/node_modules/b',
    ])
    assert.deepEqual(plain(lock.links), { 'node_modules/d': 'd', 'node_modules/ws': 'packages/ws' })
  })

  it('each edge of the project, of its kind, where npm finds it', () => {
    const edges = Object.fromEntries(Object.entries(lock.importers['.'].edges).map(([name, { type, target }]) => [name, `${type} ${target}`]))
    assert.deepEqual(edges, {
      ws: 'workspace link:packages/ws',
      a: 'prod node_modules/a',
      c: 'prod node_modules/c',
      d: 'prod link:d',
      e: 'prod node_modules/e',
      f: 'prod node_modules/f',
      'my-q': 'prod node_modules/my-q',
      t: 'prod node_modules/t',
      '@s/o': 'optional node_modules/@s/o',
      dv: 'dev node_modules/dv',
    })
    assert.deepEqual(lock.importers['.'].edges.e, { type: 'prod', spec: 'github:user/e#semver:^3.0.0', accept: undefined, target: 'node_modules/e' })
  })

  it('a dependency where Node.js finds it, nested or up the tree', () => {
    assert.equal(lock.importers['packages/ws'].edges.b.target, 'packages/ws/node_modules/b')
    assert.equal(lock.importers.d.edges.b.target, 'node_modules/b')
    assert.deepEqual(plain(lock.packages['node_modules/a'].edges), {
      b: { type: 'prod', spec: '^1.0.0', accept: undefined, target: 'node_modules/b' },
      c: { type: 'peer', spec: '^2.0.0', accept: undefined, target: 'node_modules/c' },
    })
  })

  it('the workspace, and the directory linked as a dependency', () => {
    assert.deepEqual([lock.importers['packages/ws'].workspace, lock.importers.d.workspace, lock.importers['.'].workspace], [true, false, false])
    assert.deepEqual([lock.importers['packages/ws'].name, lock.importers.d.name, lock.importers['.'].name], ['ws', 'd', 'base'])
    assert.deepEqual(lock.importers['.'].workspaces, ['packages/*'])
  })

  it('where each package comes from', () => {
    assert.deepEqual(lock.packages['node_modules/b'].resolution, { type: 'tarball', tarball: registry('b', '1.0.0'), integrity: I })
    assert.deepEqual(lock.packages['node_modules/e'].resolution, { type: 'git', repo: 'git+ssh://git@github.com/user/e.git', commit: C })
    assert.deepEqual(lock.packages['node_modules/t'].resolution, { type: 'tarball', tarball: 'file:vendor/t-1.0.0.tgz', integrity: I })
    assert.equal(lock.packages['node_modules/t/node_modules/x'].resolution, undefined)
    assert.equal(lock.packages['node_modules/t/node_modules/x'].inBundle, true)
  })

  it('the name a package is published under, beside its folder\'s', () => {
    assert.deepEqual([lock.packages['node_modules/my-q'].name, lock.packages['node_modules/f'].name, lock.packages['node_modules/a'].name], ['q', 'f-pkg', 'a'])
  })

  it('the flags, devOptional set where either other is', () => {
    const flags = (pkg) => ['dev', 'optional', 'devOptional', 'peer'].filter((flag) => pkg[flag])
    assert.deepEqual(flags(lock.packages['node_modules/dv']), ['dev', 'devOptional'])
    assert.deepEqual(flags(lock.packages['node_modules/@s/o']), ['optional', 'devOptional'])
    assert.deepEqual(flags(lock.packages['node_modules/a']), [])
  })

  it('the manifest fields', () => {
    const dv = lock.packages['node_modules/dv']
    assert.deepEqual([plain(dv.bin), plain(dv.engines), dv.os, dv.license, dv.hasInstallScript], [{ dv: 'cli.js' }, {}, undefined, undefined, false])
    assert.deepEqual(lock.packages['node_modules/@s/o'].os, ['darwin'])
  })

  it('records have no prototype', () => {
    for (const record of [lock.importers, lock.packages, lock.links, lock.importers['.'].edges, lock.packages['node_modules/dv'].bin]) {
      assert.equal(Object.getPrototypeOf(record), null)
    }
  })

  it('indented with a tab, or four spaces, and with CRLF line ends', () => {
    for (const indent of ['\t', '    ']) {
      assert.deepEqual(plain(parse(write(BASE, indent))), plain(lock))
      assert.deepEqual(plain(parse(write(BASE, indent).replaceAll('\n', '\r\n'))), plain(lock))
    }
  })

  it('without semver, versions unchecked', () => {
    assert.deepEqual(plain(parse(write(BASE), { checkVersions: false })), plain(lock))
  })
})

describe('what else npm writes is read', () => {
  it('a registry package with no URL, as npm writes it when set to', () => {
    const lock = parse(edit((l) => delete l.packages['node_modules/b'].resolved))
    assert.deepEqual(lock.packages['node_modules/b'].resolution, { type: 'tarball', tarball: undefined, integrity: I })
  })

  it('a peer npm installs, and an optional one it does not', () => {
    const lock = parse(edit((l) => {
      delete l.packages[''].dependencies.c
      l.packages['node_modules/c'].peer = true
      l.packages['node_modules/a'].peerDependencies.z = '1.0.0'
      l.packages['node_modules/a'].peerDependenciesMeta = { z: { optional: true } }
    }))
    assert.equal(lock.packages['node_modules/c'].peer, true)
    assert.deepEqual(lock.packages['node_modules/a'].edges.z, { type: 'peerOptional', spec: '1.0.0', accept: undefined, target: undefined })
  })

  it('a name both in dependencies and in devDependencies, as dev alone', () => {
    const lock = parse(edit((l) => (l.packages[''].dependencies.dv = '1.0.0')))
    assert.equal(lock.importers['.'].edges.dv.type, 'dev')
    assert.equal(lock.packages['node_modules/dv'].dev, true)
  })

  it('a package both dev and optional', () => {
    const lock = parse(edit((l) => {
      l.packages['node_modules/dv'].dependencies = { '@s/o': '1.0.0' }
      l.packages['node_modules/@s/o'].devOptional = true
      delete l.packages['node_modules/@s/o'].optional
    }))
    assert.deepEqual(['dev', 'optional', 'devOptional'].map((flag) => lock.packages['node_modules/@s/o'][flag]), [false, false, true])
  })

  it('a dependency of a directory out of the project, which npm leaves to it', () => {
    const lock = parse(edit((l) => {
      l.packages[''].dependencies.d = 'file:../d'
      l.packages['node_modules/d'].resolved = '../d'
      l.packages['../d'] = l.packages.d
      delete l.packages.d
      l.packages['../d'].dependencies = { missing: '^9.0.0' }
    }))
    assert.deepEqual(lock.importers['../d'].edges.missing.target, undefined)
  })

  it('every manifest field', () => {
    const lock = parse(edit((l) => Object.assign(l.packages['node_modules/b'], {
      license: 'MIT',
      engines: { node: '>=18' },
      cpu: ['x64'],
      libc: ['glibc'],
      deprecated: 'use c',
      hasInstallScript: true,
      funding: [{ type: 'github', url: 'https://github.com/sponsors/b' }, 'https://b.example'],
      acceptDependencies: { c: '^2.0.0' },
      workspaces: ['lib/*'],
    })))
    const b = lock.packages['node_modules/b']
    assert.deepEqual([b.license, plain(b.engines), b.cpu, b.libc, b.deprecated, b.hasInstallScript], ['MIT', { node: '>=18' }, ['x64'], ['glibc'], 'use c', true])
    assert.deepEqual(plain(b.funding), [{ type: 'github', url: 'https://github.com/sponsors/b' }, 'https://b.example'])
  })

  it('more than one integrity, a space apart', () => {
    assert.equal(parse(edit((l) => (l.packages['node_modules/b'].integrity = `${S1} ${I}`))).packages['node_modules/b'].resolution.integrity, `${S1} ${I}`)
  })

  it('licenses in a sequence, as old packages have them', () => {
    assert.deepEqual(parse(edit((l) => (l.packages['node_modules/b'].license = ['MIT', 'Apache2']))).packages['node_modules/b'].license, ['MIT', 'Apache2'])
  })

  it('a link to a package of another node_modules', () => {
    const lock = parse(edit((l) => (l.packages['node_modules/a/node_modules/b'] = { resolved: 'node_modules/b', link: true })))
    assert.equal(lock.links['node_modules/a/node_modules/b'], 'node_modules/b')
    assert.equal(lock.packages['node_modules/a'].edges.b.target, 'link:node_modules/b')
  })

  it('an optional peer not met, which npm ci takes as it is', () => {
    const lock = parse(edit((l) => {
      l.packages['node_modules/a'].peerDependencies.c = '^9.0.0'
      l.packages['node_modules/a'].peerDependenciesMeta = { c: { optional: true } }
    }))
    assert.equal(lock.packages['node_modules/a'].edges.c.target, 'node_modules/c')
  })

  it('a range met by an alias in the folder of its name', () => {
    assert.equal(parse(edit((l) => (l.packages['node_modules/a'].dependencies['my-q'] = '^1.0.0'))).packages['node_modules/a'].edges['my-q'].target, 'node_modules/my-q')
  })

  it('engines in a sequence, as old packages have them', () => {
    assert.deepEqual(parse(edit((l) => (l.packages['node_modules/b'].engines = ['node >=0.6.0']))).packages['node_modules/b'].engines, ['node >=0.6.0'])
  })

  it('a version a spec accepts besides, by acceptDependencies', () => {
    const lock = parse(edit((l) => {
      l.packages['node_modules/a'].dependencies.b = '^3.0.0'
      l.packages['node_modules/a'].acceptDependencies = { b: '^1.0.0' }
    }))
    assert.equal(lock.packages['node_modules/a'].edges.b.accept, '^1.0.0')
  })

  it('with legacy-peer-deps, no peer', () => {
    const text = edit((l) => {
      l.packages['node_modules/a'].peerDependencies.c = '^9.0.0'
    })
    assert.equal(parse(text, { semver, legacyPeerDeps: true }).packages['node_modules/a'].edges.c, undefined)
  })

  it('a tag, met by a package from a URL', () => {
    assert.equal(parse(edit((l) => (l.packages['node_modules/a'].dependencies.b = 'latest'))).packages['node_modules/a'].edges.b.target, 'node_modules/b')
  })

  it('a workspace by an object of globs', () => {
    assert.equal(parse(edit((l) => (l.packages[''].workspaces = { packages: ['packages/*'] }))).importers['packages/ws'].workspace, true)
  })
})

describe('the syntax is npm\'s', () => {
  const text = write(BASE)

  it('JSON as JSON.stringify writes it', () => {
    refuses(text.replace('"version": "1.0.0"', '"version":"1.0.0"'), 'expected "  \\"version\\": \\"1.0.0\\",", as npm writes it, found "  \\"version\\":\\"1.0.0\\"," at line 3')
    refuses(text.replace('"name": "base"', '"name": "b\\u0061se"'), 'expected "  \\"name\\": \\"base\\",", as npm writes it, found "  \\"name\\": \\"b\\\\u0061se\\"," at line 2')
    refuses(text.replace('"lockfileVersion": 3', '"lockfileVersion": 3.0'), 'expected "  \\"lockfileVersion\\": 3,", as npm writes it, found "  \\"lockfileVersion\\": 3.0," at line 4')
  })

  it('a key once', () => {
    refuses(text.replace('"requires": true,', '"requires": true,\n  "requires": true,'), 'expected "  \\"packages\\": {", as npm writes it, found "  \\"requires\\": true," at line 6')
  })

  it('a line end after the last "}", and nothing after it', () => {
    refuses(text.slice(0, -1), `expected a line end after the last "}" at line ${text.split('\n').length - 1}`)
    refuses(`${text}\n`, `expected the end of the file, as npm writes it, found "" at line ${text.split('\n').length + 1}`)
  })

  it('one line end throughout', () => {
    refuses(text.replace('\n', '\r\n'), 'expected "  \\"name\\": \\"base\\",\\r", as npm writes it, found "  \\"name\\": \\"base\\"," at line 2')
  })

  it('no byte order mark, which npm does not write', () => {
    refuses(`﻿${text}`, 'expected "{" alone on the first line and an indented key on the next, as npm writes the file at line 1')
  })

  it('what npm reads as a merge conflict', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].deprecated = '<<<<<<< ======= >>>>>>>')), 'npm reads a file with "<<<<<<<", "=======", ">>>>>>>" in it as a merge conflict')
  })

  it('JSON at all', () => {
    assert.throws(() => parse(text.replace('"requires": true,', '"requires": true')), (error) => error instanceof LockfileError && error.message.startsWith('not JSON: '))
  })
})

describe('the lockfile npm writes, and no other', () => {
  it('lockfileVersion 3 alone', () => {
    refuses(edit((l) => (l.lockfileVersion = 2)), 'unsupported version: expected 3, found the number 2', 'lockfileVersion')
    refuses(edit((l) => (l.lockfileVersion = 4)), 'unsupported version: expected 3, found the number 4', 'lockfileVersion')
  })

  it('no other field above the packages', () => {
    refuses(edit((l) => (l.dependencies = {})), 'unsupported field "dependencies"')
    refuses(edit((l) => (l.requires = false)), 'expected true, found the boolean false', 'requires')
  })

  it('the project\'s name and version above', () => {
    refuses(edit((l) => (l.name = 'other')), 'expected the project\'s, "base"', 'name')
    refuses(edit((l) => (l.version = '2.0.0')), 'expected the project\'s, "1.0.0"', 'version')
    refuses(edit((l) => delete l.packages[''].version), 'a version, where the project has none', 'version')
  })

  it('a package with a shrinkwrap of its own', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].hasShrinkwrap = true)), 'a shrinkwrap of its own, which is not supported', `${P('node_modules/b')}.hasShrinkwrap`)
  })

  it('a package npm prunes', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].extraneous = true)), 'nothing leads to it, and npm prunes it rather than install it', `${P('node_modules/b')}.extraneous`)
    refuses(edit((l) => (l.packages['node_modules/z'] = { version: '1.0.0', resolved: registry('z', '1.0.0'), integrity: I })), 'nothing installed leads to it, so npm takes it as extraneous, and prunes it', P('node_modules/z'))
  })

  it('no field npm does not write, nor an empty one', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].requires = { c: '1' })), 'unsupported field "requires"', P('node_modules/b'))
    refuses(edit((l) => (l.packages['node_modules/b'].devDependencies = {})), 'unsupported field "devDependencies"', P('node_modules/b'))
    refuses(edit((l) => (l.packages['node_modules/b'].dependencies = {})), 'expected what npm writes, which leaves an empty mapping out', `${P('node_modules/b')}.dependencies`)
    refuses(edit((l) => (l.packages['node_modules/b'].os = [])), 'expected what npm writes, which leaves an empty sequence out', `${P('node_modules/b')}.os`)
    refuses(edit((l) => (l.packages['node_modules/b'].dev = false)), 'expected true, found the boolean false', `${P('node_modules/b')}.dev`)
    refuses(edit((l) => (l.packages['node_modules/b'].license = '')), 'expected a non-empty string', `${P('node_modules/b')}.license`)
    refuses(edit((l) => (l.packages['node_modules/b'].license = null)), 'expected a string, found null', `${P('node_modules/b')}.license`)
  })

  it('names npm writes, of packages, folders and dependencies', () => {
    refuses(edit((l) => (l.packages['node_modules/my-q'].name = 'Q!')), '"Q!" is not a package name', `${P('node_modules/my-q')}.name`)
    refuses(edit((l) => (l.packages['node_modules/a'].name = 'a')), 'the name of its folder, which npm leaves out', `${P('node_modules/a')}.name`)
    refuses(edit((l) => (l.packages['node_modules/a'].dependencies = { '.b': '1' })), '".b" is not a package name', `${P('node_modules/a')}.dependencies[".b"]`)
  })

  it('a version of a package', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].version = 'v1.0.0')), '"v1.0.0" is not a version', `${P('node_modules/b')}.version`)
    refuses(edit((l) => delete l.packages['node_modules/b'].version), 'expected a version, which only a package from a git repository is read without', `${P('node_modules/b')}.version`)
    refuses(edit((l) => delete l.packages['node_modules/f'].version), 'expected a version, which only a package from a git repository is read without', `${P('node_modules/f')}.version`)
  })

  it('devOptional where neither dev nor optional is', () => {
    refuses(edit((l) => (l.packages['node_modules/dv'].devOptional = true)), 'set beside dev or optional, where npm leaves it out', `${P('node_modules/dv')}.devOptional`)
  })
})

describe('where a package comes from', () => {
  const b = (field) => `${P('node_modules/b')}.${field}`

  it('a tarball with its integrity', () => {
    refuses(edit((l) => delete l.packages['node_modules/b'].integrity), 'expected an integrity, which npm checks the tarball with', P('node_modules/b'))
    refuses(edit((l) => (l.packages['node_modules/b'].integrity = 'sha512-abc')), '"sha512-abc" is not a sha1, sha256, sha384 or sha512 integrity', b('integrity'))
    refuses(edit((l) => (l.packages['node_modules/b'].integrity = `${I} ${I}`)), 'two sha512 integrities', b('integrity'))
    refuses(edit((l) => (l.packages['node_modules/b'].integrity = `${I}  ${S1}`)), 'expected a non-empty string', b('integrity'))
  })

  it('the registry\'s tarball of its name and version', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].resolved = registry('c', '1.0.0'))), `"${registry('c', '1.0.0')}" is not the registry's tarball of b@1.0.0`, b('resolved'))
    const scoped = parse(edit((l) => (l.packages['node_modules/@s/o'].resolved = 'https://registry.npmjs.org/@s%2fo/-/o-1.0.0.tgz')))
    assert.equal(scoped.packages['node_modules/@s/o'].resolution.tarball, 'https://registry.npmjs.org/@s%2fo/-/o-1.0.0.tgz')
  })

  it('a URL, a file: tarball or a git URL alone', () => {
    refuses(edit((l) => (l.packages['node_modules/b'].resolved = 'ftp://example.com/b.tgz')), '"ftp://example.com/b.tgz" is not an http(s) URL, a file: tarball or a git URL', b('resolved'))
    refuses(edit((l) => (l.packages['node_modules/b'].resolved = 'file:/abs/b.tgz')), '"/abs/b.tgz" is not a relative path in normal form', b('resolved'))
    refuses(edit((l) => (l.packages['node_modules/b'].resolved = 'file:vendor/b')), '"file:vendor/b" is a directory, which npm packs again at every install: not supported', b('resolved'))
    refuses(edit((l) => (l.packages['node_modules/f'].resolved = 'https://github.com/user/f')), '"https://github.com/user/f" is a repository to npm, which it reads as one on a git host', `${P('node_modules/f')}.resolved`)
  })

  it('a git repository at a full commit, with no integrity', () => {
    const e = `${P('node_modules/e')}.resolved`
    refuses(edit((l) => (l.packages['node_modules/e'].resolved = 'git+ssh://git@github.com/user/e.git#main')), 'expected a full commit hash after the "#" of "git+ssh://git@github.com/user/e.git#main"', e)
    refuses(edit((l) => (l.packages['node_modules/e'].integrity = I)), 'an integrity, which npm does not check for a git repository', `${P('node_modules/e')}.integrity`)
  })

  it('something, but for a package another bundles', () => {
    refuses(edit((l) => {
      delete l.packages['node_modules/b'].resolved
      delete l.packages['node_modules/b'].integrity
    }), 'expected where it comes from, resolved or an integrity', P('node_modules/b'))
    refuses(edit((l) => (l.packages['node_modules/t/node_modules/x'].integrity = I)), 'npm takes it from the tarball of "node_modules/t", and from nothing else', `${P('node_modules/t/node_modules/x')}.integrity`)
  })

  it('inBundle where it is bundled alone', () => {
    refuses(edit((l) => delete l.packages['node_modules/t/node_modules/x'].inBundle), 'expected true, as "node_modules/t" bundles it', `${P('node_modules/t/node_modules/x')}.inBundle`)
    refuses(edit((l) => (l.packages['node_modules/b'].inBundle = true)), 'set, where nothing bundles it', `${P('node_modules/b')}.inBundle`)
  })
})

describe('the tree is npm\'s', () => {
  it('locations npm writes', () => {
    refuses(edit((l) => (l.packages['node_modules/a/lib'] = {})), 'in a node_modules, but none of its packages', P('node_modules/a/lib'))
    refuses(edit((l) => (l.packages['node_modules/./b'] = {})), '"node_modules/./b" is not a relative path in normal form', P('node_modules/./b'))
    refuses(edit((l) => (l.packages['node_modules/@s'] = {})), '"@s" is not a package name', P('node_modules/@s'))
    refuses(edit((l) => (l.packages['node_modules/node_modules'] = {})), 'a folder named "node_modules", which no package is', P('node_modules/node_modules'))
    refuses(edit((l) => (l.packages['..'] = {})), 'a directory the project is in, which is not supported', P('..'))
  })

  it('a package in the node_modules of one the lockfile has', () => {
    refuses(edit((l) => (l.packages['node_modules/z/node_modules/b'] = l.packages['node_modules/b'])), 'in the node_modules of "node_modules/z", which the lockfile does not have', P('node_modules/z/node_modules/b'))
    refuses(edit((l) => (l.packages['node_modules/d/node_modules/b'] = l.packages['node_modules/b'])), 'in the node_modules of "node_modules/d", a link, in which npm installs nothing', P('node_modules/d/node_modules/b'))
  })

  it('no two folders npm takes for one', () => {
    refuses(edit((l) => (l.packages['node_modules/B'] = { ...l.packages['node_modules/b'], resolved: registry('B', '1.0.0') })), 'in the folder of "node_modules/b" to npm, which takes names in one case', P('node_modules/B'))
  })

  it('a link to a directory of the lockfile\'s', () => {
    refuses(edit((l) => (l.packages['node_modules/d'].resolved = 'e')), '"e" is not in the lockfile, where npm looks for what a link leads to', `${P('node_modules/d')}.resolved`)
    refuses(edit((l) => (l.packages['node_modules/a/node_modules/x'] = { resolved: 'node_modules/d', link: true })), '"node_modules/d" is a link, where npm links a directory or a package', `${P('node_modules/a/node_modules/x')}.resolved`)
    refuses(edit((l) => (l.packages['node_modules/d'].link = 'yes')), 'expected true, found the string "yes"', `${P('node_modules/d')}.link`)
    refuses(edit((l) => (l.packages['node_modules/d'].version = '1.0.0')), 'unsupported field "version"', P('node_modules/d'))
    refuses(edit((l) => (l.packages.e = { resolved: 'd', link: true })), 'a link outside a node_modules, where npm writes none', P('e'))
  })

  it('a directory a link leads to', () => {
    refuses(edit((l) => (l.packages.lib = { version: '1.0.0' })), 'a directory no link leads to, of which npm installs nothing', P('lib'))
  })

  it('a bundle of a package, or of the project', () => {
    refuses(edit((l) => (l.packages.d.bundleDependencies = ['b'])), 'a bundle of a directory, which is not supported', `${P('d')}.bundleDependencies`)
  })

  it('workspaces of one name each, by globs npm reads', () => {
    refuses(edit((l) => (l.packages[''].workspaces = ['packages/*', 'd'], l.packages.d.name = 'ws')), 'the name of the workspace "packages/ws" too, of which npm keeps one', P('d'))
    refuses(edit((l) => (l.packages[''].workspaces = ['!packages/*'])), '"!packages/*" is a glob not read here', `${P('')}.workspaces[0]`)
  })
})

describe('each dependency is met where npm looks for it', () => {
  const a = (name) => `${P('node_modules/a')}.dependencies.${name}`

  it('by something', () => {
    refuses(edit((l) => (l.packages['node_modules/a'].dependencies.z = '1.0.0')), '"1.0.0" is met by nothing where npm looks for "z", so npm would install it', a('z'))
    refuses(edit((l) => (l.packages['node_modules/a'].optionalDependencies = { z: '1.0.0' })), '"1.0.0" is met by nothing where npm looks for "z", so npm would install it', `${P('node_modules/a')}.optionalDependencies.z`)
    refuses(edit((l) => (l.packages['node_modules/a'].peerDependencies.z = '1.0.0')), '"1.0.0" is met by nothing where npm looks for "z", so npm would install it', `${P('node_modules/a')}.peerDependencies.z`)
  })

  it('by a version of its range', () => {
    refuses(edit((l) => (l.packages['node_modules/a'].dependencies.b = '^2.0.0')), '"^2.0.0" is not satisfied by "node_modules/b", 1.0.0, so npm would install another', a('b'))
    refuses(edit((l) => (l.packages['node_modules/a'].peerDependencies.c = '^3.0.0')), '"^3.0.0" is not satisfied by "node_modules/c", 2.0.0, so npm would install another', `${P('node_modules/a')}.peerDependencies.c`)
    assert.equal(parse(edit((l) => (l.packages['node_modules/a'].dependencies.b = '^2.0.0')), { checkVersions: false }).packages['node_modules/a'].edges.b.target, 'node_modules/b')
  })

  it('by the package an alias names', () => {
    refuses(edit((l) => (l.packages[''].dependencies['my-q'] = 'npm:p@^1.0.0')), '"npm:p@^1.0.0" asks for "p", and "node_modules/my-q" is "q", which npm does not check, so npm would install another', `${P('')}.dependencies["my-q"]`)
  })

  it('by a package from a URL, for a tag', () => {
    const text = edit((l) => {
      l.packages['node_modules/a'].dependencies.b = 'latest'
      delete l.packages['node_modules/b'].resolved
    })
    refuses(text, '"latest" is a tag, which npm holds met by a tarball from a URL alone, and "node_modules/b" is none, so npm would install another', a('b'))
    refuses(edit((l) => (l.packages['node_modules/a'].dependencies.b = 'a b')), '"a b" is a tag npm refuses, of a character a URL escapes', a('b'))
  })

  it('by the tarball or the directory it names', () => {
    refuses(edit((l) => (l.packages[''].dependencies.t = 'file:vendor/t-2.0.0.tgz')), '"file:vendor/t-2.0.0.tgz" asks for the tarball "file:vendor/t-2.0.0.tgz", and "node_modules/t" is from another, so npm would install another', `${P('')}.dependencies.t`)
    refuses(edit((l) => (l.packages[''].dependencies.f = 'https://example.com/g.tgz')), '"https://example.com/g.tgz" asks for the tarball "https://example.com/g.tgz", and "node_modules/f" is from another, so npm would install another', `${P('')}.dependencies.f`)
    refuses(edit((l) => (l.packages[''].dependencies.d = 'file:./e')), '"file:./e" asks for a link to "e", and "node_modules/d" is one to "d", so npm would install another', `${P('')}.dependencies.d`)
    refuses(edit((l) => (l.packages[''].dependencies.b = 'file:b')), '"file:b" asks for a link to "b", and "node_modules/b" is no link, so npm would install another', `${P('')}.dependencies.b`)
    refuses(edit((l) => (l.packages[''].dependencies.d = 'file:/abs/d')), '"file:/abs/d" is a path from the root, a drive or the home directory, which a lockfile does not hold', `${P('')}.dependencies.d`)
  })

  it('by the repository it names, at its commit and in its range', () => {
    const e = `${P('')}.dependencies.e`
    refuses(edit((l) => (l.packages[''].dependencies.e = 'github:other/e')), '"github:other/e" asks for another repository than "node_modules/e" is from, so npm would install another', e)
    refuses(edit((l) => (l.packages[''].dependencies.e = `github:user/e#${'f'.repeat(40)}`)), `"github:user/e#${'f'.repeat(40)}" asks for another repository than "node_modules/e" is from, or another commit, so npm would install another`, e)
    refuses(edit((l) => (l.packages[''].dependencies.e = 'github:user/e#semver:^4.0.0')), '"github:user/e#semver:^4.0.0" asks for a version of the repository "node_modules/e" is not, 3.0.0, so npm would install another', e)
    refuses(edit((l) => (l.packages[''].dependencies.e = 'git+https://example.com/e.git')), '"git+https://example.com/e.git" asks for another repository than "node_modules/e" is from, so npm would install another', e)
    refuses(edit((l) => (l.packages[''].dependencies.b = 'github:user/b')), '"github:user/b" asks for a git repository, and "node_modules/b" is from none, so npm would install another', `${P('')}.dependencies.b`)
    // npm takes another commit of a repository on no host it knows.
    const elsewhere = (spec) => edit((l) => {
      l.packages[''].dependencies.e = spec
      l.packages['node_modules/e'].resolved = `git+https://example.com/e.git#${C}`
    })
    assert.equal(parse(elsewhere('git+https://example.com/e.git')).packages['node_modules/e'].resolution.commit, C)
    refuses(elsewhere(`git+https://example.com/e.git#${'f'.repeat(40)}`), `"git+https://example.com/e.git#${'f'.repeat(40)}" asks for another commit than "node_modules/e" is of, which npm does not check of a repository on no host it knows, so npm would install another`, e)
    for (const spec of ['user/e', 'git+ssh://git@github.com/user/e.git', 'https://github.com/user/e', `github:user/e#${C}`, 'git@github.com:user/e.git#main']) {
      assert.equal(parse(edit((l) => (l.packages[''].dependencies.e = spec))).importers['.'].edges.e.target, 'node_modules/e', spec)
    }
  })

  it('of a repository whose package.json has no version', () => {
    const versionless = (spec) => edit((l) => {
      l.packages[''].dependencies.e = spec
      delete l.packages['node_modules/e'].version
    })
    assert.equal(parse(versionless('github:user/e')).packages['node_modules/e'].version, undefined)
    refuses(versionless('github:user/e#semver:^3.0.0'), '"github:user/e#semver:^3.0.0" asks for a version of the repository "node_modules/e" is not, of no version, so npm would install another', `${P('')}.dependencies.e`)
  })

  it('by what npm reads as a spec', () => {
    refuses(edit((l) => (l.packages[''].dependencies.b = 'workspace:*')), '"workspace:*" is of a protocol npm does not read, "workspace:"', `${P('')}.dependencies.b`)
    refuses(edit((l) => (l.packages[''].dependencies.e = 'github:user/e#path:sub')), '"github:user/e#path:sub" is a subdirectory of a repository, which is not supported', `${P('')}.dependencies.e`)
    refuses(edit((l) => (l.packages[''].dependencies['my-q'] = 'npm:npm:q@1')), '"npm:npm:q@1" is an alias of an alias, which npm refuses', `${P('')}.dependencies["my-q"]`)
    refuses(edit((l) => (l.packages[''].dependencies['my-q'] = 'npm:file:q')), '"npm:file:q" is an alias of no package of the registry, which npm refuses', `${P('')}.dependencies["my-q"]`)
  })

  it('a peer not in the node_modules of what asks for it', () => {
    refuses(edit((l) => {
      l.packages['node_modules/a/node_modules/c'] = l.packages['node_modules/c']
      l.packages['node_modules/a'].dependencies.c = '2.0.0'
      delete l.packages['node_modules/a'].dependencies.c
    }), '"^2.0.0" is met in the node_modules of the package that asks for it, which npm holds a peer not to be', `${P('node_modules/a')}.peerDependencies.c`)
  })

  it('a workspace linked by its name', () => {
    refuses(edit((l) => (l.packages['node_modules/ws'].resolved = 'd', l.packages['node_modules/b/node_modules/ws'] = { resolved: 'packages/ws', link: true })), '"file:packages/ws" asks for a link to "packages/ws", and "node_modules/ws" is one to "d", so npm would install another', `${P('')}.workspaces`)
  })

  it('names in one case', () => {
    refuses(edit((l) => (l.packages['node_modules/a'].dependencies.B = '1.0.0')), '"b" too, to npm, which takes names in one case', `${P('node_modules/a')}.dependencies.B`)
    refuses(edit((l) => {
      l.packages['node_modules/a'].dependencies = { B: '1.0.0' }
    }), 'is met by "node_modules/b", which npm takes for it, though the names are in other cases', `${P('node_modules/a')}.dependencies.B`)
  })
})

describe('the flags npm writes', () => {
  // The project's x is a link to a package in the node_modules of its dev
  // dependency dv: npm 11.7 and later leave dv dev, npm 9 to 11.6 clear
  // the flags of what x is in. And a link to a, from the optional @s/o:
  // npm before 11.18 give a the link's flags, as though optional alone.
  const linked = (change) => edit((l) => {
    l.packages[''].dependencies.x = '1.0.0'
    l.packages['node_modules/x'] = { resolved: 'node_modules/dv/node_modules/x', link: true }
    l.packages['node_modules/dv/node_modules/x'] = { version: '1.0.0', resolved: registry('x', '1.0.0'), integrity: I }
    change(l)
  })

  it('as any one version of npm sets them', () => {
    assert.equal(parse(linked(() => {})).packages['node_modules/dv'].dev, true)
    assert.equal(parse(linked((l) => delete l.packages['node_modules/dv'].dev)).packages['node_modules/dv'].dev, false)
    const optional = (change) => edit((l) => {
      l.packages['node_modules/@s/o'].dependencies = { a: '*' }
      l.packages['node_modules/@s/o/node_modules/a'] = { resolved: 'node_modules/a', link: true }
      change(l)
    })
    assert.equal(parse(optional(() => {})).packages['node_modules/a'].optional, false)
    assert.equal(parse(optional((l) => (l.packages['node_modules/a'].optional = true))).packages['node_modules/a'].optional, true)
  })

  it('of a package nothing asks for, which a link leads into', () => {
    // npm 11.7 and later leave every flag of dv set, which npm writes as
    // dev, optional and peer; npm 9 to 11.6 clear them.
    const unasked = (change) => linked((l) => {
      delete l.packages[''].devDependencies.dv
      change(l.packages['node_modules/dv'])
    })
    const dv = (change) => parse(unasked(change)).packages['node_modules/dv']
    assert.deepEqual(['dev', 'optional', 'devOptional', 'peer'].map((flag) => dv((entry) => Object.assign(entry, { optional: true, peer: true }))[flag]), [true, true, true, true])
    assert.equal(dv((entry) => delete entry.dev).devOptional, false)
    refuses(unasked((entry) => Object.assign(entry, { dev: undefined, devOptional: true, peer: true })), 'expected true, as npm sets it from what depends on it', `${P('node_modules/dv')}.dev`)
  })

  it('refused where no version sets them so, as the latest would', () => {
    refuses(linked((l) => (l.packages['node_modules/dv'].optional = true)), 'expected none, as npm sets it from what depends on it', `${P('node_modules/dv')}.optional`)
  })

  it('as npm sets them from what depends on each', () => {
    refuses(edit((l) => delete l.packages['node_modules/dv'].dev), 'expected true, as npm sets it from what depends on it', `${P('node_modules/dv')}.dev`)
    refuses(edit((l) => (l.packages['node_modules/b'].dev = true)), 'expected none, as npm sets it from what depends on it', `${P('node_modules/b')}.dev`)
    refuses(edit((l) => (l.packages['node_modules/b'].peer = true)), 'expected none, as npm sets it from what depends on it', `${P('node_modules/b')}.peer`)
    refuses(edit((l) => delete l.packages['node_modules/@s/o'].optional), 'expected true, as npm sets it from what depends on it', `${P('node_modules/@s/o')}.optional`)
    refuses(edit((l) => (l.packages.d.dev = true)), 'expected none, as npm sets it from what depends on it', `${P('d')}.dev`)
    refuses(edit((l) => (l.packages[''].dev = true)), 'expected none, as npm sets it from what depends on it', `${P('')}.dev`)
  })

  it('what an optional peer alone leads to is extraneous', () => {
    refuses(edit((l) => {
      delete l.packages[''].dependencies.c
      l.packages['node_modules/a'].peerDependenciesMeta = { c: { optional: true } }
    }), 'nothing installed leads to it, so npm takes it as extraneous, and prunes it', P('node_modules/c'))
  })
})

describe('arguments', () => {
  it('a string, and the options this reader takes', () => {
    assert.throws(() => parseNpmLockfile(Buffer.from(write(BASE))), { name: 'TypeError', message: 'expected a string' })
    assert.throws(() => parseNpmLockfile(write(BASE)), { name: 'TypeError', message: 'checkVersions needs semver: pass it as semver, or set checkVersions to false' })
    assert.throws(() => parseNpmLockfile(write(BASE), { semver: {} }), { name: 'TypeError', message: 'semver: expected the semver package, with satisfies, valid, validRange' })
    assert.throws(() => parseNpmLockfile(write(BASE), { manifests: {} }), { name: 'TypeError', message: 'unknown option "manifests", of checkVersions, semver, legacyPeerDeps' })
    assert.throws(() => parseNpmLockfile(write(BASE), { checkVersions: 0 }), { name: 'TypeError', message: 'checkVersions: expected a boolean' })
  })
})

describe('anything else is refused, as a LockfileError', () => {
  const VALUES = [null, true, false, 0, 1.5, '', 'x', '1.0.0', '^1.0.0', 'file:x', 'node_modules/b', [], ['x'], [1], {}, { x: 'y' }, { optional: true }, { link: true }]

  // A value set somewhere in `value`, or a key dropped or added.
  function scramble({ next, pick }, value) {
    if (typeof value !== 'object' || value === null || next() < 0.2) return pick(VALUES)
    const copy = Array.isArray(value) ? [...value] : { ...value }
    const keys = Object.keys(copy)
    const r = next()
    if (r < 0.15 && keys.length > 0) delete copy[pick(keys)]
    else if (r < 0.3) copy[pick(['x', 'link', 'version', 'resolved', 'node_modules/z', '__proto__', 'dev'])] = pick(VALUES)
    else if (keys.length > 0) {
      const key = pick(keys)
      copy[key] = scramble({ next, pick }, copy[key])
    }
    return copy
  }

  it('the base lockfile with a value scrambled', () => {
    const rand = random(0xBAD5)
    let read = 0
    for (let i = 0; i < 5000; i++) {
      const lock = scramble(rand, BASE)
      try {
        parse(write(lock))
        read++
      } catch (error) {
        assert.ok(error instanceof LockfileError, `${error.stack}\n${write(lock)}`)
      }
    }
    assert.ok(read > 100, `only ${read} lockfiles were read`)
  })
})
