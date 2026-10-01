import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseFoundryLockfile } from '../../foundry.js'

// One small foundry.lock of a dependency of each kind, in the form forge
// writes, and the .gitmodules of its repository; then one edit at a time,
// each of which is refused with a message that says where and why.

const C = '0123456789abcdef0123456789abcdef01234567'
const D = 'fedcba9876543210fedcba9876543210fedcba98'

const BASE = `{
  "lib/a": {
    "tag": {
      "name": "v1.0.0",
      "rev": "${C}"
    }
  },
  "lib/b": {
    "branch": {
      "name": "main",
      "rev": "${D}"
    }
  },
  "lib/c": {
    "rev": "${C}"
  }
}`

const GITMODULES = `[submodule "lib/a"]
\tpath = lib/a
\turl = https://github.com/o/a
[submodule "lib/b"]
\tpath = lib/b
\turl = git@github.com:o/b.git
\tbranch = main
[submodule "lib/c"]
\tpath = lib/c
\turl = https://example.com/c.git
`

const plain = (value) => structuredClone(value)
const parse = (text, options) => parseFoundryLockfile(text, options)

const refuses = (text, message, options) => {
  assert.throws(() => parse(text, options), (error) => {
    assert.ok(error instanceof LockfileError, error)
    assert.equal(error.message, message)
    return true
  })
}

const edit = (from, to, text = BASE) => {
  assert.ok(text.includes(from), from)
  return text.replace(from, to)
}

describe('foundry.lock, as forge writes it', () => {
  it('reads a dependency of each kind', () => {
    assert.deepEqual(plain(parse(BASE, { gitmodules: GITMODULES })), {
      dependencies: {
        'lib/a': { type: 'tag', name: 'v1.0.0', rev: C, url: 'https://github.com/o/a' },
        'lib/b': { type: 'branch', name: 'main', rev: D, url: 'git@github.com:o/b.git' },
        'lib/c': { type: 'rev', name: undefined, rev: C, url: 'https://example.com/c.git' },
      },
    })
  })

  it('reads no dependencies, written {}', () => {
    assert.deepEqual(plain(parse('{}')), { dependencies: {} })
    assert.deepEqual(plain(parse('{}', { gitmodules: '' })), { dependencies: {} })
  })

  it('reads line ends an editor adds, and CRLF throughout as git may check it out', () => {
    for (const text of [`${BASE}\n`, `${BASE}\n\n`, `${BASE.replaceAll('\n', '\r\n')}\r\n`, '{}\n']) {
      assert.deepEqual(Object.keys(parse(text).dependencies), text === '{}\n' ? [] : ['lib/a', 'lib/b', 'lib/c'])
    }
  })

  it('reads a commit of sha256, and names and paths that are not ASCII', () => {
    const sha256 = C.repeat(2).slice(0, 64)
    const lock = parse(`{\n  "lib/é": {\n    "tag": {\n      "name": "v1-é",\n      "rev": "${sha256}"\n    }\n  }\n}`)
    assert.deepEqual(plain(lock.dependencies['lib/é']), { type: 'tag', name: 'v1-é', rev: sha256, url: undefined })
  })

  it('reads a submodule outside the project, from the lockfile\'s directory', () => {
    const text = edit('"lib/c"', '"../../lib/c"')
    const gitmodules = GITMODULES.replaceAll('lib/a', 'p/q/lib/a').replaceAll('lib/b', 'p/q/lib/b')
    assert.deepEqual(Object.keys(parse(text, { gitmodules, directory: 'p/q' }).dependencies), ['lib/a', 'lib/b', '../../lib/c'])
  })
})

describe('foundry.lock, laid out otherwise than forge does', () => {
  it('refuses JSON of another layout', () => {
    const compact = JSON.stringify({ 'lib/c': { rev: C } })
    refuses(compact, `expected "{", or "{}" for no dependencies, found ${JSON.stringify(compact)} at line 1`)
    refuses(JSON.stringify(JSON.parse(BASE), null, 4), 'expected 2 spaces of indentation and a key at line 2')
    refuses(BASE.replaceAll('  ', '\t'), 'U+0009 is not allowed at line 2')
    refuses(edit('{\n  "lib/a"', '{ \n  "lib/a"'), 'expected "{", or "{}" for no dependencies, found "{ " at line 1')
    refuses(edit('"lib/a": {', '"lib/a" : {'), 'expected ": " after "lib/a", found " : {" at line 2')
    refuses(edit('"lib/a": {', '"lib/a":{'), 'expected ": " after "lib/a", found ":{" at line 2')
    refuses(edit(`"rev": "${D}"`, `"rev": "${D}" `), 'expected "," or the end of the line, found " " at line 11')
    refuses(edit('\n  },\n  "lib/b"', '\n  }\n  ,"lib/b"'), 'expected "}", closing the object, found "  ,\\"lib/b\\": {" at line 8')
    refuses('{\n}', 'expected 2 spaces of indentation and a key at line 2')
    refuses('', 'expected "{", or "{}" for no dependencies, found nothing at line 1')
    refuses('{}{}', 'expected "{", or "{}" for no dependencies, found "{}{}" at line 1')
  })

  it('refuses a comma missing, or one too many', () => {
    refuses(edit('  },\n  "lib/b"', '  }\n  "lib/b"'), 'expected "}", closing the object, found "  \\"lib/b\\": {" at line 8')
    refuses(edit(`"rev": "${C}"\n  }\n}`, `"rev": "${C}",\n  }\n}`), 'expected 4 spaces of indentation and a key at line 16')
    refuses(edit(`"${C}"\n  }\n}`, `"${C}"\n  },\n}`), 'expected 2 spaces of indentation and a key at line 17')
    refuses(`${BASE.slice(0, -1)}},`, 'a comma after the last "}" at line 17')
  })

  it('refuses what follows the last }, but for line ends', () => {
    refuses(`${BASE}\n \n`, 'expected the end of the file after the last "}", found " " at line 18')
    refuses(`${BASE}\n{}`, 'expected the end of the file after the last "}", found "{}" at line 18')
    refuses(`${BASE}\r\n`, 'a CRLF line end, after LF ones at line 17')
    refuses(BASE.slice(0, -2), 'expected "}", closing the object, found the end of the file at line 17')
  })

  it('refuses a string written otherwise than serde_json writes it', () => {
    refuses(edit('"lib/a"', '"lib\\/a"'), '"\\"lib\\\\/a\\"" is not written as JSON writes "lib/a" at line 2')
    refuses(edit('"main"', '"\\u006dain"'), '"\\"\\\\u006dain\\"" is not written as JSON writes "main" at line 10')
    refuses(edit('"main"', '"ma\\ud800in"'), '"\\"ma\\\\ud800in\\"" escapes a lone surrogate, which forge does not read at line 10')
    refuses(edit('"main"', '"ma\\xin"'), '"\\"ma\\\\xin\\"" is not a string as JSON writes it at line 10')
    refuses(edit('"main"', '"main'), 'a string with no closing quote at line 10')
    refuses(edit('"main"', "'main'"), 'expected a string, found "\'main\'," at line 10')
    refuses(edit('"main"', '"ma\tin"'), 'U+0009 is not allowed at line 10')
    refuses(`\uFEFF${BASE}`, 'U+FEFF is not allowed at line 1')
  })

  it('refuses a key given twice, which forge and JSON.parse read as the last', () => {
    refuses(edit('"lib/c"', '"lib/a"'), '"lib/a" is a key at line 2 too at line 14')
    refuses(edit('"name": "main",', '"rev": "main",'), '"rev" is a key at line 10 too at line 11')
  })

  it('refuses a value of another kind, or nested deeper', () => {
    refuses(edit(`"rev": "${C}"\n  }\n}`, '"rev": 1\n  }\n}'), 'expected a string or an object, found "1" at line 15')
    refuses(edit(`"rev": "${C}"\n  }\n}`, '"rev": null\n  }\n}'), 'expected a string or an object, found "null" at line 15')
    refuses(edit('"name": "main",', '"name": {},'), 'expected a string, found "{}," at line 10')
    refuses(edit('"lib/c": {\n    "rev"', '"lib/c": [\n    "rev"'), 'expected a string or an object, found "[" at line 14')
  })
})

describe('foundry.lock, of entries forge does not write', () => {
  it('refuses a dependency but of a rev, a tag or a branch alone', () => {
    refuses(edit(`"lib/c": {\n    "rev": "${C}"\n  }`, '"lib/c": {}'), '["lib/c"]: expected one of "rev", "tag" and "branch", found none')
    refuses(edit(`"rev": "${C}"\n  }\n}`, `"rev": "${C}",\n    "tag": {}\n  }\n}`), '["lib/c"]: expected one of "rev", "tag" and "branch", found "rev" and "tag"')
    refuses(edit(`"rev": "${C}"\n  }\n}`, `"commit": "${C}"\n  }\n}`), '["lib/c"]: unsupported field "commit"')
    refuses(edit(`"lib/c": {\n    "rev": "${C}"\n  }`, `"lib/c": "${C}"`), `["lib/c"]: expected a mapping, found the string "${C}"`)
    refuses(edit('"tag": {\n      "name": "v1.0.0",\n', '"tag": {\n'), '["lib/a"].tag.name: expected a string, found nothing')
    refuses(edit(`"name": "main",\n      "rev": "${D}"`, '"name": "main"'), '["lib/b"].branch.rev: expected a string, found nothing')
    refuses(edit('"name": "main",', '"name": "main",\n      "url": "x",'), '["lib/b"].branch: unsupported field "url"')
    refuses(edit('"name": "main",', '"name": {\n      },'), 'expected a string, found "{" at line 10')
  })

  it('refuses a commit but in full, as forge build --locked compares it', () => {
    for (const rev of ['c93f771', C.toUpperCase(), 'origin/main', `${C}0`, '']) {
      refuses(edit(`"rev": "${C}"\n  }\n}`, `"rev": "${rev}"\n  }\n}`), `["lib/c"].rev: "${rev}" is not a full commit hash, which forge build --locked compares the submodule's with`)
    }
    refuses(edit(`"rev": "${D}"`, '"rev": "HEAD"'), '["lib/b"].branch.rev: "HEAD" is not a full commit hash, which forge build --locked compares the submodule\'s with')
  })

  it('refuses a tag or branch name git does not take', () => {
    for (const name of ['v1..0', '.', '-x', 'a b', 'a:b', 'x.lock', 'a//b', '/a', 'a/', 'a.', '@', 'a@{1}', 'a\\b', 'a~1', 'a^', 'a?', 'a*', 'a[b']) {
      refuses(edit('"v1.0.0"', JSON.stringify(name)), `["lib/a"].tag.name: ${JSON.stringify(name)} is not a branch or tag name git takes`)
    }
    refuses(edit('"v1.0.0"', '"\u202Ev1"'), '["lib/a"].tag.name: "\\u202ev1" is not a branch or tag name git takes')
    refuses(edit('"v1.0.0"', '""'), '["lib/a"].tag.name: expected a non-empty string')
  })

  it('refuses a path but of a submodule, in normal form', () => {
    refuses(edit('"lib/c"', '"lib//c"'), '["lib//c"]: "lib//c" is not a relative path in normal form')
    refuses(edit('"lib/c"', '"./lib/c"'), '["./lib/c"]: "./lib/c" is not a relative path in normal form')
    refuses(edit('"lib/c"', '"lib/c/"'), '["lib/c/"]: "lib/c/" is not a relative path in normal form')
    refuses(edit('"lib/c"', '"lib\\\\c"'), '["lib\\\\c"]: "lib\\\\c" is not a relative path in normal form')
    refuses(edit('"lib/c"', '"/lib/c"'), '["/lib/c"]: "/lib/c" is not a relative path in normal form')
    refuses(edit('"lib/c"', '"C:/lib"'), '["C:/lib"]: "C:/lib" starts with a drive letter')
    refuses(edit('"lib/c"', '"."'), '["."]: "." is no submodule\'s path, but a directory it would be in')
    refuses(edit('"lib/c"', '"../.."'), '["../.."]: "../.." is no submodule\'s path, but a directory it would be in')
    refuses(edit('"lib/c"', '"lib/.git/c"'), '["lib/.git/c"]: "lib/.git/c" is in a ".git", where git writes no submodule')
    refuses(edit('"lib/c"', '"-c"'), '["-c"]: "-c" starts with "-", which git ignores the path for')
  })

  it('refuses a dependency inside another, whose submodules forge does not record', () => {
    refuses(edit('"lib/c"', '"lib/a/lib/c"'), '["lib/a/lib/c"]: inside the dependency "lib/a", whose submodules foundry.lock does not record')
    refuses(edit('"lib/a"', '"../x"', edit('"lib/c"', '"../x/c"')), '["../x/c"]: inside the dependency "../x", whose submodules foundry.lock does not record')
  })
})

describe('foundry.lock, against .gitmodules', () => {
  it('refuses a dependency that is no submodule', () => {
    refuses(BASE, '["lib/c"]: no submodule in .gitmodules is at "lib/c"', { gitmodules: GITMODULES.replace(/\[submodule "lib\/c"\][^[]*/u, '') })
  })

  it('reads a submodule the lockfile does not record, as a section whose gitlink is gone may be', () => {
    const stale = `${GITMODULES}[submodule "lib/d"]\n\tpath = lib/d\n\turl = https://x.example/d\n`
    assert.deepEqual(Object.keys(parse(BASE, { gitmodules: stale }).dependencies), ['lib/a', 'lib/b', 'lib/c'])
    const elsewhere = `${GITMODULES.replaceAll('= lib/', '= p/lib/')}[submodule "d"]\n\tpath = x/lib/d\n\turl = https://x.example/d\n`
    assert.deepEqual(Object.keys(parse(BASE, { gitmodules: elsewhere, directory: 'p' }).dependencies), ['lib/a', 'lib/b', 'lib/c'])
  })

  it('refuses a path out of the repository, or up and back into the project', () => {
    refuses(edit('"lib/c"', '"../lib/c"'), '["../lib/c"]: outside the repository, from the lockfile\'s directory "." in it', { gitmodules: GITMODULES })
    refuses(edit('"lib/c"', '"../p/lib/c"'), '["../p/lib/c"]: not as forge writes the path, "lib/c"', { gitmodules: GITMODULES.replaceAll('lib/', 'p/lib/'), directory: 'p' })
  })

  it('names .gitmodules in what it refuses there', () => {
    refuses(BASE, 'gitmodules: a section of [core] where .gitmodules has [submodule "name"] alone, at line 1', { gitmodules: `[core]\n\tbare = false\n${GITMODULES}` })
    refuses(BASE, 'gitmodules: a value with no closing quote at line 3', { gitmodules: GITMODULES.replace('url = https://github.com/o/a', 'url = "https://github.com/o/a') })
    refuses(BASE, 'gitmodules["lib/b"].url: "../b.git" is relative to the superproject\'s remote, which only a clone of it knows', { gitmodules: GITMODULES.replace('git@github.com:o/b.git', '../b.git') })
  })

  it('takes a url as written, and a submodule without one, with checkUrls false', () => {
    const gitmodules = GITMODULES.replace('git@github.com:o/b.git', '../b.git').replace('\turl = https://example.com/c.git\n', '')
    const { dependencies } = parse(BASE, { gitmodules, checkUrls: false })
    assert.deepEqual(Object.values(dependencies).map((dependency) => dependency.url), ['https://github.com/o/a', '../b.git', undefined])
    refuses(BASE, 'gitmodules["lib/b"].url: "../b.git" is relative to the superproject\'s remote, which only a clone of it knows', { gitmodules })
    refuses(BASE, 'gitmodules["lib/b"].url: "../b.git" is relative to the superproject\'s remote, which only a clone of it knows', { gitmodules, checkUrls: true })
  })

  it('refuses options it does not take', () => {
    const type = (options, message) => assert.throws(() => parse(BASE, options), (error) => error instanceof TypeError && error.message === message)
    type(null, 'expected an options object')
    type({ manifests: {} }, 'unknown option "manifests", of gitmodules, directory, checkUrls')
    type({ gitmodules: {} }, 'gitmodules: expected the text of .gitmodules')
    type({ directory: 'p' }, 'directory needs gitmodules, whose paths it is for')
    type({ checkUrls: false }, 'checkUrls needs gitmodules, whose urls it is for')
    type({ gitmodules: GITMODULES, checkUrls: 'no' }, 'checkUrls: expected a boolean')
    for (const directory of ['', '/p', 'p/', '../p', 'p/../q', './p', 1]) {
      type({ gitmodules: GITMODULES, directory }, 'directory: expected a path in the repository, from its root, as "." or "packages/contracts"')
    }
    assert.throws(() => parseFoundryLockfile(Buffer.from(BASE)), (error) => error instanceof TypeError && error.message === 'expected a string')
  })
})
