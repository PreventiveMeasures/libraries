import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { LockfileError } from '../../src/error.js'
import { sshOf } from '../../src/npm/hosted.js'
import { readSpec } from '../../src/npm/spec.js'
import { random } from '../random.js'
import { semver } from '../yarn1/semver.js'
import { C } from './base.js'
import { npa } from './reference.js'

// npm-package-arg, from the npm beside node, against the reader of specs
// here, over specs put together from pieces at random: whatever npm reads,
// this reads the same, or refuses for a reason of its own, which the
// pattern below lists; whatever npm refuses, this refuses too. The seed is
// fixed, so a failure names its spec and comes back on a rerun.

// Deep enough that no `..` climbs out of the filesystem's root.
const ROOT = resolve('/a/b/c/d/e/f/g/project')

// What is refused here that npm reads: a path out of every project, what a
// git spec has that npm passes over or that is not supported, `FILE:`, a
// name npm takes for an old package, and a local repository.
const OWN = /a path from the root, a drive or the home directory|a subdirectory of a repository|a git spec with ".*", which npm passes over|in another case otherwise|is not a package name|of a protocol npm does not read, "git\+file:"/u

const SPECS = [
  '', '*', '1.0.0', '^1.0.0', ' 1.0.0 ', 'v1.0.0', '>=1 <2', '1.x', 'latest', 'next-1', 'a b', 'a%20b',
  'npm:q@1', 'npm:@s/q@^1', 'npm:q', 'npm:npm:q@1', 'npm:file:x', 'npm:https://x.com/y.tgz', 'NPM:q@1', 'npm:Q~!@1', 'npm:x/y',
  'file:x', 'file:./x', 'file:../x', 'file:x/../../y', 'file:x//y/', 'file:x.tgz', 'file:/x', 'file:~/x', 'FILE:x', 'file://host/x', 'file:///x', 'file:x%20y',
  './x', '../x', '/x', '~/x', 'x/y/z', 'x.tgz', 'x.TAR', 'c:x', '.x', 'x#y/z',
  'https://example.com/x.tgz', 'http://example.com/x', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', 'ftp://x', 'workspace:*', 'link:x', 'catalog:',
  'git://example.com/x.git', 'git+https://example.com/x.git#v1', 'git+ssh://git@example.com:x/y.git#abc', 'git+ssh://git@example.com:22/x.git', 'git+file:///x', 'git+ftp://x.com/y',
  'git+https://example.com/x.git#semver:^1', 'git+https://example.com/x.git#semver:^1::v1', 'git+https://example.com/x.git#a::b', 'git+https://example.com/x.git#semver:%E0',
  'user/repo', 'user/repo#v1', 'user/repo/', 'github:user/repo', 'gitlab:group/sub/repo', 'bitbucket:u/r', 'gist:abc', 'gist:u/abc', 'sourcehut:~u/r',
  'https://github.com/user/repo', 'https://github.com/user/repo.git#semver:^1', 'https://www.github.com/user/repo', 'https://github.com/user/repo/tree/v1',
  'https://github.com/user/repo/archive/v1.tar.gz', 'https://gitlab.com/g/r/-/archive/x.tar.gz', 'https://bitbucket.org/u/r/get/v1.tar.gz', 'https://gist.github.com/u/abc',
  'git@github.com:user/repo.git', 'git@github.com:user/repo.git#main', `git+ssh://git@github.com/user/repo.git#${C}`, `git+https://github.com/user/repo.git#${C}`,
  'git://github.com/user/repo', 'ssh://git@github.com/user/repo', 'git+https://user:pass@github.com/user/repo.git',
  'github:user/repo#path:sub', 'github:user/repo#semver:^1::path:x', 'github:user/repo#a::b', 'github:user/repo#foo:bar', 'github:u/r#%E0', 'github:u%E0/r',
]

const PREFIXES = ['', '', 'file:', 'npm:', 'git+', 'git+https://', 'github:', 'https://', 'git@', '@s/', './', '../', 'gitlab:', 'git://', 'ssh://']
const MIDDLES = ['a', 'a/b', 'a/b/c', 'a.git', 'a.tgz', 'x@1', 'host.com:a/b', 'github.com/a/b', 'github.com:a/b', 'gitlab.com/a/b/c', '..', '.', '', 'a b', '~a', 'A/B']
const SUFFIXES = ['', '', '#v1', '#semver:^1', `#${C}`, '#path:x', '::', '@1.0.0', '.git', ' ', '#', '/']

function compare(name, spec, from) {
  let theirs
  let refusal
  try {
    theirs = npa.resolve(name, spec || '*', resolve(ROOT, from))
  } catch (error) {
    refusal = error
  }
  let ours
  try {
    ours = readSpec(name, spec, from, semver)
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    if (refusal === undefined) assert.match(error.message, OWN, `npm reads ${JSON.stringify(spec)} from ${from} as ${theirs.type}`)
    return false
  }
  assert.equal(refusal, undefined, `npm refuses ${JSON.stringify(spec)}, read here as ${ours.type}: ${refusal?.message}`)
  const what = `${JSON.stringify(spec)} from ${from}`
  switch (theirs.type) {
    case 'version':
    case 'range':
    case 'tag':
      assert.deepEqual([ours.type, ours.kind, ours.name, ours.fetchSpec], ['registry', theirs.type, theirs.name, theirs.fetchSpec], what)
      break
    case 'alias':
      assert.deepEqual([ours.type, ours.sub.kind, ours.sub.name, ours.sub.fetchSpec], ['alias', theirs.subSpec.type, theirs.subSpec.name, theirs.subSpec.fetchSpec], what)
      break
    case 'file':
    case 'directory':
      assert.deepEqual([ours.type, ours.path], [theirs.type, relative(ROOT, theirs.fetchSpec) || '.'], what)
      break
    case 'remote':
      assert.deepEqual([ours.type, ours.url], ['remote', theirs.fetchSpec], what)
      break
    default:
      assert.equal(ours.type, 'git', what)
      assert.equal(ours.hosted === undefined, theirs.hosted === undefined, what)
      if (theirs.hosted === undefined) assert.equal(ours.fetchSpec, theirs.fetchSpec, what)
      else assert.deepEqual([sshOf(ours.hosted, false), sshOf(ours.hosted, true)], [theirs.hosted.ssh({ noCommittish: true }), theirs.hosted.ssh({ noCommittish: false })], what)
      assert.deepEqual([ours.committish, ours.range], [theirs.gitCommittish ?? null, theirs.gitRange ?? null], what)
  }
  return true
}

describe('whatever npm reads a spec as, it is read as here', () => {
  it('the specs above, from the project and from deeper and further', () => {
    for (const from of ['.', 'node_modules/a', '../o']) {
      for (const name of ['a', '@s/a']) for (const spec of SPECS) compare(name, spec, from)
    }
  })

  it('specs put together from pieces', () => {
    const { next, pick } = random(0x5BEC)
    let read = 0
    for (let i = 0; i < 20_000; i++) {
      const spec = `${pick(PREFIXES)}${pick(MIDDLES)}${next() < 0.3 ? pick(MIDDLES) : ''}${pick(SUFFIXES)}`
      if (compare(pick(['a', '@s/a', 'A']), spec, pick(['.', 'node_modules/a'])) ) read++
    }
    assert.ok(read > 8000, `only ${read} specs were read`)
  })
})
