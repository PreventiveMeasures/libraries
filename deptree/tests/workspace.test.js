import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { checkWorkspace, findProjects } from '../src/pnpm/workspace.js'

// pnpm 11 leaves out what a `!` glob takes with micromatch too, which
// takes a name starting with a dot where tinyglobby does not.
describe('checkWorkspace', () => {
  it('leaves out a directory under a dot directory by a `!` glob for pnpm 11 alone', () => {
    const ids = ['.', '.hidden/x']
    for (const packages of [['.hidden/*', '!**/x'], ['.hidden/*', '!*/x']]) {
      checkWorkspace(ids, packages, 10)
      assert.throws(() => checkWorkspace(ids, packages, 11), /^DeptreeError: importers\[".hidden\/x"\]: pnpm-workspace\.yaml's packages do not take this directory/u, packages.join(', '))
    }
    assert.throws(() => checkWorkspace(ids, ['**'], 11), /do not take this directory/u, 'a glob that takes it still spells the dot')
  })
})

// What pnpm 10.33.4 and 11.28.2 list, `pnpm ls -r`, in a workspace of
// these directories by these globs.
describe('findProjects', () => {
  const files = [
    'packages/a', 'packages/b', 'packages/b/node_modules/x', 'packages/c/bower_components/y', '.hidden/d', 'packages/.dot',
    'other/e', 'packages/f/sub', 'node_modules/g', '.hidden/node_modules/h', 'x/.y/z', 'bower_components/w', 'tests/t',
  ].map((dir) => [`${dir}/package.json`, '{}'])
  const workspace = () => createVfs(Object.fromEntries([['package.json', '{}'], ['packages/j/readme', ''], ['packages/k/package.json/x', ''], ...files]))
  const found = [
    [['packages/*'], ['packages/a', 'packages/b']],
    [['packages/**'], ['packages/a', 'packages/b', 'packages/f/sub']],
    [['**'], ['other/e', 'packages/a', 'packages/b', 'packages/f/sub', 'tests/t']],
    [['**', '!**/b'], ['other/e', 'packages/a', 'packages/f/sub', 'tests/t']],
    [['.hidden/**'], ['.hidden/d', '.hidden/node_modules/h']],
    [['packages/.*'], ['packages/.dot']],
    [['*/*'], ['other/e', 'packages/a', 'packages/b', 'tests/t']],
    [['**/sub'], ['packages/f/sub']],
    [['./packages/*/', '!.hidden/**'], ['packages/a', 'packages/b']],
    [['**/node_modules/**'], []],
    [['**/bower_components/*'], []],
    [['x/.y/*'], ['x/.y/z']],
    [['x/**'], []],
    [['!packages/a', 'packages/*'], ['packages/b']],
    [['*', 'packages/k'], []],
    [['*s/*', '!*s/a'], ['packages/b', 'tests/t']],
    [[], []],
    [undefined, []],
  ]
  for (const [packages, ids] of found) {
    it(`finds ${JSON.stringify(packages)}`, () => {
      for (const major of [10, 11]) assert.deepEqual(findProjects(workspace(), packages, major), ['.', ...ids], String(major))
    })
  }

  it('leaves out what a `!` glob takes under a dot directory for pnpm 11 alone', () => {
    for (const packages of [['.hidden/**', '!**/d'], ['.hidden/*', '!*/d']]) {
      assert.ok(findProjects(workspace(), packages, 10).includes('.hidden/d'), packages.join(', '))
      assert.ok(!findProjects(workspace(), packages, 11).includes('.hidden/d'), packages.join(', '))
    }
  })

  it('reads only the directories tinyglobby walks into', () => {
    const vfs = workspace()
    vfs.mkdir('/.git/objects', { recursive: true })
    const read = []
    const seen = { readdir: (path) => (read.push(path), vfs.readdir(path)), lstat: (path) => vfs.lstat(path), stat: (path) => vfs.stat(path) }
    assert.deepEqual(findProjects(seen, ['packages/*'], 10), ['.', 'packages/a', 'packages/b'])
    assert.deepEqual(read.sort(), ['/', '/packages', '/packages/a', '/packages/b', '/packages/c', '/packages/f', '/packages/j', '/packages/k', '/packages/k/package.json'])
    read.length = 0
    findProjects(seen, ['**'], 10)
    assert.ok(!read.some((path) => path.startsWith('/.') || path.includes('/node_modules') || path.includes('bower_components')), read.join(', '))
  })

  // pnpm reads a manifest through a link, and follows a link to a
  // directory; it reads package.json5 or package.yaml where there is no
  // package.json.
  it('refuses a manifest not read here, the root\'s too, and a link pnpm would find a project through', () => {
    const cases = [
      [(vfs) => vfs.writeFile('/packages/j/package.yaml', 'name: j'), /^DeptreeError: "packages\/j\/package\.yaml": pnpm reads this project's package\.yaml, which is not supported$/u],
      [(vfs) => vfs.writeFile('/packages/j/package.json5', '{}'), /package\.json5, which is not supported$/u],
      [(vfs) => vfs.symlink('../../other/e/package.json', '/packages/j/package.json'), /^DeptreeError: "packages\/j\/package\.json": a link pnpm would read a project's manifest through is not supported$/u],
      [(vfs) => vfs.symlink('../other', '/packages/link'), /^DeptreeError: "packages\/link": a link to a directory pnpm-workspace\.yaml's packages could find a project in is not supported/u],
    ]
    for (const [add, pattern] of cases) {
      const vfs = workspace()
      add(vfs)
      assert.throws(() => findProjects(vfs, ['packages/*'], 10), pattern)
    }
    const bare = () => {
      const vfs = workspace()
      vfs.unlink('/package.json')
      return vfs
    }
    const roots = [
      [(vfs) => vfs.writeFile('/package.yaml', 'name: r'), /^DeptreeError: "package\.yaml": pnpm reads this project's package\.yaml, which is not supported$/u],
      [(vfs) => vfs.symlink('other/e/package.json', '/package.json'), /^DeptreeError: "package\.json": a link pnpm would read a project's manifest through is not supported$/u],
    ]
    for (const [add, pattern] of roots) {
      const vfs = bare()
      add(vfs)
      assert.throws(() => findProjects(vfs, ['packages/*'], 10), pattern)
    }
    // As pnpm 10.33.4 and 11.28.2 read them: a link that leads nowhere, or
    // to a directory, is no manifest, and the next name is read.
    for (const target of ['../../nowhere.json', '../../other']) {
      const vfs = workspace()
      vfs.symlink(target, '/packages/j/package.json')
      assert.deepEqual(findProjects(vfs, ['packages/*'], 10), ['.', 'packages/a', 'packages/b'], target)
      vfs.writeFile('/packages/j/package.yaml', 'name: j')
      assert.throws(() => findProjects(vfs, ['packages/*'], 10), /^DeptreeError: "packages\/j\/package\.yaml": pnpm reads this project's package\.yaml/u, target)
    }
    const vfs = workspace()
    vfs.writeFile('/package.yaml', 'name: r')
    vfs.writeFile('/packages/a/package.yaml', 'name: a')
    vfs.writeFile('/other/e/package.yaml', 'name: e')
    vfs.symlink('../../other/e/package.json', '/packages/a/readme.md')
    vfs.symlink('../nowhere', '/packages/gone')
    vfs.symlink('packages', '/elsewhere')
    assert.deepEqual(findProjects(vfs, ['packages/*'], 10), ['.', 'packages/a', 'packages/b'])
  })
})

describe('the globs', () => {
  // pnpm 10.33.4 and 11.28.2 list packages/a\nb for packages/*: a project
  // a lockfile could not name, which @preventive/lockfile refuses.
  it('take a name with a line terminator in it by `*`, and refuse the project', () => {
    checkWorkspace(['.', 'packages/a\nb', 'packages/a\rb', 'packages/a\u2028b', 'packages/a\u2029b'], ['packages/a*'])
    // A Vfs holds no such name; a view of a disk may.
    for (const name of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\\b']) {
      const dirs = new Map([['/', ['package.json', 'packages']], ['/packages', ['c', name]], ['/packages/c', ['package.json']], [`/packages/${name}`, ['package.json']]])
      const typeOf = (path) => ({ type: dirs.has(path) ? 'directory' : 'file' })
      const view = { readdir: (path) => dirs.get(path), lstat: typeOf, stat: typeOf }
      assert.deepEqual(findProjects(view, ['packages/c'], 10), ['.', 'packages/c'], JSON.stringify(name))
      assert.throws(() => findProjects(view, ['packages/*'], 10), /^DeptreeError: ".*": expected a directory under the lockfile's, by its path from there in normal form, as a lockfile can key an importer$/u, JSON.stringify(name))
    }
    const dirs = new Map([['/', ['package.json', 'C:b']], ['/C:b', ['package.json']]])
    const typeOf = (path) => ({ type: dirs.has(path) ? 'directory' : 'file' })
    assert.throws(() => findProjects({ readdir: (path) => dirs.get(path), lstat: typeOf, stat: typeOf }, ['*'], 10), /as a lockfile can key an importer$/u)
  })

  it('match however many `**` a glob has, with no recursion, in time linear in them', () => {
    assert.throws(() => checkWorkspace(['.', 'd/d'], [`${'**/'.repeat(100_000)}x`]), /do not take this directory/u)
    checkWorkspace(['.', 'd/d'], [`${'**/'.repeat(100_000)}d`])
  })

  it('match as many `**` as there are names in time', () => {
    const start = performance.now()
    assert.throws(() => checkWorkspace(['.', 'd/'.repeat(15) + 'd'], [`${'**/'.repeat(16)}x`]), /do not take this directory/u)
    assert.ok(performance.now() - start < 1000, `${performance.now() - start}ms`)
  })
})

// What pnpm 10.33.4 and 11.28.2 list among directories with a leading
// dot: tinyglobby walks into a directory only where each name down to it
// is taken by the glob's name in the same place, a `**` there taking none
// with a leading dot, though its whole match takes a `**` for no name.
describe('findProjects under directories with a leading dot', () => {
  const dirs = ['packages/a', '.hidden', 'x/.hidden', '.hidden/c', 'x/.hidden/c', '.a/.b', 'x/y/.b', 'x/.y/.b', 'x/z', '.c/d']
  const workspace = () => createVfs(Object.fromEntries([['package.json', '{}'], ...dirs.map((dir) => [`${dir}/package.json`, '{}'])]))
  const found = [
    [['**/.hidden'], ['x/.hidden']],
    [['**/.hidden/**'], ['x/.hidden', 'x/.hidden/c']],
    [['x/**/.hidden'], []],
    [['**/.b'], ['x/y/.b']],
    [['**/.a/.b'], []],
    [['x/**/.y/.b'], []],
    [['**/d'], []],
    [['.*/**'], ['.c/d', '.hidden', '.hidden/c']],
    [['*/.*'], ['x/.hidden']],
    [['.hidden', '!**/.hidden'], []],
    [['.hidden/**', '!**/.hidden/**'], []],
    [['**', '!**/.hidden'], ['packages/a', 'x/z']],
  ]
  for (const [packages, ids] of found) {
    it(`finds ${JSON.stringify(packages)}`, () => {
      for (const major of [10, 11]) assert.deepEqual(findProjects(workspace(), packages, major), ['.', ...ids], String(major))
    })
  }

  it('holds the lockfile\'s importers to what tinyglobby walks into', () => {
    checkWorkspace(['.', 'x/.hidden'], ['**/.hidden'])
    // pnpm leaves out what is under bower_components, but not below a
    // directory with a leading dot, which `**` does not take there.
    checkWorkspace(['.', '.x/bower_components/y'], ['.x/**'])
    assert.throws(() => checkWorkspace(['.', 'x/bower_components/y'], ['**']), /do not take this directory/u)
    for (const [id, packages] of [['.hidden', ['**/.hidden']], ['x/.hidden', ['x/**/.hidden']], ['.c/d', ['**/d']], ['.hidden', ['.hidden', '!**/.hidden']]]) {
      assert.throws(() => checkWorkspace(['.', id], packages), /^DeptreeError: importers\[".*"\]: pnpm-workspace\.yaml's packages do not take this directory/u, `${id} ${packages}`)
    }
  })
})
