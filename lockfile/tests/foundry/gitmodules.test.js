import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseGitmodules } from '../../foundry.js'

// .gitmodules as git writes it, and as people write it by hand in the forms
// git reads alike; then each thing git refuses, ignores, reads two ways, or
// reads to a path or a URL nothing can be installed from, refused with a
// message that says where and why.

const BASE = `[submodule "lib/a"]
\tpath = lib/a
\turl = https://github.com/o/a
[submodule "lib/b"]
\tpath = lib/b
\turl = git@github.com:o/b.git
\tbranch = main
`

const plain = (value) => structuredClone(value)

const refuses = (text, message) => {
  assert.throws(() => parseGitmodules(text), (error) => {
    assert.ok(error instanceof LockfileError, error)
    assert.equal(error.message, message)
    return true
  })
}

const add = (lines) => `${BASE}${lines}\n`

describe('.gitmodules, as git reads it', () => {
  it('reads each submodule by name: its path, url and branch', () => {
    assert.deepEqual(plain(parseGitmodules(BASE)), {
      'lib/a': { path: 'lib/a', url: 'https://github.com/o/a', branch: undefined },
      'lib/b': { path: 'lib/b', url: 'git@github.com:o/b.git', branch: 'main' },
    })
  })

  it('reads a name other than the path, as git does', () => {
    const submodules = parseGitmodules('[submodule "registry"]\n\tpath = superchain-registry\n\turl = https://github.com/o/r\n')
    assert.deepEqual(plain(submodules), { registry: { path: 'superchain-registry', url: 'https://github.com/o/r', branch: undefined } })
  })

  it('reads what people write by hand, as git does', () => {
    const text = [
      '# dependencies', '[Submodule "lib/a"] ; the first', '    PATH=lib/a', '  Url = "https://github.com/o/a" # pinned',
      '', '[submodule  "lib/b"]path = lib/b', '\turl = git@github.com:o/b.git\\', '', '\tbranch = "ma"in',
      '[submodule "c"]', 'path = "lib/c d"', 'url = ssh://git@example.com:2222/c.git', 'shallow', 'ignore = dirty',
      'update = rebase', 'fetchRecurseSubmodules = on-demand',
    ].join('\r\n')
    assert.deepEqual(plain(parseGitmodules(text)), {
      'lib/a': { path: 'lib/a', url: 'https://github.com/o/a', branch: undefined },
      'lib/b': { path: 'lib/b', url: 'git@github.com:o/b.git', branch: 'main' },
      c: { path: 'lib/c d', url: 'ssh://git@example.com:2222/c.git', branch: undefined },
    })
  })

  it('reads URLs of every kind git fetches from a host', () => {
    for (const url of ['https://github.com/o/a.git', 'http://example.com/a', 'ssh://git@github.com/o/a', 'git://example.com/a', 'git+ssh://git@example.com/a', 'github.com:o/a', 'user@host.example:/srv/a.git', 'git@x:o/a', 'xy:o/a', 'git@[2001:db8::1]:o/a.git', '[2001:db8::1]:o/a', 'git@[::1]:a', 'ssh://git@[2001:db8::1]/o/a', 'git@corp_git:o/a.git', 'corp_git:o/a', 'git@a+b:o/a']) {
      assert.equal(parseGitmodules(`[submodule "a"]\n\tpath = a\n\turl = ${url}\n`).a.url, url)
    }
  })

  it('reads `.` for a branch, git\'s for the superproject\'s own', () => {
    assert.equal(parseGitmodules(add('[submodule "c"]\n\tpath = c\n\turl = https://x.example/c\n\tbranch = .')).c.branch, '.')
  })

  it('reads nothing, and a byte order mark git skips', () => {
    assert.deepEqual(plain(parseGitmodules('')), {})
    assert.deepEqual(plain(parseGitmodules('# none\n')), {})
    assert.deepEqual(Object.keys(parseGitmodules(`\uFEFF${BASE}`)), ['lib/a', 'lib/b'])
  })
})

describe('.gitmodules, of what git does not read alike', () => {
  it('refuses what git refuses, with its line', () => {
    refuses(`${BASE}[submodule`, 'a section with no closing "]" at line 8')
    refuses(add('[submodule "c"'), 'expected "]" after the subsection at line 8')
    refuses(add('[core'), 'a section header that runs past its line at line 8')
    refuses(add('[submodule c]'), 'expected a quoted subsection after the name of the section, found "c" at line 8')
    refuses(add('[]'), 'a section with no name at line 8')
    refuses(add('\turl = "x'), 'a value with no closing quote at line 8')
    refuses(add('\turl = a\\x'), '"\\\\x", an escape git does not read at line 8')
    refuses(add('\turl x'), 'expected "=" and a value after "url", found "x" at line 8')
    refuses(add('\t-url = x'), '"-", where git reads a key, a section or a comment at line 8')
    refuses(add('[submodule "c\nd"]'), 'a subsection with no closing quote at line 8')
  })

  it('refuses space within a value, which git reads one way before 2.45 and another since', () => {
    refuses(BASE.replace('url = https://github.com/o/a', 'url = https://github.com/o/a\tb'), '"\\t" within a value, which git reads as a space before 2.45 and as itself since at line 3')
  })

  it('refuses a key given twice, of which git config reads the last and git submodule the first', () => {
    refuses(add('\turl = https://x.example/b'), '["lib/b"].url: twice, of which git\'s submodule commands read the first and git config the last, at line 8')
    refuses(add('\tURL = https://x.example/b'), '["lib/b"].url: twice, of which git\'s submodule commands read the first and git config the last, at line 8')
    refuses(add('[submodule "lib/a"]\n\tbranch = main'), '["lib/a"]: a second section, at line 8, where git writes one')
  })

  it('refuses sections and keys but of submodules', () => {
    refuses(`\tpath = x\n${BASE}`, 'a key outside any section, at line 1')
    refuses(add('[core]\n\tbare = false'), 'a section of [core] where .gitmodules has [submodule "name"] alone, at line 8')
    refuses(add('[submodule.c]\n\tpath = c'), 'a section of the form [submodule.name], whose name git lowercases, where .gitmodules has [submodule "name"] alone, at line 8')
    refuses(add('[submodule]\n\tpath = c'), 'a section of [submodule] where .gitmodules has [submodule "name"] alone, at line 8')
    refuses(add('[remote "origin"]\n\turl = x'), 'a section of [remote "origin"] where .gitmodules has [submodule "name"] alone, at line 8')
    refuses(add('\tdepth = 1'), '["lib/b"]: unsupported field "depth"')
  })

  it('refuses a name git ignores the submodule for', () => {
    refuses(add('[submodule "../c"]\n\tpath = c\n\turl = https://x.example/c'), '["../c"]: a name git ignores the submodule for, empty or with a ".." in it')
    refuses(add('[submodule "a\\\\..\\\\c"]\n\tpath = c\n\turl = https://x.example/c'), '["a\\\\..\\\\c"]: a name git ignores the submodule for, empty or with a ".." in it')
    refuses(add('[submodule ""]\n\tpath = c\n\turl = https://x.example/c'), '[""]: a name git ignores the submodule for, empty or with a ".." in it')
  })

  it('refuses a value git does not read, or dies on', () => {
    refuses(add('[submodule "c"]\n\turl = https://x.example/c\n\tpath'), 'c.path: a key alone, where git expects a value')
    refuses(add('\tupdate = none'), '["lib/b"].update: "none" is not a value git reads here')
    refuses(add('\tupdate = !rm -rf x'), '["lib/b"].update: "!rm -rf x" is not a value git reads here')
    refuses(add('\tshallow = maybe'), '["lib/b"].shallow: "maybe" is not a value git reads here')
    refuses(add('\tignore = everything'), '["lib/b"].ignore: "everything" is not a value git reads here')
    refuses(add('\tfetchRecurseSubmodules = sometimes'), '["lib/b"].fetchrecursesubmodules: "sometimes" is not a value git reads here')
  })

  it('refuses a submodule without a path or a url', () => {
    refuses(add('[submodule "c"]\n\turl = https://x.example/c'), 'c.path: expected a path, without which git has no submodule')
    refuses(add('[submodule "c"]\n\tpath = c'), 'c.url: expected a url, without which git cannot clone the submodule')
  })

  it('refuses a path but below the repository\'s root, in normal form', () => {
    const at = (path) => add(`[submodule "c"]\n\tpath = ${path}\n\turl = https://x.example/c`)
    refuses(at('../c'), 'c.path: "../c" is outside the repository, where git writes no submodule')
    refuses(at('.'), 'c.path: "." is no submodule\'s path, but a directory it would be in')
    refuses(at('lib//c'), 'c.path: "lib//c" is not a relative path in normal form')
    refuses(at('lib/c/'), 'c.path: "lib/c/" is not a relative path in normal form')
    refuses(at('/c'), 'c.path: "/c" is not a relative path in normal form')
    refuses(at('.GIT/c'), 'c.path: ".GIT/c" is in a ".git", where git writes no submodule')
    refuses(at('-c'), 'c.path: "-c" starts with "-", which git ignores the path for')
    refuses(at('"lib/c\\n"'), 'c.path: "lib/c\\n" is not a relative path in normal form')
  })

  it('refuses two submodules at one path, or one inside another', () => {
    refuses(add('[submodule "c"]\n\tpath = lib/a\n\turl = https://x.example/c'), 'c.path: the path of the submodule "lib/a" too')
    refuses(add('[submodule "c"]\n\tpath = lib/a/lib/c\n\turl = https://x.example/c'), 'c.path: inside the submodule "lib/a", at "lib/a"')
  })

  it('refuses a URL but of a host', () => {
    const from = (url) => add(`[submodule "c"]\n\tpath = c\n\turl = ${url}`)
    refuses(from('../c.git'), 'c.url: "../c.git" is relative to the superproject\'s remote, which only a clone of it knows')
    refuses(from('./c'), 'c.url: "./c" is relative to the superproject\'s remote, which only a clone of it knows')
    for (const url of ['/srv/c.git', 'file:///srv/c.git', 'ext::sh -c x', 'fd::17', 'x::y', 'c', 'ftp://x.example/c', '[a/b]:c', 'git@[]:c', 'a/b:c']) {
      const shown = JSON.stringify(url.replaceAll('\\\\', '\\'))
      refuses(from(url.includes(' ') ? `"${url}"` : url), url.includes(' ') ? `c.url: ${shown} is not a repository URL` : `c.url: ${shown} is not a URL of a host that git fetches from: http(s), ssh, git, or user@host:path`)
    }
    refuses(from('"https://x.example/c "'), 'c.url: "https://x.example/c " is not a repository URL')
    for (const url of ['-uhttps://x.example/c', '-x:o/a']) refuses(from(url), `c.url: "${url}" starts with "-", which git ignores the url for`)
    for (const url of ['x:o/a', 'C:\\\\c', '1:/srv/a', '_:o/a', '\u00E9:o/a']) {
      refuses(from(url), `c.url: ${JSON.stringify(url.replaceAll('\\\\', '\\'))} is a path on a drive to git on Windows, and a host's to git elsewhere`)
    }
  })

  it('refuses a branch name git does not take', () => {
    refuses(add('[submodule "c"]\n\tpath = c\n\turl = https://x.example/c\n\tbranch = a..b'), 'c.branch: "a..b" is not a branch or tag name git takes')
    refuses(add('[submodule "c"]\n\tpath = c\n\turl = https://x.example/c\n\tbranch = ""'), 'c.branch: expected a non-empty string')
  })

  it('refuses what is not a string', () => {
    assert.throws(() => parseGitmodules(undefined), (error) => error instanceof TypeError && error.message === 'expected a string')
  })
})
