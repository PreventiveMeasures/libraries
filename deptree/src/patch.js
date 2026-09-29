// A patch applied to a package's files in a Vfs, as `pnpm patch-commit`
// writes one: a git diff, a `diff --git a/<path> b/<path>` header for each
// file, and unified hunks, a path relative to the package's directory. A
// file is changed, created from /dev/null or deleted; a rename, a copy, a
// change of mode and a binary patch are refused, as is anything else
// between one file's hunks and the next header.
//
// A hunk applies where it says and nowhere else, every line of context and
// every line it removes the same, byte for byte, as the file has there.
// pnpm (@pnpm/patch-package) would also look up to twenty lines away and
// compare lines with their trailing whitespace dropped; a patch that needs
// either is refused here, so a patch applied here leaves the file as pnpm
// would. So is a hunk that inserts after a line and keeps no context,
// which pnpm puts a line early.

import { applyChangeSet, parseDiff } from '@preventive/diff'
import { DeptreeError, quote } from './error.js'

const HEADER = 'diff --git a/'
const MODE = /^(?:new|deleted) file mode (100644|100755)$/u
const INDEX = /^index [\da-f]+\.\.[\da-f]+(?: 100644| 100755)?$/u
const HUNK_LINE = /^(?:@@ |[ +\\-]|$)/u

// The path a header names on both sides, or undefined where the two differ.
function pathOf(header) {
  const rest = header.slice(HEADER.length)
  const path = rest.slice(0, (rest.length - 3) / 2)
  return rest === `${path} b/${path}` ? path : undefined
}

function checkPath(path, where) {
  if (path === undefined || path.startsWith('"') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new DeptreeError('expected a header naming one relative path on both sides', where)
  }
  return path
}

// One file's header: what happens to the file, and the `---`/`+++` pair
// naming it, which a patch without hunks may leave out.
function readHeader(lines, path, where) {
  let change = 'modify'
  let mode = 0o644
  let i = 1
  for (; i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('@@ '); i++) {
    const m = MODE.exec(lines[i])
    if (m !== null && change === 'modify') {
      change = lines[i].startsWith('new') ? 'create' : 'delete'
      mode = m[1] === '100755' ? 0o755 : 0o644
    } else if (!INDEX.test(lines[i])) throw new DeptreeError(`${quote(lines[i])} is not supported`, where)
  }
  if (lines[i]?.startsWith('--- ')) {
    const old = change === 'create' ? '/dev/null' : `a/${path}`
    const fresh = change === 'delete' ? '/dev/null' : `b/${path}`
    if (lines[i] !== `--- ${old}` || lines[i + 1] !== `+++ ${fresh}`) throw new DeptreeError(`expected "--- ${old}" and "+++ ${fresh}"`, where)
    i += 2
  }
  return { change, mode, body: i }
}

// The hunks of one file, each line of them read: parseDiff passes over
// what it does not read, so every line has to be one a hunk holds, and
// every one of those in a hunk.
function readHunks(lines, where) {
  if (lines.length === 0) return { hunks: [], blocks: [] }
  if (!lines.every((line) => HUNK_LINE.test(line))) throw new DeptreeError('expected only hunks after the header', where)
  const files = parseDiff(`${lines.join('\n')}\n`)
  const hunks = files.flatMap((file) => file.hunks)
  const heads = lines.filter((line) => line.startsWith('@@ ')).length
  const held = lines.filter((line) => !line.startsWith('@@ ') && !line.startsWith('\\')).length
  if (files.length !== 1 || files[0].format !== 'unified' || hunks.length !== heads || hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) !== held) {
    throw new DeptreeError('expected unified hunks and nothing between them', where)
  }
  return { hunks, blocks: files[0].blocks }
}

export function parsePatch(text, where) {
  if (text.includes('\r')) throw new DeptreeError('a carriage return is not supported', where)
  if (!text.startsWith(HEADER)) throw new DeptreeError(`expected ${quote(HEADER)} first`, where)
  const sections = text.split(/\n(?=diff --git )/u)
  return sections.map((section) => {
    const lines = section.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const path = checkPath(pathOf(lines[0]), `${where}: ${quote(lines[0])}`)
    const here = `${where}: ${quote(path)}`
    const { change, mode, body } = readHeader(lines, path, here)
    return { path, change, mode, ...readHunks(lines.slice(body), here), where: here }
  })
}

// Holds each hunk to the lines it names in `text`, and hands back what
// applying them makes of it.
function applyTo(text, { hunks, blocks, where }) {
  const records = text.split(/(?<=\n)/u)
  let end = 0
  for (const hunk of hunks) {
    const kept = hunk.lines.filter((line) => line.tag !== '+')
    if (hunk.oldStart < end || (kept.length === 0 && hunk.oldStart !== 0)) throw new DeptreeError('hunks out of order, or one with no context', where)
    kept.forEach((line, index) => {
      if (records[hunk.oldStart + index] !== line.text) throw new DeptreeError(`the hunk at line ${hunk.oldStart + 1} does not apply`, where)
    })
    end = hunk.oldStart + kept.length
  }
  return applyChangeSet(text, blocks)
}

// Applies a parsed patch under `dir`, which holds a package's files and
// nothing that links out of it.
export function applyPatch(vfs, dir, files) {
  for (const file of files) {
    const path = `${dir}/${file.path}`
    const exists = vfs.isFile(path)
    if (file.change === 'create') {
      if (exists || vfs.isSymlink(path) || vfs.isDirectory(path)) throw new DeptreeError('creates a file that is there', file.where)
      vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      vfs.writeFile(path, applyTo('', file), { mode: file.mode })
      continue
    }
    if (!exists) throw new DeptreeError('changes a file that is not there', file.where)
    // A deletion git writes with --irreversible-delete has no hunks, and
    // says nothing of what it deletes.
    const result = file.change === 'delete' && file.hunks.length === 0 ? '' : applyTo(vfs.readText(path), file)
    if (file.change !== 'delete') vfs.writeFile(path, result)
    else if (result === '') vfs.rm(path)
    else throw new DeptreeError('deletes a file it does not remove all of', file.where)
  }
}
