// git itself, in a repository of its own, for the recordings and for the
// live tests: two trees in, what `git diff` says of them out. Each tree goes
// in by fast-import as a commit holding exactly its files, so no working
// tree is ever written and no filesystem's idea of names, links or modes
// comes into it; a patch is checked by applying it to the index alone.
//
// A tree here is a plain object from path to what is there: text for a file
// of mode 644, or { data, mode } (data text or bytes, mode 0o644 or 0o755,
// all git keeps), or { link } for a symlink.

import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// The git on the PATH, as [major, minor], or null without one.
export function gitVersion() {
  try {
    const out = execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
    const m = /^git version (\d+)\.(\d+)/u.exec(out)
    return m ? [Number(m[1]), Number(m[2])] : null
  } catch {
    return null
  }
}

// A tree as entries for compareTrees.
export const entriesOf = (tree) => Object.entries(tree).map(([name, spec]) => {
  if (typeof spec === 'string') return { name, data: spec }
  if ('link' in spec) return { name, type: 'symlink', linkname: spec.link }
  return { name, data: spec.data, mode: spec.mode ?? 0o644 }
})

// A path as fast-import reads one quoted: every byte past printable ASCII,
// and the quote and backslash, in octal.
const fastImportPath = (path) => `"${[...Buffer.from(path)].map((byte) => (byte >= 0x20 && byte < 0x7F && byte !== 0x22 && byte !== 0x5C ? String.fromCodePoint(byte) : `\\${byte.toString(8).padStart(3, '0')}`)).join('')}"`

function commitStream(ref, tree) {
  const parts = [`commit ${ref}\ncommitter c <c@c> 0 +0000\ndata 0\ndeleteall\n`]
  for (const [path, spec] of Object.entries(tree)) {
    const link = typeof spec === 'object' && 'link' in spec
    const mode = link ? '120000' : (typeof spec === 'object' && spec.mode === 0o755 ? '100755' : '100644')
    const data = Buffer.from(link ? spec.link : typeof spec === 'string' ? spec : spec.data)
    parts.push(`M ${mode} inline ${fastImportPath(path)}\ndata ${data.length}\n`, data, '\n')
  }
  return parts
}

// The options compareTrees takes, as git diff's.
export function diffFlags({ renames = true, renameLimit } = {}) {
  const flags = [renames === false ? '--no-renames' : renames === true ? '-M' : `-M${renames}%`]
  if (renameLimit !== undefined) flags.push(`-l${renameLimit}`)
  return flags
}

// A repository with the two trees as `a` and `b`; `diff` runs git diff from
// one to the other, and `applies` says whether a patch carries `a` to `b`.
export function repository(a, b) {
  const dir = mkdtempSync(join(tmpdir(), 'compare-git-'))
  const config = join(dir, 'gitconfig')
  writeFileSync(config, '')
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, HOME: dir, LC_ALL: 'C',
    GIT_DIR: join(dir, 'repo.git'), GIT_INDEX_FILE: join(dir, 'index'), GIT_WORK_TREE: join(dir, 'work'),
  }
  const git = (args, input) => execFileSync('git', args, { env, input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] })
  git(['init', '-q'])
  const stream = [...commitStream('refs/heads/a', a), ...commitStream('refs/heads/b', b)]
  git(['fast-import', '--quiet'], Buffer.concat(stream.map((part) => Buffer.from(part))))
  return {
    diff: (args) => git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...args, 'a', 'b']).toString('utf8'),
    applies(patch) {
      git(['read-tree', 'a'])
      // git apply takes no patch at all for an error.
      if (patch !== '') git(['apply', '--cached', '-'], patch)
      return git(['write-tree']).toString().trim() === git(['rev-parse', 'b^{tree}']).toString().trim()
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// What git diff --raw -z says of each path: its status with any score, the
// two modes, and the path or the two paths.
export function readRaw(text) {
  const fields = text.split('\0')
  const out = []
  for (let i = 0; i < fields.length - 1;) {
    const [oldMode, newMode, , , status] = fields[i++].slice(1).split(' ')
    const paths = status.startsWith('R') || status.startsWith('C') ? [fields[i++], fields[i++]] : [fields[i++]]
    out.push({ status, oldMode, newMode, paths })
  }
  return out
}

// What git diff --numstat -z counts for each path: [insertions, deletions],
// '-' for binary, and the path or the two paths.
export function readNumstat(text) {
  const fields = text.split('\0')
  const out = []
  for (let i = 0; i < fields.length - 1;) {
    // A path may hold a tab itself; the counts never do.
    const [, insertions, deletions, path] = /^([^\t]*)\t([^\t]*)\t(.*)$/su.exec(fields[i++])
    out.push({ insertions, deletions, paths: path === '' ? [fields[i++], fields[i++]] : [path] })
  }
  return out
}

// Our changes in those two shapes.
const LETTER = { 'added': 'A', 'deleted': 'D', 'modified': 'M', 'renamed': 'R', 'type-changed': 'T' }
const gitMode = (file) => (file === null ? '000000' : file.type === 'symlink' ? '120000' : (0o100000 | file.mode).toString(8))
const pathsOf = (change) => (change.status === 'renamed' ? [change.old.path, change.new.path] : [(change.new ?? change.old).path])

export const rawOf = (changes) => changes.map((change) => ({
  status: LETTER[change.status] + (change.status === 'renamed' ? String(change.similarity).padStart(3, '0') : ''),
  oldMode: gitMode(change.old), newMode: gitMode(change.new), paths: pathsOf(change),
}))

export const numstatOf = (changes) => changes.map((change) => ({
  insertions: change.binary ? '-' : String(change.insertions), deletions: change.binary ? '-' : String(change.deletions), paths: pathsOf(change),
}))

// A patch less the `index` lines, which git writes and compare does not.
export const withoutIndex = (patch) => patch.replace(/^index [\da-f]+\.\.[\da-f]+(?: \d+)?\n/gmu, '')
