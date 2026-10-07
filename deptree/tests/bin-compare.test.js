import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { byPath, difference, leftBehind, leftOut, patchOf, projectView, readSide } from '../bin/compare.js'
import { tokenIn, userToken } from '../bin/npmrc.js'
import { rawZip, sha256, tarball, url } from './registry.js'

// The development CLI, not published: its modules, and the command as a
// developer runs it, on projects whose tarball or zip a cache holds.

const file = (data, mode = 0o644) => ({ type: 'file', mode, data: Buffer.from(data) })
const dir = { type: 'directory', mode: 0o755 }
const link = (target) => ({ type: 'symlink', mode: 0o777, target })
const side = (entries) => new Map(Object.entries(entries))
const marks = (changes) => changes.map(({ mark, path, what }) => (what === undefined ? `${mark} ${path}` : `${mark} ${path} (${what})`))

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function writeDisk(root, entries) {
  for (const [path, { type, mode, data, target }] of entries) {
    mkdirSync(join(root, type === 'directory' ? path : join(path, '..')), { recursive: true })
    if (type === 'file') {
      writeFileSync(join(root, path), data)
      chmodSync(join(root, path), mode)
    }
    if (type === 'symlink') symlinkSync(target, join(root, path))
  }
}

// The CLI with its caches and tokens under `home` alone, on any platform.
const CLI = join(import.meta.dirname, '..', 'bin', 'deptree.js')
function cli(home, args, { node = [], env = {} } = {}) {
  const tokens = { NPM_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined, NPM_CONFIG_CACHE: undefined, FORCE_COLOR: undefined }
  const caches = { HOME: home, XDG_CACHE_HOME: join(home, 'xdg'), LOCALAPPDATA: join(home, 'local'), npm_config_cache: join(home, 'cache'), NO_COLOR: '1' }
  const r = spawnSync(process.execPath, [...node, CLI, ...args], { env: { ...process.env, ...tokens, ...caches, ...env }, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.error, undefined)
  return r
}

describe('difference', () => {
  const tree = side({
    node_modules: dir,
    'node_modules/a': dir,
    'node_modules/a/index.js': file('a'),
    'node_modules/a/cli.js': file('#!/bin/sh\n', 0o755),
    'node_modules/b': link('a'),
  })

  it('tells bytes, mode and link target apart', () => {
    const disk = new Map([...tree, ['node_modules/a/index.js', file('A')], ['node_modules/a/cli.js', file('#!/bin/sh\n', 0o644)], ['node_modules/b', link('c')]])
    assert.deepEqual(marks(difference(disk, tree)), [
      '~ node_modules/a/cli.js (mode 644 on disk, 755 in the tree)',
      '~ node_modules/a/index.js (content)',
      '~ node_modules/b (link to c on disk, to a in the tree)',
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

describe('leftOut', () => {
  it('takes what on disk alone holds nothing Node resolves, as pnpm leaves it', () => {
    const disk = side({
      node_modules: dir,
      'node_modules/.bin': dir,
      'node_modules/.bin/x': link('../x/cli.js'),
      'node_modules/.cache': dir,
      'node_modules/.cache/x': file('x'),
      'node_modules/.pnpm': dir,
      'node_modules/.pnpm/lock.yaml': file('lockfileVersion: 9.0'),
      'node_modules/.pnpm/node_modules': dir,
      'node_modules/.pnpm/node_modules/@babel': dir,
      'node_modules/.pnpm/node_modules/@jest': dir,
      'node_modules/.pnpm/node_modules/@jest/types': dir,
      'node_modules/.pnpm/node_modules/@s': dir,
      'node_modules/.pnpm/node_modules/@s/p': link('../../@s+p@1.0.0/node_modules/@s/p'),
      'node_modules/a': dir,
      'node_modules/a/node_modules': dir,
      'node_modules/a/node_modules/.bin': dir,
      'node_modules/a/node_modules/.bin/semver': link('../semver/bin/semver.js'),
    })
    const tree = side({ node_modules: dir, 'node_modules/.pnpm': dir, 'node_modules/.pnpm/node_modules': dir, 'node_modules/a': dir, 'node_modules/y': dir })
    assert.deepEqual([...leftOut(difference(disk, tree), disk)].toSorted(byPath), [
      'node_modules/.bin',
      'node_modules/.pnpm/lock.yaml',
      'node_modules/.pnpm/node_modules/@babel',
      'node_modules/.pnpm/node_modules/@jest',
      'node_modules/a/node_modules',
    ])
    const hoisted = side({ node_modules: dir, 'node_modules/.pnpm': dir, 'node_modules/.pnpm/lock.yaml': file('lockfileVersion: 9.0') })
    assert.deepEqual([...leftOut(difference(hoisted, side({ node_modules: dir })), hoisted)], ['node_modules/.pnpm'], "the hoisted linker's .pnpm of its state alone")
  })

  it('takes what deptree never builds on disk alone, and nothing like it', () => {
    const alone = (path, mark = '-') => leftOut([{ mark, path }], side({ [path]: file('x') })).size === 1
    for (const path of ['node_modules/.bin', 'packages/w/node_modules/.bin', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.package-lock.json', 'node_modules/.yarn-integrity', 'dependencies/acme-lib-1.0.0/.git']) {
      assert.equal(alone(path), true, path)
      assert.equal(alone(path, '~'), false, path)
    }
    for (const path of ['node_modules/a/.bin', 'node_modules/.binary', 'node_modules/a/.package-lock.json', 'dependencies/.git', 'dependencies/acme-lib-1.0.0/src/.git', 'lib/dependencies/acme-lib-1.0.0/.git', 'dependencies/acme-lib-1.0.0/.github']) assert.equal(alone(path), false, path)
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

describe('patchOf', () => {
  it('writes a unified diff from disk to the tree, labelled for patch -p1', () => {
    assert.equal(patchOf('node_modules/a/x.js', Buffer.from('one\r\ntwo\n'), Buffer.from('one\ntwo')), [
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
    assert.equal(patchOf('node_modules/a/x.node', Buffer.from('a\0'), Buffer.from('a')), binary)
    assert.equal(patchOf('node_modules/a/x.node', Buffer.from('a'), Uint8Array.of(0xff, 0xfe)), binary)
  })

  it('spells a name as git does, for patch to read it back whole', () => {
    const headers = (path) => patchOf(path, Buffer.from('a\n'), Buffer.from('b\n')).split('\n').slice(0, 2)
    assert.deepEqual(headers('node_modules/a/x y.js'), ['--- a/node_modules/a/x y.js\t', '+++ b/node_modules/a/x y.js\t'])
    assert.deepEqual(headers('node_modules/a/é.js'), ['--- a/node_modules/a/é.js', '+++ b/node_modules/a/é.js'])
    assert.deepEqual(headers('node_modules/a/x y\t"\\\n\u0001\u007F\u0085.js'), [
      '--- "a/node_modules/a/x y\\t\\"\\\\\\n\\001\\177\\302\\205.js"',
      '+++ "b/node_modules/a/x y\\t\\"\\\\\\n\\001\\177\\302\\205.js"',
    ])
    assert.equal(patchOf('node_modules/a/"x".node', Buffer.from('a\0'), Buffer.from('a')), 'Binary files "a/node_modules/a/\\"x\\".node" and "b/node_modules/a/\\"x\\".node" differ\n')
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
      `//registry.npmjs.org/:_authToken=${T1}; comment`,
      `//registry.npmjs.org/:_authToken="${T1}"`,
      `//registry.npmjs.org/:_authToken=${T1}\rX-Injected: 1`,
    ]) assert.equal(tokenIn(line), undefined, line)
  })

  it('reads one from home/.npmrc, and none where there is none or no absolute home', () => {
    const home = temp('deptree-bin-npmrc-')
    assert.equal(userToken(home), undefined)
    writeFileSync(join(home, '.npmrc'), `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${T1}\n`)
    assert.equal(userToken(home), T1)
    assert.equal(userToken('relative'), undefined)
  })
})

describe('readSide', () => {
  const root = temp('deptree-bin-sides-')

  it("reads the tree's Vfs and the disk alike, under the folders given alone", () => {
    const vfs = createVfs({
      'node_modules/a/index.js': { type: 'file', data: 'a', mode: 0o755 },
      'node_modules/b': { type: 'symlink', target: 'a' },
      'packages/w/node_modules/c/x': 'c',
      'packages/w/package.json': '{}',
    })
    const dirs = ['node_modules', 'packages/w/node_modules', 'packages/v/node_modules']
    const tree = readSide(vfs, dirs)
    assert.deepEqual([...tree.keys()].toSorted(byPath), ['node_modules', 'node_modules/a', 'node_modules/a/index.js', 'node_modules/b', 'packages/w/node_modules', 'packages/w/node_modules/c', 'packages/w/node_modules/c/x'])
    writeDisk(root, tree)
    assert.deepEqual(difference(readSide(projectView(root), dirs), tree), [], 'a folder not there is left out, and links are not followed')
  })
})

describe('bin/deptree.js compare', async () => {
  const home = temp('deptree-bin-compare-')
  const project = join(home, 'project')
  const run = (...args) => cli(home, args)
  // npm 4's cache layout, which upstream reads before the registry.
  const a = await tarball('a', '1.0.0', { 'index.js': 'a\n' })
  writeDisk(home, side({ 'cache/a/1.0.0/package.tgz': file(a.bytes) }))

  const manifest = { name: 'project', version: '1.0.0', dependencies: { a: '1.0.0' } }
  const lock = { name: 'project', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': manifest, 'node_modules/a': { version: '1.0.0', resolved: url('a', '1.0.0'), integrity: a.integrity } } }
  // As npm writes them, and as npm ci leaves node_modules, its hidden lockfile beside.
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`
  writeDisk(project, side({
    'package.json': file(json(manifest)),
    'package-lock.json': file(json(lock)),
    'node_modules/.package-lock.json': file(json(lock)),
    'node_modules/a/package.json': file(JSON.stringify({ name: 'a', version: '1.0.0' })),
    'node_modules/a/index.js': file('a\n'),
  }))

  it('finds the tree on disk the one the lockfile installs', () => {
    const r = run('compare', '--npm', '11.12.1', project)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^the same; 1 left out \(--all lists them\)$/mu)
    assert.equal(r.status, 0)
  })

  it('lists what differs, with --all what is left out, with --diff how, and exits 1', () => {
    appendFileSync(join(project, 'node_modules/a/index.js'), 'changed\n')
    writeDisk(project, side({ 'node_modules/extra/x.js': file('x') }))
    const r = run('compare', '--npm', '11.12.1', '--all', '--diff', project)
    assert.equal(r.stdout, [
      '- node_modules/.package-lock.json',
      '~ node_modules/a/index.js  (content)',
      '--- a/node_modules/a/index.js',
      '+++ b/node_modules/a/index.js',
      '@@ -1,2 +1 @@',
      ' a',
      '-changed',
      '- node_modules/extra/',
      '',
    ].join('\n'), 'byte for byte where stdout is no terminal, so that patch -p1 applies it')
    assert.match(r.stderr, /^0 only in the tree, 2 only on disk, 1 different$/mu)
    assert.equal(r.status, 1)
  })

  it('exits 2 on trouble, saying what', () => {
    writeDisk(home, side({ 'unpinned/package.json': file('{"name":"u","version":"1.0.0"}'), 'unpinned/pnpm-lock.yaml': file("lockfileVersion: '9.0'\n") }))
    for (const [args, said] of [
      [[project], /package-lock\.json: give --npm <version>/u],
      [[home], /no pnpm-lock\.yaml, yarn\.lock, package-lock\.json/u],
      [['--npm', '9.0.0', project], /^deptree\.js: .*npm/mu],
      [[join(home, 'unpinned')], /^deptree\.js: host\.pnpm /mu],
      [['--frobnicate', project], /^deptree\.js: Unknown option '--frobnicate'/mu],
    ]) {
      const r = run('compare', ...args)
      assert.match(r.stderr, said)
      assert.doesNotMatch(r.stderr, /\n\s+at /u, 'a refusal is no bug, and shows no stack')
      assert.equal(r.status, 2)
    }
    assert.equal(run('frobnicate', project).status, 2)
  })

  it("shows a bug's stack, though Node gave it a code, and no stack of the disk's refusal", () => {
    // readdir made to fail as a bug would, on an option Node refuses, or as
    // the disk would, on a directory gone.
    writeDisk(home, side({ 'fault.mjs': file("import fs from 'node:fs'\nimport { syncBuiltinESMExports } from 'node:module'\nconst { readdirSync } = fs\nfs.readdirSync = (path) => (process.env.FAULT === 'bug' ? readdirSync(path, { encoding: 'bogus' }) : readdirSync(`${path}/gone`))\nsyncBuiltinESMExports()\n") }))
    const fault = (FAULT) => cli(home, ['compare', '--npm', '11.12.1', project], { node: ['--import', pathToFileURL(join(home, 'fault.mjs')).href], env: { FAULT } })
    const bug = fault('bug')
    assert.match(bug.stderr, /^deptree\.js: TypeError \[ERR_INVALID_ARG_VALUE\]: .*\n\s+at /mu)
    assert.equal(bug.status, 2)
    const gone = fault('gone')
    assert.match(gone.stderr, /^deptree\.js: ENOENT: no such file or directory, scandir '.*\/gone'$/mu)
    assert.doesNotMatch(gone.stderr, /\n\s+at /u)
    assert.equal(gone.status, 2)
  })
})

describe('bin/deptree.js compare, with Soldeer', () => {
  const home = temp('deptree-bin-soldeer-')
  const project = join(home, 'project')
  // The default cache answers a zip of the lockfile's checksum with no
  // request: wherever it is on this platform.
  const zip = rawZip([{ name: 'src/Test.sol', data: 'test\n' }, { name: 'run.sh', data: 'run', mode: 0o100755 }])
  for (const cache of ['xdg/PreventiveMeasures', 'Library/Caches/PreventiveMeasures', 'local/PreventiveMeasures/Cache']) writeDisk(home, side({ [`${cache}/soldeer/zips/forge-std@1.9.4.zip`]: file(zip) }))
  // As Soldeer 0.12 writes soldeer.lock and extracts the zip, but for one
  // file changed and another dependency's folder.
  writeDisk(project, side({
    'soldeer.toml': file('[dependencies]\nforge-std = "1.9.4"\n'),
    'soldeer.lock': file(`version = 2\n\n[[dependencies]]\nname = "forge-std"\nversion = "1.9.4"\nurl = "https://soldeer-revisions.s3.amazonaws.com/forge-std/x.zip"\nchecksum = "${sha256(zip)}"\nintegrity = "${'0'.repeat(64)}"\n`),
    'dependencies/forge-std-1.9.4/src/Test.sol': file('changed\n'),
    'dependencies/forge-std-1.9.4/run.sh': file('run', 0o755),
    'dependencies/solady-0.1.0/x.sol': file('x'),
  }))

  it('lists what differs in the dependencies folder soldeer.lock installs', () => {
    const r = cli(home, ['compare', project])
    assert.equal(r.stdout, '~ dependencies/forge-std-1.9.4/src/Test.sol  (content)\n- dependencies/solady-0.1.0/\n')
    assert.match(r.stderr, /^dependencies on disk: 3 files, /mu)
    assert.equal(r.status, 1)
    assert.equal(cli(home, ['compare', '--soldeer', '0.11.0', project]).status, 2, 'only the Soldeer deptree builds for')
  })

  it('reads a git dependency from GitHub, with GITHUB_TOKEN or GH_TOKEN where either is set', () => {
    const [git, rev] = ['https://github.com/acme/lib.git', 'a'.repeat(40)]
    writeDisk(home, side({
      'git/soldeer.toml': file(`[dependencies]\nacme-lib = { version = "1.0.0", git = "${git}" }\n`),
      'git/soldeer.lock': file(`version = 2\n\n[[dependencies]]\nname = "acme-lib"\nversion = "1.0.0"\ngit = "${git}"\nrev = "${rev}"\n`),
      // GitHub as the CLI asks it, in its own process: each request and the
      // token it carries said on stderr, and nothing found.
      'spy.mjs': file("globalThis.fetch = (input, init = {}) => {\n  process.stderr.write(`asked ${input} ${new Headers(init.headers).get('authorization') ?? 'anonymously'}\\n`)\n  return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))\n}\n"),
    }))
    const ask = (env) => {
      const r = cli(home, ['compare', join(home, 'git')], { node: ['--import', pathToFileURL(join(home, 'spy.mjs')).href], env })
      assert.equal(r.status, 2, r.stderr)
      assert.doesNotMatch(r.stderr, /\n\s+at /u, 'a refusal, not a bug')
      return r.stderr.match(/^asked https:\/\/api\.github\.com\/repos\/acme\/lib\/git\/commits\/a{40} (.*)$/mu)?.[1]
    }
    assert.equal(ask({}), 'anonymously')
    assert.equal(ask({ GH_TOKEN: 'gho_gh' }), 'Bearer gho_gh')
    assert.equal(ask({ GITHUB_TOKEN: 'ghp_github', GH_TOKEN: 'gho_gh' }), 'Bearer ghp_github')
  })
})
