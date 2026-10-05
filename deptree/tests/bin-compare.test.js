import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { byPath, difference, emptyDirs, leftBehind, notBuilt, projectView, readDisk, readTree } from '../bin/compare.js'
import { tokenIn, userToken } from '../bin/npmrc.js'
import { patchOf } from '../bin/patch.js'
import { tarball, url } from './registry.js'

// The development CLI is not part of the published package and nothing
// else imports it: its comparison is checked here by its own module, and
// the command as a developer runs it, against a project on disk whose one
// tarball npm's cache holds, so nothing is fetched.

const file = (data, mode = 0o644) => ({ type: 'file', mode, data: Buffer.from(data) })
const dir = { type: 'directory', mode: 0o755 }
const link = (target) => ({ type: 'symlink', mode: 0o777, target })
const side = (entries) => new Map(Object.entries(entries))
const marks = (changes) => changes.map(({ mark, path, what }) => (what === undefined ? `${mark} ${path}` : `${mark} ${path} (${what})`))

describe('difference', () => {
  const tree = side({
    node_modules: dir,
    'node_modules/a': dir,
    'node_modules/a/index.js': file('a'),
    'node_modules/a/cli.js': file('#!/bin/sh\n', 0o755),
    'node_modules/b': link('a'),
  })

  it('finds nothing where the two are the same', () => {
    assert.deepEqual(difference(new Map(tree), tree), [])
  })

  it('tells bytes, mode, link target and type apart', () => {
    const disk = new Map([
      ...tree,
      ['node_modules/a/index.js', file('A')],
      ['node_modules/a/cli.js', file('#!/bin/sh\n', 0o644)],
      ['node_modules/b', link('c')],
    ])
    assert.deepEqual(marks(difference(disk, tree)), [
      '~ node_modules/a/cli.js (mode 644 on disk, 755 in the tree)',
      '~ node_modules/a/index.js (content)',
      '~ node_modules/b (link to c on disk, to a in the tree)',
    ])
    disk.set('node_modules/a/index.js', file('a', 0o600))
    disk.set('node_modules/b', dir)
    assert.deepEqual(marks(difference(disk, tree)).slice(1), [
      '~ node_modules/a/index.js (mode 600 on disk, 644 in the tree)',
      '~ node_modules/b (directory on disk, symlink in the tree)',
    ])
  })

  it('lists a directory one side has alone once, and nothing under it', () => {
    const disk = side({ node_modules: dir, 'node_modules/b': link('a'), 'node_modules/c': dir, 'node_modules/c/x': file('x') })
    assert.deepEqual(difference(disk, tree).map(({ mark, path, type }) => [mark, path, type]), [
      ['+', 'node_modules/a', 'directory'],
      ['-', 'node_modules/c', 'directory'],
    ])
  })

  it('lists nothing under a path whose type differs', () => {
    const disk = side({ node_modules: dir, 'node_modules/a': file('a'), 'node_modules/b': dir, 'node_modules/b/x': file('x') })
    assert.deepEqual(marks(difference(disk, tree)), [
      '~ node_modules/a (file on disk, directory in the tree)',
      '~ node_modules/b (directory on disk, symlink in the tree)',
    ])
  })

  it('lists a node_modules one side has alone, whatever is above it', () => {
    const built = side({ 'packages/w/node_modules': dir, 'packages/w/node_modules/x': file('x') })
    assert.deepEqual(marks(difference(new Map(), built)), ['+ packages/w/node_modules'])
    assert.deepEqual(marks(difference(built, new Map())), ['- packages/w/node_modules'])
  })

  it('goes in walk order: a directory before what is beside it by a longer name', () => {
    const paths = ['node_modules/a-b', 'node_modules/a/b', 'node_modules/a', 'node_modules/B', 'node_modules']
    assert.deepEqual(paths.toSorted(byPath), ['node_modules', 'node_modules/B', 'node_modules/a', 'node_modules/a/b', 'node_modules/a-b'])
  })
})

describe('notBuilt', () => {
  it('takes a .bin or a state file on disk alone', () => {
    for (const path of ['node_modules/.bin', 'node_modules/.bin/x', 'packages/w/node_modules/.bin', 'node_modules/.pnpm/node_modules/.bin', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.package-lock.json', 'node_modules/.yarn-integrity']) {
      assert.equal(notBuilt({ mark: '-', path }), true, path)
      assert.equal(notBuilt({ mark: '+', path }), false, path)
      assert.equal(notBuilt({ mark: '~', path }), false, path)
    }
    for (const path of ['node_modules/a/.bin', 'node_modules/.binary', 'node_modules/.cache', 'node_modules/a/.package-lock.json']) assert.equal(notBuilt({ mark: '-', path }), false, path)
  })
})

describe('leftBehind', () => {
  it("takes a package's directory in node_modules/.pnpm on disk alone", () => {
    for (const path of ['node_modules/.pnpm/debug@4.4.1', 'node_modules/.pnpm/@s+p@1.0.0_peer@2.0.0', 'packages/w/node_modules/.pnpm/a@1.0.0']) {
      assert.equal(leftBehind({ mark: '-', type: 'directory', path }), true, path)
      assert.equal(leftBehind({ mark: '+', type: 'directory', path }), false, path)
      assert.equal(leftBehind({ mark: '-', type: 'file', path }), false, path)
    }
    for (const path of ['node_modules/.pnpm/node_modules', 'node_modules/.pnpm/a@1.0.0/node_modules/a', 'node_modules/a@1.0.0']) assert.equal(leftBehind({ mark: '-', type: 'directory', path }), false, path)
  })
})

describe('emptyDirs', () => {
  it('takes a directory on disk alone that holds nothing but directories and what deptree never builds', () => {
    const disk = side({
      'node_modules/.bin': dir,
      'node_modules/.bin/x': link('../x/cli.js'),
      'node_modules/.pnpm': dir,
      'node_modules/.pnpm/lock.yaml': file('lockfileVersion: 9.0'),
      'node_modules/.pnpm/node_modules': dir,
      'node_modules/.pnpm/node_modules/@babel': dir,
      'node_modules/.pnpm/node_modules/@jest': dir,
      'node_modules/.pnpm/node_modules/@jest/types': dir,
      'node_modules/.pnpm/node_modules/@s': dir,
      'node_modules/.pnpm/node_modules/@s/p': link('../../@s+p@1.0.0/node_modules/@s/p'),
      'node_modules/a': dir,
      'node_modules/a/index.js': file('a'),
      'node_modules/a/node_modules': dir,
      'node_modules/a/node_modules/.bin': dir,
      'node_modules/a/node_modules/.bin/semver': link('../semver/bin/semver.js'),
      'node_modules/z': dir,
      'node_modules/z/deep': dir,
      'node_modules/z/deep/f.js': file('f'),
    })
    const tree = side({ 'node_modules/.pnpm': dir, 'node_modules/.pnpm/node_modules': dir, 'node_modules/a': dir, 'node_modules/a/index.js': file('a'), 'node_modules/y': dir, 'node_modules/y/f.js': file('f') })
    const changes = difference(disk, tree)
    assert.deepEqual(marks(changes), [
      '- node_modules/.bin',
      '- node_modules/.pnpm/lock.yaml',
      '- node_modules/.pnpm/node_modules/@babel',
      '- node_modules/.pnpm/node_modules/@jest',
      '- node_modules/.pnpm/node_modules/@s',
      '- node_modules/a/node_modules',
      '+ node_modules/y',
      '- node_modules/z',
    ])
    assert.deepEqual([...emptyDirs(changes, disk)].toSorted(byPath), ['node_modules/.pnpm/node_modules/@babel', 'node_modules/.pnpm/node_modules/@jest', 'node_modules/a/node_modules'], 'a .bin is never built, not empty')
    const hoisted = side({ 'node_modules/.pnpm': dir, 'node_modules/.pnpm/lock.yaml': file('lockfileVersion: 9.0') })
    assert.deepEqual([...emptyDirs(difference(hoisted, new Map()), hoisted)], ['node_modules/.pnpm'], "the hoisted linker's .pnpm of its state alone")
  })
})

describe('patchOf', () => {
  const bytes = (text) => new TextEncoder().encode(text)

  it('writes a unified diff from disk to the tree, labelled for patch -p1', () => {
    assert.equal(patchOf('node_modules/a/x.js', bytes('one\r\ntwo\n'), bytes('one\ntwo')), [
      '--- a/node_modules/a/x.js',
      '+++ b/node_modules/a/x.js',
      '@@ -1,2 +1,2 @@',
      '-one\r',
      '-two',
      '+one',
      '+two',
      '\\ No newline at end of file',
      '',
    ].join('\n'))
  })

  it('says only that they differ where either is no UTF-8 text, or holds a NUL', () => {
    const binary = 'Binary files a/node_modules/a/x.node and b/node_modules/a/x.node differ\n'
    assert.equal(patchOf('node_modules/a/x.node', Uint8Array.of(0x61, 0x00), bytes('a')), binary)
    assert.equal(patchOf('node_modules/a/x.node', bytes('a'), Uint8Array.of(0xff, 0xfe)), binary)
  })
})

describe('the token in ~/.npmrc', () => {
  const T1 = `npm_${'a'.repeat(36)}`
  const T2 = `npm_${'B9'.repeat(18)}`

  it("takes a line that is nothing but the registry's token, the last of them", () => {
    assert.equal(tokenIn(`//registry.npmjs.org/:_authToken=${T1}\n`), T1)
    assert.equal(tokenIn(`a=b\r\n//registry.npmjs.org/:_authToken=${T1}\r\n//registry.npmjs.org/:_authToken=${T2}`), T2)
  })

  it('takes no other key, registry, placeholder or spelling', () => {
    for (const line of [
      `//registry.npmjs.org/:_auth=${T1}`,
      `//registry.npmjs.org/:_password=${T1}`,
      `_authToken=${T1}`,
      `//npm.pkg.github.com/:_authToken=${T1}`,
      `//registry.npmjs.org.evil.example/:_authToken=${T1}`,
      `//evil.example///registry.npmjs.org/:_authToken=${T1}`,
      `@scope:registry=https://registry.npmjs.org/\n//registry.npmjs.org:_authToken=${T1}`,
      '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
      '//registry.npmjs.org/:_authToken=npm_',
      `//registry.npmjs.org/:_authToken=${T1.slice(4)}`,
      ` //registry.npmjs.org/:_authToken=${T1}`,
      `//registry.npmjs.org/:_authToken = ${T1}`,
      `//registry.npmjs.org/:_authToken=${T1} `,
      `//registry.npmjs.org/:_authToken=${T1}; comment`,
      `//registry.npmjs.org/:_authToken="${T1}"`,
      `//registry.npmjs.org/:_authToken=${T1}\rX-Injected: 1`,
      `; //registry.npmjs.org/:_authToken=${T1}`,
    ]) assert.equal(tokenIn(line), undefined, line)
  })

  it('reads one from home/.npmrc, and none where there is none or no absolute home', () => {
    const home = mkdtempSync(join(tmpdir(), 'deptree-bin-npmrc-'))
    try {
      assert.equal(userToken(home), undefined)
      writeFileSync(join(home, '.npmrc'), `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${T1}\n`)
      assert.equal(userToken(home), T1)
      assert.equal(userToken('relative'), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the two sides', () => {
  const root = mkdtempSync(join(tmpdir(), 'deptree-bin-sides-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  it('reads a Vfs under its node_modules alone, and a disk the same way', () => {
    const vfs = createVfs({
      'node_modules/a/index.js': { type: 'file', data: 'a', mode: 0o755 },
      'node_modules/b': { type: 'symlink', target: 'a' },
      'packages/w/node_modules/c/x': 'c',
      'packages/w/package.json': '{}',
    })
    const tree = readTree(vfs)
    assert.deepEqual([...tree.keys()].toSorted(byPath), ['node_modules', 'node_modules/a', 'node_modules/a/index.js', 'node_modules/b', 'packages/w/node_modules', 'packages/w/node_modules/c', 'packages/w/node_modules/c/x'])
    assert.deepEqual({ ...tree.get('node_modules/a/index.js'), data: [...tree.get('node_modules/a/index.js').data] }, { type: 'file', mode: 0o755, data: [0x61] })
    assert.deepEqual(tree.get('node_modules/b'), { type: 'symlink', mode: 0o777, target: 'a' })

    for (const [path, entry] of tree) {
      if (entry.type === 'directory') mkdirSync(join(root, path), { recursive: true })
      if (entry.type === 'file') {
        writeFileSync(join(root, path), entry.data)
        chmodSync(join(root, path), entry.mode)
      }
      if (entry.type === 'symlink') symlinkSync(entry.target, join(root, path))
    }
    const disk = readDisk(projectView(root), ['node_modules', 'packages/w/node_modules', 'packages/v/node_modules'])
    assert.deepEqual(difference(disk, tree), [], 'a root not there is left out, and links are not followed')
  })
})

describe('bin/deptree.js compare', async () => {
  const CLI = join(import.meta.dirname, '..', 'bin', 'deptree.js')
  const home = mkdtempSync(join(tmpdir(), 'deptree-bin-compare-'))
  after(() => rmSync(home, { recursive: true, force: true }))
  const project = join(home, 'project')

  // npm 4's cache layout, which upstream reads before the registry.
  const a = await tarball('a', '1.0.0', { 'index.js': 'a\n' })
  mkdirSync(join(home, 'cache/a/1.0.0'), { recursive: true })
  writeFileSync(join(home, 'cache/a/1.0.0/package.tgz'), a.bytes)

  const manifest = { name: 'project', version: '1.0.0', dependencies: { a: '1.0.0' } }
  const lock = { name: 'project', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': manifest, 'node_modules/a': { version: '1.0.0', resolved: url('a', '1.0.0'), integrity: a.integrity } } }
  // As npm writes them, and as npm ci leaves node_modules: each file 0o644,
  // and its hidden lockfile beside.
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`
  const files = {
    'package.json': json(manifest),
    'package-lock.json': json(lock),
    'node_modules/.package-lock.json': json(lock),
    'node_modules/a/package.json': JSON.stringify({ name: 'a', version: '1.0.0' }),
    'node_modules/a/index.js': 'a\n',
  }
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(project, path, '..'), { recursive: true })
    writeFileSync(join(project, path), data)
    chmodSync(join(project, path), 0o644)
  }

  // The cache it keeps tarballs in is this test's too, on any platform.
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, 'xdg'), LOCALAPPDATA: join(home, 'local'), npm_config_cache: join(home, 'cache'), NO_COLOR: '1' }
  for (const name of ['NPM_CONFIG_CACHE', 'FORCE_COLOR']) delete env[name]
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.error, undefined)
    return { stdout: r.stdout, stderr: r.stderr, status: r.status }
  }

  it('finds the tree on disk the one the lockfile installs', () => {
    const r = run('compare', '--npm', '11.12.1', project)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^the same; left out 1 that deptree never builds \(--all lists them\)$/mu)
    assert.equal(r.status, 0)
    const all = run('compare', '--npm', '11.12.1', '--all', project)
    assert.equal(all.stdout, '- node_modules/.package-lock.json\n')
    assert.equal(all.status, 1)
  })

  it('lists what differs, and exits 1', () => {
    appendFileSync(join(project, 'node_modules/a/index.js'), 'changed\n')
    mkdirSync(join(project, 'node_modules/extra'))
    writeFileSync(join(project, 'node_modules/extra/x.js'), 'x')
    const r = run('compare', '--npm', '11.12.1', project)
    assert.equal(r.stdout, '~ node_modules/a/index.js  (content)\n- node_modules/extra/\n')
    assert.match(r.stderr, /^0 only in the tree, 1 only on disk, 1 different; left out 1 that/mu)
    assert.equal(r.status, 1)
    const diffed = run('compare', '--npm', '11.12.1', '--diff', project)
    assert.equal(diffed.stdout, [
      '~ node_modules/a/index.js  (content)',
      '--- a/node_modules/a/index.js',
      '+++ b/node_modules/a/index.js',
      '@@ -1,2 +1 @@',
      ' a',
      '-changed',
      '- node_modules/extra/',
      '',
    ].join('\n'), 'byte for byte where stdout is no terminal, so that patch -p1 applies it')
    assert.equal(diffed.status, 1)
    rmSync(join(project, 'node_modules'), { recursive: true })
    const gone = run('compare', '--npm', '11.12.1', project)
    assert.equal(gone.stdout, '+ node_modules/\n')
    assert.equal(gone.status, 1)
  })

  it('exits 2 on trouble, saying what', () => {
    const npmless = run('compare', project)
    assert.match(npmless.stderr, /package-lock\.json: give --npm <version>/u)
    assert.equal(npmless.status, 2)
    const empty = run('compare', home)
    assert.match(empty.stderr, /no pnpm-lock\.yaml, yarn\.lock, package-lock\.json/u)
    assert.equal(empty.status, 2)
    const refused = run('compare', '--npm', '9.0.0', project)
    assert.match(refused.stderr, /^deptree\.js: .*npm/mu)
    assert.doesNotMatch(refused.stderr, /\n\s+at /u, 'a refusal is no bug, and shows no stack')
    assert.equal(refused.status, 2)
    assert.equal(run('frobnicate', project).status, 2)
    assert.equal(run('compare', '--frobnicate', project).status, 2)
  })
})
