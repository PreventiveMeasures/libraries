// gitTreeOfArchive against `git archive` itself: trees of files of every
// kind of line end, executables, symlinks and submodules, with
// .gitattributes at the top and beneath, of patterns and attributes drawn
// at random, export-ignore and eol among them, each archive held to its
// tree; and archives of the same commits with more left out, by a global
// attributes file the tree does not hold, each refused.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'

import { gitTreeOfArchive } from '../src/exported.js'

const hasGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'upstream-exported-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })

let seed = 1
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}
const pick = (items) => items[Math.floor(random() * items.length)]

const NAMES = ['a', 'b', 'ab', 'a.php', 'b.php', 'Tests', 'tests', 'doc', 'x.md', '.github', 'c d', 'é', '[x]', 'a*b', '#h', '!n']
const SEGMENTS = ['**', '**', '*', '*.php', 'a*', '*a', '*b.php', '?', '[ab]', 'a', 'b', 'tests', '[!a]*', '\\*', 'a**', '**b', '[[:lower:]]*']
// Names and globs between slashes, as .gitattributes compose them.
const composed = () => `${pick(['', '/'])}${Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(SEGMENTS)).join('/')}${pick(['', '', '/'])}`
const pattern = () => {
  const name = pick(NAMES)
  if (random() < 0.4) return composed()
  return pick([
    name, `/${name}`, `${name}/`, `/${name}/`, '*', '*.php', '*.md', '**', '**/a', 'a/**', 'a/**/b', '/*', '*/', '?', 'a?', '[ab]', '[!a]*', '[a-c]*',
    '[[:alpha:]]*', `${pick(NAMES)}/${name}`, `/${pick(NAMES)}/${name}`, `${name}*`, `*${name}`, `\\${name}`, `"${name}"`, '"a\\142"', '**/', `**/${name}/`,
    `/**/${name}`, '[]', '[a', 'a\\', 'x/*/y', '*/*', '.git*', '/.git*', '[^a]', '*[!/]', 'a**', '**b', '/a/**/', '[[:space:]]', '[[:bogus:]]', '"[attr]q"',
  ])
}
const STATES = [
  'export-ignore', 'export-ignore', '-export-ignore', '!export-ignore', 'export-ignore=x', 'm', 'binary', 'text', 'export-ignore -export-ignore', '-export-ignore export-ignore', 'builtin_x', 'export-ignore bad*name', 'n',
  'text eol=crlf', 'eol=crlf', 'text=auto eol=crlf', '-text eol=crlf', 'crlf', 'crlf eol=crlf', 'crlf=input eol=crlf', 'text=input', 'eol=lf', '!eol', 'text eol=crlf -text',
]
// Line ends of every kind git tells apart as it writes them CRLF.
const CONTENTS = ['\n', 'a\nb\n', 'a\r\nb\n', 'a\rb\n', 'bin\0\n', '', 'x', 'a\n\u001A', '\u007F\u0001\u0002\n']
const MACROS = ['[attr]m export-ignore', '[attr]m -export-ignore', '[attr]n m', '[attr]binary export-ignore', '[attr]m n', '"[attr]m" export-ignore', '[attr]m text eol=crlf']
function attributes(top) {
  const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, () => (top && random() < 0.15 ? pick(MACROS) : `${pick(['', ' ', '\t'])}${pattern()} ${pick(STATES)}${pick(['', '\r', ' '])}`))
  if (random() < 0.1) lines.push('# comment')
  if (random() < 0.05) lines.push(`${'x'.repeat(2050)} export-ignore`)
  return `${lines.join('\n')}${random() < 0.5 ? '\n' : ''}`
}

// A repository at `dir` of a tree drawn at random, committed: the commit
// and its tree.
function commitTree(dir) {
  git(dir, ['init', '-q'])
  const made = new Set()
  const submodules = []
  const fill = (base, depth) => {
    for (let i = 0; i < 1 + Math.floor(random() * 5); i++) {
      const path = base ? `${base}/${pick(NAMES)}` : pick(NAMES)
      if (made.has(path)) continue
      made.add(path)
      const kind = random()
      if (depth < 3 && kind < 0.35) {
        mkdirSync(join(dir, path))
        fill(path, depth + 1)
        if (random() < 0.4) writeFileSync(join(dir, path, '.gitattributes'), attributes(false))
      } else if (kind < 0.42) {
        symlinkSync(pick(['a', '../x', 'a.php']), join(dir, path))
      } else if (kind < 0.47) {
        submodules.push(path)
      } else {
        writeFileSync(join(dir, path), `${path}${pick(CONTENTS)}`)
        if (random() < 0.2) chmodSync(join(dir, path), 0o755)
      }
    }
  }
  fill('', 0)
  writeFileSync(join(dir, '.gitattributes'), attributes(true))
  git(dir, ['add', '-A'])
  for (const path of submodules) git(dir, ['update-index', '--add', '--cacheinfo', `160000,3f786850e387550fdab836ed7e6dc881de23001b,${path}`])
  git(dir, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qm', 'c', '--allow-empty'])
  return [git(dir, ['rev-parse', 'HEAD']).toString().trim(), git(dir, ['rev-parse', 'HEAD^{tree}']).toString().trim()]
}

// GitHub's listing of a tree, as the trees API gives it.
const listing = (dir) => (sha) => git(dir, ['ls-tree', '-z', sha]).toString('latin1').split('\0').filter(Boolean).map((line) => {
  const [meta, path] = line.split('\t')
  const [mode, type, id] = meta.split(' ')
  return { path: Buffer.from(path, 'latin1').toString('utf8'), mode, type, sha: id }
})

describe('gitTreeOfArchive against git archive', { skip: !hasGit() && 'no git' }, () => {
  it('holds each archive to its tree, and refuses each that leaves out more', async () => {
    let omitted = 0
    let refused = 0
    for (let i = 0; i < 40; i++) {
      const dir = join(ROOT, String(i))
      mkdirSync(dir)
      const [commit, tree] = commitTree(dir)
      const archive = (...config) => git(dir, [...config, 'archive', '--format=tar', `--prefix=acme-app-${commit.slice(0, 7)}/`, commit])
      const objects = { expected: tree, commit, list: listing(dir), blob: (sha) => new Uint8Array(git(dir, ['cat-file', 'blob', sha])) }
      const tar = archive()
      assert.equal(await gitTreeOfArchive(gzipSync(tar), objects), tree, `tree ${i}`)
      const archived = execFileSync('tar', ['-t'], { input: tar }).toString().split('\n').filter(Boolean).length - 1
      if (archived < git(dir, ['ls-tree', '-r', '-t', '-z', 'HEAD']).toString().split('\0').filter(Boolean).length) omitted++
      writeFileSync(join(dir, '..', `global-${i}`), `${pattern()} export-ignore\n${pattern()} export-ignore\n`)
      const other = archive('-c', `core.attributesFile=${join(dir, '..', `global-${i}`)}`)
      if (!other.equals(tar)) {
        assert.notEqual(await gitTreeOfArchive(gzipSync(other), objects), tree, `tree ${i}, with more left out`)
        refused++
      }
    }
    assert.ok(omitted > 5 && refused > 5, `${omitted} archives left something out, ${refused} were refused`)
  })
})
