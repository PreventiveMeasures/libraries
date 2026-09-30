import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { checkWorkspace, findProjects } from '../src/pnpm/workspace.js'

// What findProjects reads a Vfs by: `vfs`'s calls, any of them replaced.
const viewOf = (vfs, calls = {}) => ({
  readdir: (path) => vfs.readdir(path),
  lstat: (path) => vfs.lstat(path),
  stat: (path) => vfs.stat(path),
  ...calls,
})

// A view of the directories `dirs` maps by path to their entries, as a
// disk's may be, with names a Vfs holds none of: any other path a file.
function viewOfDirs(dirs) {
  const typeOf = (path) => ({ type: dirs.has(path) ? 'directory' : 'file' })
  return { readdir: (path) => dirs.get(path), lstat: typeOf, stat: typeOf }
}

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
  // The workspace, `change` made to it.
  const changed = (change) => {
    const vfs = workspace()
    change(vfs)
    return vfs
  }
  const found = [
    [['packages/*'], ['packages/a', 'packages/b']],
    [['packages/**'], ['packages/a', 'packages/b', 'packages/f/sub']],
    [['**'], ['other/e', 'packages/a', 'packages/b', 'packages/f/sub', 'tests/t']],
    [['**', '!**/b'], ['other/e', 'packages/a', 'packages/f/sub', 'tests/t']],
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

  // pnpm 10.33.4 and 11.28.2 list .hidden/node_modules/h for .hidden/**:
  // tinyglobby leaves out no node_modules under a directory with a leading
  // dot. What is installed there is no project here.
  it('refuses a node_modules pnpm walks into, and passes over one it leaves out', () => {
    for (const packages of [['.hidden/**'], ['.hidden/*'], ['.hidden/node_modules/*']]) {
      assert.throws(() => findProjects(workspace(), packages, 10), /^DeptreeError: ".hidden\/node_modules": pnpm-workspace\.yaml's packages walk into this node_modules, which is not supported$/u, packages.join(', '))
    }
    const vfs = changed((v) => {
      v.rm('/.hidden/node_modules/h', { recursive: true })
      v.symlink('../other', '/.hidden/link')
      v.symlink('../../x', '/other/node_modules')
    })
    assert.throws(() => findProjects(vfs, ['.hidden/**'], 10), /^DeptreeError: ".hidden\/node_modules": /u, 'an empty one')
    vfs.rm('/.hidden/node_modules', { recursive: true })
    assert.throws(() => findProjects(vfs, ['.hidden/**'], 10), /^DeptreeError: ".hidden\/link\/node_modules": pnpm-workspace\.yaml's packages walk into this node_modules/u, 'a link to one, through a link')
    assert.deepEqual(findProjects(workspace(), ['**', '.hidden/d'], 10), ['.', '.hidden/d', 'other/e', 'packages/a', 'packages/b', 'packages/f/sub', 'tests/t'])
  })

  it('leaves out what a `!` glob takes under a dot directory for pnpm 11 alone', () => {
    const vfs = changed((v) => v.rm('/.hidden/node_modules', { recursive: true }))
    for (const packages of [['.hidden/**', '!**/d'], ['.hidden/*', '!*/d']]) {
      assert.ok(findProjects(vfs, packages, 10).includes('.hidden/d'), packages.join(', '))
      assert.ok(!findProjects(vfs, packages, 11).includes('.hidden/d'), packages.join(', '))
    }
  })

  it('reads only the directories tinyglobby walks into', () => {
    const vfs = changed((v) => v.mkdir('/.git/objects', { recursive: true }))
    const read = []
    const seen = viewOf(vfs, { readdir: (path) => (read.push(path), vfs.readdir(path)) })
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
      [(vfs) => vfs.symlink('../other/e', '/packages/link'), /^DeptreeError: "packages\/link": pnpm finds a project through this link, "packages\/link", which is not supported$/u],
    ]
    // At the root, in place of its package.json: pnpm 10.33.4 and 11.28.2
    // list packages/a alone for none, and lock no root.
    const atRoot = (change) => (vfs) => {
      vfs.unlink('/package.json')
      change(vfs)
    }
    const none = /^DeptreeError: "package\.json": pnpm takes a workspace with no manifest at its root for one with no root project, which is not supported$/u
    cases.push(
      [atRoot((vfs) => vfs.writeFile('/package.yaml', 'name: r')), /^DeptreeError: "package\.yaml": pnpm reads this project's package\.yaml, which is not supported$/u],
      [atRoot((vfs) => vfs.symlink('other/e/package.json', '/package.json')), /^DeptreeError: "package\.json": a link pnpm would read a project's manifest through is not supported$/u],
      [atRoot(() => {}), none],
      [atRoot((vfs) => vfs.symlink('nowhere.json', '/package.json')), none],
    )
    for (const [change, pattern] of cases) assert.throws(() => findProjects(changed(change), ['packages/*'], 10), pattern)
    // As pnpm 10.33.4 and 11.28.2 read them: a link that leads nowhere, or
    // to a directory, is no manifest, and the next name is read.
    for (const target of ['../../nowhere.json', '../../other']) {
      const vfs = changed((v) => v.symlink(target, '/packages/j/package.json'))
      assert.deepEqual(findProjects(vfs, ['packages/*'], 10), ['.', 'packages/a', 'packages/b'], target)
      vfs.writeFile('/packages/j/package.yaml', 'name: j')
      assert.throws(() => findProjects(vfs, ['packages/*'], 10), /^DeptreeError: "packages\/j\/package\.yaml": pnpm reads this project's package\.yaml/u, target)
    }
    // As pnpm 10.33.4 and 11.28.2 have them: a link under a name a `**`
    // cannot take leads nowhere a glob takes, and a loop of links is no
    // manifest.
    const underDot = changed((v) => v.symlink('../other', '/x/.link'))
    assert.deepEqual(findProjects(underDot, ['**'], 10), ['.', 'other/e', 'packages/a', 'packages/b', 'packages/f/sub', 'tests/t'])
    const loop = changed((v) => v.symlink('package.json', '/packages/j/package.json'))
    assert.deepEqual(findProjects(loop, ['packages/*'], 10), ['.', 'packages/a', 'packages/b'])
    // As pnpm 10.33.4 and 11.28.2 follow a link to a directory: a link
    // through which the globs take nothing is no project, and one through
    // which they take one is refused; a link in one followed is not
    // followed, and is refused where tinyglobby would walk into it.
    for (const packages of [['packages/*', '!packages/link'], ['packages/**', '!packages/link'], ['packages/*']]) {
      const vfs = changed((v) => v.symlink(packages.length === 1 ? '../other' : '../other/e', '/packages/link'))
      assert.deepEqual(findProjects(vfs, packages, 10).filter((id) => id.startsWith('packages/')), packages[0] === 'packages/*' ? ['packages/a', 'packages/b'] : ['packages/a', 'packages/b', 'packages/f/sub'], packages.join(', '))
    }
    const nested = changed((v) => {
      v.mkdir('/o')
      v.symlink('../packages', '/o/back')
      v.symlink('../o', '/packages/link')
    })
    assert.throws(() => findProjects(nested, ['packages/**'], 10), /^DeptreeError: "packages\/link": a link to a directory in one tinyglobby follows, "packages\/link\/back", is not supported$/u)
    // A failure other than a path that leads nowhere is thrown.
    const vfs = workspace()
    const denied = viewOf(vfs, { stat: (path) => (path === '/packages/a/package.json' ? assert.fail(Object.assign(new Error('denied'), { code: 'EACCES' })) : vfs.stat(path)) })
    assert.throws(() => findProjects(denied, ['packages/*'], 10), /^Error: denied$/u)
    const passed = changed((v) => {
      v.writeFile('/package.yaml', 'name: r')
      v.writeFile('/packages/a/package.yaml', 'name: a')
      v.writeFile('/other/e/package.yaml', 'name: e')
      v.symlink('../../other/e/package.json', '/packages/a/readme.md')
      v.symlink('../nowhere', '/packages/gone')
      v.symlink('packages', '/elsewhere')
    })
    assert.deepEqual(findProjects(passed, ['packages/*'], 10), ['.', 'packages/a', 'packages/b'])
  })
})

describe('the globs', () => {
  // pnpm 10.33.4 and 11.28.2 list packages/a\nb for packages/*: a project
  // a lockfile could not name, which @preventive/lockfile refuses.
  it('take a name with a line terminator in it by `*`, and refuse the project', () => {
    checkWorkspace(['.', 'packages/a\nb', 'packages/a\rb', 'packages/a\u2028b', 'packages/a\u2029b'], ['packages/a*'])
    // A Vfs holds no such name; a view of a disk may.
    for (const name of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\\b']) {
      const view = viewOfDirs(new Map([['/', ['package.json', 'packages']], ['/packages', ['c', name]], ['/packages/c', ['package.json']], [`/packages/${name}`, ['package.json']]]))
      assert.deepEqual(findProjects(view, ['packages/c'], 10), ['.', 'packages/c'], JSON.stringify(name))
      assert.throws(() => findProjects(view, ['packages/*'], 10), /^DeptreeError: ".*": expected a directory under the lockfile's, by its path from there in normal form, as a lockfile can key an importer$/u, JSON.stringify(name))
    }
    assert.throws(() => findProjects(viewOfDirs(new Map([['/', ['package.json', 'C:b']], ['/C:b', ['package.json']]])), ['*'], 10), /as a lockfile can key an importer$/u)
  })

  // The call stack is as deep reading the deepest directory as the top.
  it('walk however deep a tree is, with no recursion', () => {
    const leaf = `/${'d/'.repeat(200).slice(0, -1)}`
    const depths = new Map()
    const typeOf = (path) => ({ type: path.endsWith('/package.json') ? 'file' : 'directory' })
    const readdir = (path) => {
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = Infinity
      depths.set(path, new Error('depth').stack.split('\n').length)
      Error.stackTraceLimit = limit
      return path === leaf ? ['package.json'] : ['d', ...path === '/' ? ['package.json'] : []]
    }
    assert.deepEqual(findProjects({ readdir, lstat: typeOf, stat: typeOf }, ['**'], 10), ['.', leaf.slice(1)])
    assert.equal(depths.get(leaf), depths.get('/'))
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
