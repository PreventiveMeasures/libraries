// A patch as `pnpm patch-commit` writes one: a git diff, with a
// `diff --git a/<path> b/<path>` header per file, paths relative to the
// package's directory, and unified hunks. A file is changed, created from
// /dev/null or deleted; a rename, a copy, a mode change, a binary patch, or
// anything else between one file's hunks and the next header, is refused.
//
// A hunk applies where it says and nowhere else, its context and removed
// lines the same, byte for byte, as the file's. pnpm (@pnpm/patch-package)
// would also look up to twenty lines away and compare lines with trailing
// whitespace dropped; a patch that needs either is refused, so one applied
// here leaves the file as pnpm would. So is a hunk that inserts after a
// line with no context, which pnpm puts a line early.

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

// The `---`/`+++` pair may be left out where the file has no hunks.
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

// parseDiff passes over what it does not read, so every line is checked to
// be one a hunk holds, and every one of those to be in a hunk.
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
  return text.split(/\n(?=diff --git )/u).map((section) => {
    const lines = section.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const path = checkPath(pathOf(lines[0]), `${where}: ${quote(lines[0])}`)
    const here = `${where}: ${quote(path)}`
    const { change, mode, body } = readHeader(lines, path, here)
    return { path, change, mode, ...readHunks(lines.slice(body), here), where: here }
  })
}

// Each hunk is held to the lines it names before any is applied.
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

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

function textOf(file, where) {
  try {
    return decoder.decode(file.data)
  } catch {
    throw new DeptreeError('changes a file that is not UTF-8', where)
  }
}

function bytesOf(text, where) {
  if (!text.isWellFormed()) throw new DeptreeError('makes a file that is not well-formed text', where)
  return encoder.encode(text)
}

const parentsOf = (path) => path.split('/').slice(0, -1).map((_, index, names) => names.slice(0, index + 1).join('/'))

// `files` maps each path in the package to `{ data, mode }`, or to
// `{ directory: true }`. A changed file keeps its mode, and a deleted one
// leaves its directory, empty or not, as pnpm does. A created file has its
// header's mode, or `createdMode` where given, as pnpm 12 writes one plain.
// Hands back a new Map.
export function applyPatch(files, patch, { createdMode } = {}) {
  const next = new Map(files)
  for (const file of patch) {
    const current = next.get(file.path)
    if (file.change === 'create') {
      const taken = current !== undefined || [...next.keys()].some((path) => path.startsWith(`${file.path}/`)) || parentsOf(file.path).some((dir) => next.get(dir)?.data !== undefined)
      if (taken) throw new DeptreeError('creates a file that is there', file.where)
      next.set(file.path, { data: bytesOf(applyTo('', file), file.where), mode: createdMode ?? file.mode })
      continue
    }
    if (current?.data === undefined) throw new DeptreeError('changes a file that is not there', file.where)
    // A deletion git writes with --irreversible-delete has no hunks, and
    // says nothing of what it deletes.
    const result = file.change === 'delete' && file.hunks.length === 0 ? '' : applyTo(textOf(current, file.where), file)
    if (file.change === 'delete') {
      if (result !== '') throw new DeptreeError('deletes a file it does not remove all of', file.where)
      next.delete(file.path)
      for (const dir of parentsOf(file.path)) if (!next.has(dir)) next.set(dir, { directory: true })
    } else {
      next.set(file.path, { data: bytesOf(result, file.where), mode: current.mode })
    }
  }
  return next
}
