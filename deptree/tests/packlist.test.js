import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { packDirectory } from '../src/pnpm/packlist.js'

// What pnpm 9, 10, 11 and 12 install of a `file:` dependency's directory.
// Each list here is what real installs of these versions kept, file for file.
const V9 = '9.15.9'
const V10 = '10.33.4'
const V11 = '11.28.2'
const V12 = '12.8.1'
const NPM_PACKLISTS = [V9, '10.30.3', V10, '11.27.0', V11]

const textOf = (paths) => Object.fromEntries(paths.map((path) => [path, `// ${path}\n`]))
const pack = (files, pnpm, fields = {}, { raw } = {}) => {
  const manifest = { name: 'foo', version: '1.0.0', ...fields }
  const all = { 'package.json': raw ?? JSON.stringify(manifest), ...Array.isArray(files) ? textOf(files) : files }
  const vfs = createVfs(Object.fromEntries(Object.entries(all).map(([path, text]) => [`d/${path}`, text])))
  return [...packDirectory(vfs, 'd', manifest, pnpm, 'x').keys()]
}

// `wanted` maps each version, or versions joined by a space, to its list.
const keeps = (files, fields, wanted, options) => {
  for (const [versions, list] of Object.entries(wanted)) {
    for (const pnpm of versions.split(' ')) assert.deepEqual(pack(files, pnpm, fields, options), [...list].sort(), pnpm)
  }
}

describe('packDirectory by the built-in rules', () => {
  const fields = { main: 'index.js', bin: { foo: 'cli.js' } }

  it('leaves out what npm-packlist leaves out by its own', () => {
    const files = [
      'index.js', 'cli.js', '.hidden', 'README.md', 'lib/x.js',
      '.git/HEAD', 'lib/CVS/Root', 'lib/cvs2/y', '.npmrc', 'lib/.DS_Store', 'NPM-DEBUG.LOG',
      '._foo', 'lib/.x.swp', 'X.ORIG', '.lock-wscript', '.wafpickle-7', 'build/config.gypi',
      'build/other.gypi', 'archived-packages/x', 'package-lock.json', 'Yarn.Lock', 'lib/yarn.lock', 'star*.js',
    ]
    keeps(files, fields, {
      [NPM_PACKLISTS.join(' ')]: ['.hidden', 'README.md', 'build/other.gypi', 'cli.js', 'index.js', 'lib/cvs2/y', 'lib/x.js', 'lib/yarn.lock', 'package.json'],
      [V12]: ['._foo', '.hidden', '.lock-wscript', '.wafpickle-7', 'NPM-DEBUG.LOG', 'README.md', 'X.ORIG', 'Yarn.Lock', 'archived-packages/x', 'build/config.gypi', 'build/other.gypi', 'cli.js', 'index.js', 'lib/.x.swp', 'lib/cvs2/y', 'lib/x.js', 'package.json', 'star*.js'],
    })
  })

  // pnpm 12's rules go by the name as it is spelled, and leave out a
  // directory only by its VCS name, or as node_modules at the top; pnpm 11's
  // leave out node_modules whatever its case.
  it('leaves out what pnpm 12 leaves out by its own, and a node_modules', () => {
    const files = [
      'index.js', 'cli.js', '.git/HEAD', 'lib/CVS/Root', 'cvs/x', 'lib/.npmrc', 'lib/.DS_Store', '.DS_store',
      'npm-debug.log', 'NPM-DEBUG.LOG', 'a.orig', 'X.ORIG', 'x.orig/a.js', 'yarn.lock', 'lib/yarn.lock', 'Yarn.Lock',
      'pnpm-lock.yaml', 'yarn.lock.d/b', '._foo', '.lock-wscript', 'build/config.gypi', 'bun.lockb', 'star*.js',
      'Node_Modules/q.js', 'node_modules/n/index.js', 'lib/README.orig',
    ]
    keeps(files, fields, {
      [`${V9} ${V10}`]: ['Node_Modules/q.js', 'bun.lockb', 'cli.js', 'index.js', 'lib/README.orig', 'lib/yarn.lock', 'package.json', 'yarn.lock.d/b'],
      [V11]: ['cli.js', 'index.js', 'lib/yarn.lock', 'package.json', 'yarn.lock.d/b'],
      [V12]: ['.DS_store', '._foo', '.lock-wscript', 'NPM-DEBUG.LOG', 'Node_Modules/q.js', 'X.ORIG', 'Yarn.Lock', 'build/config.gypi', 'bun.lockb', 'cli.js', 'cvs/x', 'index.js', 'package.json', 'star*.js', 'x.orig/a.js', 'yarn.lock.d/b'],
    })
    assert.throws(() => pack({ 'node_modules/x.js': '' }, V12, { main: './node_modules/x.js' }), /^DeptreeError: x: main or bin names "node_modules\/x\.js", which pnpm 12 keeps as it is spelled, and which is not supported$/u)
  })

  // npm-packlist keeps what main, browser and bin name; pnpm 12 what main
  // and bin name, where its rules but node_modules's do not leave it out.
  // npm-packlist 5 reads a bin normalized, npm-packlist 10 as it is.
  it('keeps what main, browser and bin name, each by its own rules', () => {
    keeps(['index.js', '.npmrc', 'x.orig', 'yarn.lock', '.git/a.js'], { browser: '.npmrc', main: 'x.orig', bin: { foo: 'yarn.lock', bar: './.git/a.js' } }, {
      [`${V9} ${V10}`]: ['.npmrc', 'index.js', 'package.json', 'x.orig', 'yarn.lock'],
      [V11]: ['.git/a.js', '.npmrc', 'index.js', 'package.json', 'x.orig', 'yarn.lock'],
      [V12]: ['index.js', 'package.json'],
    })
  })

  // npm-packlist 10 rereads its rules for the top in every directory.
  it('leaves out bun.lockb for pnpm 11 alone, and the rules at the top in every directory', () => {
    keeps(['index.js', 'cli.js', 'bun.lockb', 'lib/.lock-wscript', 'lib/.wafpickle-1', 'lib/build/config.gypi', 'lib/archived-packages/y'], fields, {
      [`${V9} ${V10} ${V12}`]: ['bun.lockb', 'cli.js', 'index.js', 'lib/.lock-wscript', 'lib/.wafpickle-1', 'lib/archived-packages/y', 'lib/build/config.gypi', 'package.json'],
      [V11]: ['cli.js', 'index.js', 'package.json'],
    })
  })

  it('takes an empty list of bundled dependencies, which bundles none', () => {
    for (const bundled of [{ bundleDependencies: [] }, { bundledDependencies: [] }, { bundleDependencies: [], bundledDependencies: [] }]) {
      assert.deepEqual(pack(['index.js'], V10, bundled), ['index.js', 'package.json'], JSON.stringify(bundled))
    }
  })
})

describe('packDirectory by package.json\'s files', () => {
  const COMMON = ['index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'test/x.test.js', 'README.md', 'LICENSE', 'CHANGELOG.md', '.npmrc', 'lib/.DS_Store', 'lib/x.orig', 'docs/guide.md']
  const ALL = [...NPM_PACKLISTS, V12].join(' ')

  // A leading `/` or `./` is the top's; a .gitignore there is not read.
  it('keeps each file it lists, however it spells the path', () => {
    const files = { ...textOf(COMMON), '.gitignore': 'lib\ntest\n', 'lib/.gitignore': 'a.js\n' }
    keeps(files, { main: 'index.js', files: ['/index.js', '/lib/a.js', '/lib/sub/c.js', 'lib/b.js', './docs/guide.md', '/nope.js'] }, {
      [ALL]: ['LICENSE', 'README.md', 'docs/guide.md', 'index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'package.json'],
    })
  })

  // ExodusOSS/bytes, which pnpm 10 installs as a package by `file:.`.
  it('keeps a list of files beside a .gitignore and a browser map', () => {
    const files = { ...textOf([...COMMON, 'fallback/utf8.js', 'fallback/latin1.js', 'utf16.js', 'utf16.browser.js', 'tests/t.js']), '.gitignore': '*~\nnode_modules\npackage-lock.json\ncoverage\n' }
    keeps(files, { main: 'index.js', browser: { './utf16.js': './utf16.browser.js' }, files: ['/fallback/utf8.js', '/fallback/latin1.js', '/index.js', '/utf16.js', '/utf16.browser.js'] }, {
      [ALL]: ['LICENSE', 'README.md', 'fallback/latin1.js', 'fallback/utf8.js', 'index.js', 'package.json', 'utf16.browser.js', 'utf16.js'],
    })
  })

  // npm-packlist 5 and 10 read a directory's .npmignore and .gitignore
  // where `files` has them walk it; pnpm 12 reads none where `files` is set.
  it('keeps what a directory it lists holds', () => {
    const files = { ...textOf([...COMMON, 'bin/cli.js', 'lib/sub/README', 'lib/sub/.npmrc', 'lib/secret.js', 'src/a/b/c.js', 'src/a/x.js', 'src/y.js']), 'lib/.npmignore': 'secret.js\n' }
    keeps(files, { files: ['lib', 'bin/', 'src/a'] }, {
      [NPM_PACKLISTS.join(' ')]: ['LICENSE', 'README.md', 'bin/cli.js', 'lib/a.js', 'lib/b.js', 'lib/sub/README', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json', 'src/a/b/c.js', 'src/a/x.js'],
      [V12]: ['LICENSE', 'README.md', 'bin/cli.js', 'lib/.npmignore', 'lib/a.js', 'lib/b.js', 'lib/secret.js', 'lib/sub/README', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json', 'src/a/b/c.js', 'src/a/x.js'],
    })
  })

  // npm-packlist 10 takes `lib/**/*.ts` to have it walk lib, and keeps all
  // of it.
  it('keeps what its globs take, less what a `!` one takes back', () => {
    const files = textOf([...COMMON, 'dist/a.js', 'dist/a.js.map', 'dist/sub/b.js', 'types/a.d.ts', 'types/deep/b.d.ts', 'x.mjs'])
    keeps(files, { files: ['*.js', 'lib/**/*.ts', 'dist/*', '!dist/*.map', 'types/**', '*.mjs'] }, {
      [`${V9} 10.30.3 ${V10} ${V12}`]: ['LICENSE', 'README.md', 'dist/a.js', 'dist/sub/b.js', 'index.js', 'lib/sub/d.ts', 'package.json', 'types/a.d.ts', 'types/deep/b.d.ts', 'x.mjs'],
      [`11.27.0 ${V11}`]: ['LICENSE', 'README.md', 'dist/a.js', 'dist/sub/b.js', 'index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json', 'types/a.d.ts', 'types/deep/b.d.ts', 'x.mjs'],
    })
    keeps(textOf([...COMMON, 'lib/internal/keep.js', 'lib/internal/drop.js']), { files: ['lib', '!lib/internal', '!lib/b.js', 'lib/internal/keep.js'] }, {
      [ALL]: ['LICENSE', 'README.md', 'lib/a.js', 'lib/internal/keep.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json'],
    })
    keeps(textOf([...COMMON, 'dist/a.js', 'dist/a.test.js', 'dist/sub/b.test.js', 'dist/sub/b.js']), { files: ['dist', '!**/*.test.js', '!dist/sub/b.js'] }, {
      [ALL]: ['LICENSE', 'README.md', 'dist/a.js', 'package.json'],
    })
  })

  // npm-packlist keeps a readme, copying, license or licence by the name
  // and a `.` and any end but `~` or `$`, at the top or in a directory it
  // walks; pnpm 12 one at the top that starts so, but copying.
  it('keeps package.json, a readme, a license and what main, browser and bin name', () => {
    const files = textOf([...COMMON, 'main.js', 'browser.js', 'bin/cli.js', 'COPYING', 'licence-mit.txt', 'readme.zh.md', 'README.md~', 'lib/README', 'Readme-dev.md'])
    keeps(files, { main: 'main.js', browser: 'browser.js', bin: { foo: './bin/cli.js' }, files: ['lib'] }, {
      [NPM_PACKLISTS.join(' ')]: ['COPYING', 'LICENSE', 'README.md', 'bin/cli.js', 'browser.js', 'lib/README', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'main.js', 'package.json', 'readme.zh.md'],
      [V12]: ['LICENSE', 'README.md', 'README.md~', 'Readme-dev.md', 'bin/cli.js', 'lib/README', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'licence-mit.txt', 'main.js', 'package.json', 'readme.zh.md'],
    })
  })

  // glob in npm-packlist 5 and minimatch in 10 match without case, pnpm 12
  // with it; npm-packlist 10 walks into `LIB` no more than into lib.
  it('matches without case for pnpm 9, 10 and 11, and with it for pnpm 12', () => {
    keeps(textOf([...COMMON, 'Docs/A.md']), { files: ['LIB', 'Index.JS', 'docs'] }, {
      [`${V9} ${V10}`]: ['Docs/A.md', 'LICENSE', 'README.md', 'docs/guide.md', 'index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json'],
      [V11]: ['Docs/A.md', 'LICENSE', 'README.md', 'docs/guide.md', 'index.js', 'package.json'],
      [V12]: ['LICENSE', 'README.md', 'docs/guide.md', 'package.json'],
    })
  })

  // npm-packlist 5 keeps each path a glob takes in spite of its own rules.
  it('keeps for pnpm 9 and 10 what a glob takes that their rules leave out', () => {
    keeps(textOf(COMMON), { files: ['index.js/', 'lib/a.js', 'lib/*'] }, {
      [`${V9} ${V10}`]: ['LICENSE', 'README.md', 'lib/.DS_Store', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'lib/x.orig', 'package.json'],
      [`${V11} ${V12}`]: ['LICENSE', 'README.md', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json'],
    })
    keeps(textOf([...COMMON, '.eslintrc', 'lib/.hidden.js', '.github/ci.yml']), { files: ['.*', 'lib/.*'] }, {
      [`${V9} ${V10}`]: ['.eslintrc', '.github/ci.yml', '.npmrc', 'LICENSE', 'README.md', 'lib/.DS_Store', 'lib/.hidden.js', 'package.json'],
      [V11]: ['.eslintrc', 'LICENSE', 'README.md', 'lib/.hidden.js', 'package.json'],
      [V12]: ['.eslintrc', '.github/ci.yml', 'LICENSE', 'README.md', 'lib/.hidden.js', 'package.json'],
    })
  })

  // pnpm 12 takes a list with no entry as no list.
  it('keeps for an empty list what each keeps by its own rules', () => {
    keeps(['index.js', 'lib/a.js', 'README.md'], { main: 'index.js', files: [] }, {
      [`${V9} ${V10} ${V11}`]: ['README.md', 'index.js', 'package.json'],
      [V12]: ['README.md', 'index.js', 'lib/a.js', 'package.json'],
    })
  })
})

describe('packDirectory by .npmignore and .gitignore', () => {
  const COMMON = ['index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'test/x.test.js', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/guide.md']

  // pnpm 12 keeps the ignore files themselves.
  it('leaves out what a .gitignore does, at the top and below', () => {
    const files = { ...textOf([...COMMON, 'dist/a.js', 'dist/keep.js', 'build/out.js', 'lib/build/out.js', 'x.log', 'lib/tmp/t.js', 'coverage/c.json']), '.gitignore': 'node_modules\ncoverage\n*.log\ndist/\n!dist/keep.js\n/build\n# comment\n\n', 'lib/.gitignore': 'tmp/\n' }
    const kept = ['CHANGELOG.md', 'LICENSE', 'README.md', 'docs/guide.md', 'index.js', 'lib/a.js', 'lib/b.js', 'lib/build/out.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json', 'test/x.test.js']
    keeps(files, { main: 'index.js' }, {
      [`${V9} ${V10} ${V11}`]: [...kept, 'dist/a.js', 'dist/keep.js'],
      [V12]: [...kept, '.gitignore', 'lib/.gitignore'],
    })
    const negated = { ...textOf([...COMMON, 'gen/a.js', 'gen/b.js', 'gen/keep/c.js', 'out.log', 'keep.log']), '.gitignore': 'gen/*\n!gen/keep/\n*.log\n!keep.log\n' }
    const back = ['CHANGELOG.md', 'LICENSE', 'README.md', 'docs/guide.md', 'gen/keep/c.js', 'index.js', 'keep.log', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json', 'test/x.test.js']
    keeps(negated, {}, { [`${V9} ${V10} ${V11}`]: back, [V12]: [...back, '.gitignore'] })
  })

  // A .npmignore has npm-packlist pass over the .gitignore beside it, and
  // pnpm 12 over every .gitignore where the top has one; below a top
  // without, pnpm 12 reads both.
  it('reads a .npmignore over a .gitignore', () => {
    const top = { ...textOf(COMMON), '.npmignore': 'test/\n*.md\n', '.gitignore': 'lib/\n' }
    const kept = ['LICENSE', 'README.md', 'index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json']
    keeps(top, {}, { [`${V9} ${V10} ${V11}`]: kept, [V12]: [...kept, '.gitignore', '.npmignore'] })
    const below = { ...textOf([...COMMON, 'lib/gen/g.js', 'lib/x.test.js', 'src/gen/g.js']), 'lib/.npmignore': '*.test.js\n', 'lib/.gitignore': 'gen/\n', '.gitignore': '/src/gen\n' }
    const both = ['CHANGELOG.md', 'LICENSE', 'README.md', 'docs/guide.md', 'index.js', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json', 'test/x.test.js']
    keeps(below, {}, { [`${V9} ${V10} ${V11}`]: [...both, 'lib/gen/g.js'], [V12]: [...both, '.gitignore', 'lib/.gitignore', 'lib/.npmignore'] })
  })

  // `files` has npm-packlist pass over the top's ignore files, but not over
  // those of a directory it walks; pnpm 12 reads none.
  it('reads below where `files` has it walk', () => {
    keeps({ ...textOf(COMMON), '.npmignore': 'lib/b.js\n' }, { files: ['lib'] }, {
      [`${V9} ${V10} ${V11} ${V12}`]: ['LICENSE', 'README.md', 'lib/a.js', 'lib/b.js', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json'],
    })
    keeps({ ...textOf(COMMON), 'lib/.gitignore': 'b.js\n', 'lib/sub/.npmignore': '*.ts\n' }, { files: ['lib', 'index.js'] }, {
      [`${V9} ${V10} ${V11}`]: ['LICENSE', 'README.md', 'index.js', 'lib/a.js', 'lib/sub/c.js', 'package.json'],
      [V12]: ['LICENSE', 'README.md', 'index.js', 'lib/.gitignore', 'lib/a.js', 'lib/b.js', 'lib/sub/.npmignore', 'lib/sub/c.js', 'lib/sub/d.ts', 'package.json'],
    })
  })

  // npm-packlist makes each character of a bin that is a string a rule of
  // its own for pnpm 11, and the path of a browser that is an object
  // `[object Object]`, which takes one character of those for pnpm 9 to 11.
  it('keeps what npm-packlist makes of a bin or a browser it reads as text', () => {
    keeps({ ...textOf(['cli.js', 'c', 'l', 'i', 's', 'j', 'x']), '.npmignore': 'c\nl\nx\ns\n' }, { bin: 'cli.js' }, {
      [`${V9} ${V10}`]: ['cli.js', 'i', 'j', 'package.json'],
      [V11]: ['c', 'cli.js', 'i', 'j', 'l', 'package.json', 's'],
      [V12]: ['.npmignore', 'cli.js', 'i', 'j', 'package.json'],
    })
    keeps({ ...textOf(['index.js', 'o', 'z', 'B']), '.npmignore': 'o\nz\nB\n' }, { browser: { './index.js': './b.js' } }, {
      [`${V9} ${V10} ${V11}`]: ['B', 'index.js', 'o', 'package.json'],
      [V12]: ['.npmignore', 'index.js', 'package.json'],
    })
  })
})

describe('packDirectory by the version that installs', () => {
  // minimatch 5.1.9, which pnpm 10 bundles from 10.31, matches `**` by other
  // steps than 5.1.6.
  it('matches `**` as the minimatch that version bundles', () => {
    const files = { 'index.js': 'i', 'd/c/x.js': 'x', 'd/y.js': 'y', '.npmignore': '**/*/c/**/**\n' }
    keeps(files, {}, {
      [`${V9} 10.30.3 ${V11}`]: ['d/y.js', 'index.js', 'package.json'],
      [V10]: ['d/c/x.js', 'd/y.js', 'index.js', 'package.json'],
      [V12]: ['.npmignore', 'd/y.js', 'index.js', 'package.json'],
    })
  })

  it('keeps a package.yaml and a package.json5 for pnpm from 11.28', () => {
    keeps(['lib/a.js', 'package.yaml', 'PACKAGE.JSON5', 'other.yaml'], { files: ['lib'] }, {
      [`${V9} ${V10} 11.27.0`]: ['lib/a.js', 'package.json'],
      [`${V11} ${V12}`]: ['PACKAGE.JSON5', 'lib/a.js', 'package.json', 'package.yaml'],
    })
  })

  it('reads the version as semver does, with a `v` or spaces', () => {
    const files = ['lib/a.js', 'package.yaml', 'test/t.js']
    for (const given of [`v${V11}`, ` ${V11} `]) assert.deepEqual(pack(files, given, { files: ['lib'] }), ['lib/a.js', 'package.json', 'package.yaml'], given)
    assert.deepEqual(pack(files, `v${V10}`, { files: ['lib'] }), ['lib/a.js', 'package.json'])
    assert.deepEqual(pack(files, `v${V12}`, { files: ['lib'] }), ['lib/a.js', 'package.json', 'package.yaml'])
    assert.throws(() => pack(['a.js'], `v${V11}`, { bin: { a: 5 } }), /which pnpm 11 fails on$/u)
  })

  // npm-packlist 5 fails to parse a package.json with a byte order mark, and
  // reads it then as none; pnpm 11 fails on one before 11.28.
  it('reads a package.json with a byte order mark as each does', () => {
    const files = { ...textOf(['lib/a.js', 'index.js', 'test/t.js', 'x.orig']), '.npmignore': 'test\n' }
    const raw = '\uFEFF{"name":"foo","version":"1.0.0","main":"x.orig","files":["lib"]}'
    keeps(files, { main: 'x.orig', files: ['lib'] }, {
      [`${V9} ${V10}`]: ['index.js', 'lib/a.js', 'package.json'],
      [V11]: ['lib/a.js', 'package.json', 'x.orig'],
      [V12]: ['lib/a.js', 'package.json'],
    }, { raw })
    assert.throws(() => pack(files, '11.27.0', { main: 'x.orig', files: ['lib'] }, { raw }), /^DeptreeError: x: its package\.json starts with a byte order mark, which pnpm 11 fails on before 11\.28$/u)
  })
})

describe('packDirectory refuses', () => {
  const refused = [
    ['braces in files', [], { files: ['lib/{a,b}.js'] }, /^DeptreeError: x: "lib\/\{a,b\}\.js" has glob syntax, which is not followed here: of glob syntax, only \* and \? are$/u],
    ['a class in files', [], { files: ['lib/[ab].js'] }, /"lib\/\[ab\]\.js" has glob syntax/u],
    ['an extglob in a .gitignore', { '.gitignore': '+(a|b).js\n' }, {}, /^DeptreeError: x: "\.gitignore": "\+\(a\|b\)\.js" has glob syntax/u],
    ['an escape in a .npmignore', { 'lib/.npmignore': '\\#x\n' }, {}, /^DeptreeError: x: "lib\/\.npmignore": "\\\\#x" has glob syntax/u],
    ['files that is not a list of strings', [], { files: 'lib' }, /^DeptreeError: x: its package\.json has `files` that is not a list of strings, which is not supported$/u],
    ['files with other than strings', [], { files: ['lib', 5] }, /`files` that is not a list of strings/u],
    ['a path out of the directory that pnpm 10 would glob', [], { files: ['../x'] }, /^DeptreeError: x: "\.\.\/x" has a \.\. part, which is not followed here/u],
    ['a bin list with other than strings', ['a.js'], { bin: ['a.js', 5] }, /^DeptreeError: x: its package\.json has a bin list with other than strings/u],
    ['an ignore file that is not UTF-8', { '.npmignore': new Uint8Array([0xFF, 0x0A]) }, {}, /^DeptreeError: x: "\.npmignore": it is not UTF-8, which is not supported$/u],
    ['a path a pattern spells with a .', ['lib/a.js'], { files: ['lib/./a.js'] }, /^DeptreeError: x: "lib\/\.\/a\.js": pnpm keeps it as a pattern spells it, which is not supported$/u],
    ['bundled dependencies', [], { bundleDependencies: ['a'] }, /^DeptreeError: x: a directory with bundled dependencies is not supported$/u],
    ['all dependencies bundled', [], { bundledDependencies: true }, /bundled dependencies is not supported/u],
    ['bundled dependencies beside an empty list', [], { bundleDependencies: [], bundledDependencies: ['a'] }, /bundled dependencies is not supported/u],
  ]
  for (const [what, files, fields, pattern] of refused) {
    it(what, () => assert.throws(() => pack(files, V10, fields), pattern))
  }

  it('a bin that is not a string, for pnpm 11, which fails on it', () => {
    assert.throws(() => pack(['a.js'], V11, { bin: { a: 5 } }), /^DeptreeError: x: its package\.json has a bin that is not a string, which pnpm 11 fails on$/u)
  })

  it('an ignore file that is a directory, which pnpm fails to read', () => {
    for (const pnpm of [V10, V11, V12]) assert.throws(() => pack({ '.npmignore/x': '' }, pnpm), /^DeptreeError: x: "\.npmignore": it is not a file, which pnpm fails to read$/u, pnpm)
  })

  it('a link, and a mode a checkout does not have', () => {
    const manifest = { name: 'foo', version: '1.0.0' }
    const vfs = createVfs({ 'd/package.json': JSON.stringify(manifest), 'd/a.js': '' })
    vfs.symlink('a.js', '/d/b.js')
    for (const pnpm of [V10, V11, V12]) assert.throws(() => packDirectory(vfs, 'd', manifest, pnpm, 'x'), /^DeptreeError: x: "b\.js": a link in a directory pnpm installs a copy of is not supported$/u, pnpm)
    const odd = createVfs({ 'd/package.json': JSON.stringify(manifest), 'd/a.js': '' })
    odd.chmod('/d/a.js', 0o600)
    assert.throws(() => packDirectory(odd, 'd', manifest, V10, 'x'), /^DeptreeError: x: "a\.js": its mode, 600, is not 644, 664, 755 or 775, which is not supported$/u)
  })

  // Not refused: a checkout's modes under umask 002, kept as they are.
  it('nothing of 664 or 775', () => {
    const manifest = { name: 'foo', version: '1.0.0' }
    const vfs = createVfs({ 'd/package.json': JSON.stringify(manifest), 'd/a.js': '', 'd/b.sh': '' })
    vfs.chmod('/d/package.json', 0o664)
    vfs.chmod('/d/a.js', 0o664)
    vfs.chmod('/d/b.sh', 0o775)
    for (const pnpm of [V10, V11, V12]) {
      const modes = [...packDirectory(vfs, 'd', manifest, pnpm, 'x')].map(([path, { mode }]) => [path, mode])
      assert.deepEqual(modes, [['a.js', 0o664], ['b.sh', 0o775], ['package.json', 0o664]], pnpm)
    }
  })

  // A link the rules leave out is never looked at.
  it('no link a .gitignore leaves out', () => {
    const manifest = { name: 'foo', version: '1.0.0' }
    const vfs = createVfs({ 'd/package.json': JSON.stringify(manifest), 'd/a.js': '', 'd/.gitignore': 'b.js\n' })
    vfs.symlink('a.js', '/d/b.js')
    assert.deepEqual([...packDirectory(vfs, 'd', manifest, V10, 'x').keys()], ['a.js', 'package.json'])
  })
})

describe('packDirectory bounds', () => {
  const ALL = [...NPM_PACKLISTS, V12]
  const own = (pnpm, name) => (pnpm === V12 ? [name] : [])

  it('matches in time linear in the path and the pattern', () => {
    const start = performance.now()
    const name = 'a'.repeat(250)
    const glob = `${'*a'.repeat(60)}b`
    for (const pnpm of ALL) {
      assert.deepEqual(pack({ [name]: '', b: '' }, pnpm, { files: [glob] }), ['package.json'], pnpm)
      assert.deepEqual(pack({ [`l/${name}`]: '', '.npmignore': `${glob}\n` }, pnpm), [...own(pnpm, '.npmignore'), `l/${name}`, 'package.json'], pnpm)
      assert.deepEqual(pack({ x: '', 'a/b/x': '', y: '', '.npmignore': `${'**/'.repeat(100)}x\n` }, pnpm), [...own(pnpm, '.npmignore'), 'package.json', 'y'], pnpm)
    }
    assert.ok(performance.now() - start < 1000, `${performance.now() - start}ms`)
  })

  // Past it minimatch may make too large a regexp, which pnpm 9, 10 and 11
  // fail on, and globset one, which pnpm 12 drops with its whole file.
  it('a pattern of up to 4096 characters', () => {
    for (const pnpm of ALL) {
      assert.deepEqual(pack({ x: '', ya: '', '.npmignore': `${'*a'.repeat(2048)}\n` }, pnpm), [...own(pnpm, '.npmignore'), 'package.json', 'x', 'ya'], pnpm)
      assert.throws(() => pack({ x: '', '.npmignore': `${'*a'.repeat(2048)}b\n` }, pnpm), /^DeptreeError: x: "\.npmignore": a pattern of more than 4096 characters, which pnpm may make too large a regexp of, is not supported$/u, pnpm)
      assert.throws(() => pack(['x'], pnpm, { files: [`${'*'.repeat(4096)}x`] }), /a pattern of more than 4096 characters/u, pnpm)
    }
  })

  it('for pnpm 12, an ignore file or files of up to 16 KiB', () => {
    const lines = (count) => ['y', ...Array.from({ length: count }, () => '*a')].join('\n')
    assert.deepEqual(pack({ x: '', y: '', '.gitignore': lines(5460) }, V12), ['.gitignore', 'package.json', 'x'])
    assert.throws(() => pack({ x: '', y: '', '.gitignore': lines(5461) }, V12), /^DeptreeError: x: "\.gitignore": an ignore file of more than 16 KiB, all of which pnpm 12 may drop as too large a regexp, is not supported$/u)
    assert.deepEqual(pack({ x: '', y: '', '.gitignore': lines(5461) }, V11), ['package.json', 'x'])
    const files = (count) => ['x', ...Array.from({ length: count }, () => '*a')]
    assert.deepEqual(pack(['x', 'y'], V12, { files: files(5460) }), ['package.json', 'x'])
    assert.throws(() => pack(['x', 'y'], V12, { files: files(5461) }), /^DeptreeError: x: its package\.json has `files` of more than 16 KiB, all of which pnpm 12 may drop/u)
  })

  it('for pnpm 9 and 10, a pattern with up to 100 ** parts, each matched in turn', () => {
    for (const pnpm of NPM_PACKLISTS) {
      const glob = `${'**/'.repeat(101)}x`
      if (pnpm.startsWith('11.')) assert.deepEqual(pack(['x', 'y'], pnpm, { files: [glob] }), ['package.json', 'x'], pnpm)
      else assert.throws(() => pack(['x', 'y'], pnpm, { files: [glob] }), /^DeptreeError: x: "(?:\*\*\/)+[^"]+" has more than 100 \*\* parts, which is not supported$/u, pnpm)
    }
    assert.deepEqual(pack(['x', 'y'], V12, { files: [`${'**/'.repeat(101)}x`] }), ['package.json', 'x'])
  })

  it('a directory nested up to 100 deep', () => {
    for (const pnpm of [V10, V12]) {
      assert.deepEqual(pack([`${'a/'.repeat(100)}x`], pnpm), [`${'a/'.repeat(100)}x`, 'package.json'], pnpm)
      assert.throws(() => pack([`${'a/'.repeat(101)}x`], pnpm), /^DeptreeError: x: "a\/a[^"]+": a directory nested more than 100 deep/u, pnpm)
    }
  })
})
