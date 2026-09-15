// The other direction: a diff read back into what it says. The three styles
// this package prints are the three it reads, and a file's worth of diff
// comes back as the hunks it is written in and the change set they describe.
//
// What a hunk says is kept as it is written — every line with its tag, `-`
// and `+` and the context between them — because that is what a patch
// carries and what applying one to a file that has moved on would need. The
// change set is derived from it, and is the same shape `diffLines` returns,
// with each block also holding the lines it removes and inserts, since a
// diff is the only place those exist.

import { splitRecords } from './compare.js'

export class PatchError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = 'PatchError'
    this.line = line
  }
}

const UNIFIED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*?))?\n?$/u
const CONTEXT_FENCE = /^\*{15,}(?: (.*?))?\n?$/u
const CONTEXT_OLD = /^\*{3} (\d+)(?:,(\d+))? \*{4}\n?$/u
const CONTEXT_NEW = /^--- (\d+)(?:,(\d+))? ----\n?$/u
const NORMAL_COMMAND = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?[ \t]*\r?\n?$/u

// A range prints its start as the line before it when it covers nothing,
// which `,0` marks; otherwise as the first line it covers, counting from one.
const rangeStart = (start, count) => (count === 0 ? Number(start) : Number(start) - 1)

// `\ No newline at end of file` is not a line of the hunk: it takes the
// terminator off the line above it.
const isNoNewline = (line) => line !== undefined && line.startsWith('\\')
const chop = (text) => text.replace(/\n$/u, '')

export function parseDiff(text) {
  const lines = splitRecords(text)
  const files = []
  let names = { old: null, new: null }
  let starred = false
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    // A file's name reaches its hunks from the header above them. `***` and
    // `---` name a file only as a pair above a context diff, never as the
    // range lines inside one.
    const header = fileHeader(line, starred)
    starred = line.startsWith('***************') ? false : line.startsWith('*** ')
    if (header) {
      names = header.names ?? { ...names, [header.slot]: header.name }
      i++
      continue
    }
    const style = UNIFIED_HUNK.test(line) ? 'unified' : CONTEXT_FENCE.test(line) ? 'context' : NORMAL_COMMAND.test(line) ? 'normal' : null
    if (style === null) { i++; continue }
    const hunks = []
    const read = READERS[style]
    for (let hunk = read(lines, i); hunk !== null; hunk = read(lines, i)) {
      hunks.push(hunk.hunk)
      i = hunk.next
      if (i >= lines.length || fileHeader(lines[i], false)) break
    }
    files.push({ old: names.old, new: names.new, style, hunks, blocks: blocksOf(hunks) })
    names = { old: null, new: null }
  }
  return files
}

// `--- a`/`+++ b` above a unified diff, `*** a`/`--- b` above a context one,
// and the `diff --git a/x b/y` line some patches carry instead.
function fileHeader(line, starred) {
  // A git header names both files at once, and names them the way the
  // `---`/`+++` pair below it would, prefixes and all: stripping those is
  // -p's job and -p is the applier's, not the reader's.
  const git = /^diff --git (\S+) (\S+)\n?$/u.exec(line)
  if (git) return { names: { old: git[1], new: git[2] } }
  if (CONTEXT_OLD.test(line) || CONTEXT_NEW.test(line)) return null
  const m = /^(\*\*\* |--- |\+\+\+ )(.*?)(?:\t.*)?\n?$/u.exec(line)
  if (!m) return null
  if (m[1] === '--- ') return { slot: starred ? 'new' : 'old', name: m[2] }
  return { slot: m[1] === '*** ' ? 'old' : 'new', name: m[2] }
}

// The runs of `-` and `+` at one point in a hunk are one block, positioned
// by the hunk's own starting lines.
function blocksOf(hunks) {
  const blocks = []
  for (const hunk of hunks) {
    let a = hunk.oldStart, b = hunk.newStart, block = null
    const close = () => { if (block) { blocks.push(block); a = block.a1; b = block.b1; block = null } }
    for (const { tag, text } of hunk.lines) {
      if (tag === ' ') { close(); a++; b++; continue }
      if (tag === '-' && block?.insert.length) close()
      block ??= { a0: a, a1: a, b0: b, b1: b, remove: [], insert: [] }
      if (tag === '-') { block.a1++; block.remove.push(text) }
      else { block.b1++; block.insert.push(text) }
    }
    close()
  }
  return blocks
}

function parseUnified(lines, at) {
  const head = UNIFIED_HUNK.exec(lines[at] ?? '')
  if (!head) return null
  const oldCount = head[2] === undefined ? 1 : Number(head[2])
  const newCount = head[4] === undefined ? 1 : Number(head[4])
  const hunk = { oldStart: rangeStart(head[1], oldCount), newStart: rangeStart(head[3], newCount), fn: head[5] || null, lines: [] }
  let fresh = 0, i = at + 1, old = 0
  for (; old < oldCount || fresh < newCount; i++) {
    const raw = lines[i]
    if (raw === undefined) throw new PatchError('the patch ends inside a hunk', i)
    // A bare newline is a context line whose text is empty.
    const tag = raw === '\n' ? ' ' : raw[0]
    if (tag !== ' ' && tag !== '-' && tag !== '+') throw new PatchError(`a hunk line begins with ${JSON.stringify(tag)}`, i)
    let text = raw === '\n' ? raw : raw.slice(1)
    if (isNoNewline(lines[i + 1])) { text = chop(text); i++ }
    if (tag !== '+') old++
    if (tag !== '-') fresh++
    if (old > oldCount || fresh > newCount) throw new PatchError('a hunk has more lines than its header says', i)
    hunk.lines.push({ tag, text })
  }
  return { hunk, next: i }
}

function parseNormal(lines, at) {
  const head = NORMAL_COMMAND.exec(lines[at] ?? '')
  if (!head) return null
  const [, s1, e1, letter, s2, e2] = head
  const oldCount = letter === 'a' ? 0 : Number(e1 ?? s1) - Number(s1) + 1
  const newCount = letter === 'd' ? 0 : Number(e2 ?? s2) - Number(s2) + 1
  if (oldCount < 0 || newCount < 0) throw new PatchError('a change command counts backwards', at)
  const hunk = { oldStart: letter === 'a' ? Number(s1) : Number(s1) - 1, newStart: letter === 'd' ? Number(s2) : Number(s2) - 1, fn: null, lines: [] }
  let i = at + 1
  const side = (count, mark, tag) => {
    for (let n = 0; n < count; n++, i++) {
      const raw = lines[i]
      if (raw === undefined) throw new PatchError('the patch ends inside a hunk', i)
      if (raw[0] !== mark) throw new PatchError(`${JSON.stringify(mark)} expected`, i)
      let text = raw.slice(2)
      if (isNoNewline(lines[i + 1])) { text = chop(text); i++ }
      hunk.lines.push({ tag, text })
    }
  }
  side(oldCount, '<', '-')
  if (letter === 'c') {
    if (lines[i] !== '---\n') throw new PatchError("'---' expected", i)
    i++
  }
  side(newCount, '>', '+')
  return { hunk, next: i }
}

// A context hunk lists each side separately, and leaves a side out entirely
// when it has no changes of its own — the lines it would have shown are the
// other side's context lines.
function parseContext(lines, at) {
  const fence = CONTEXT_FENCE.exec(lines[at] ?? '')
  if (!fence) return null
  const oldHead = CONTEXT_OLD.exec(lines[at + 1] ?? '')
  if (!oldHead) throw new PatchError("'*** ' range expected", at + 1)
  let i = at + 2
  const old = readSide(lines, i, CONTEXT_NEW, '-')
  i = old.next
  const newHead = CONTEXT_NEW.exec(lines[i] ?? '')
  if (!newHead) throw new PatchError("'--- ' range expected", i)
  const fresh = readSide(lines, i + 1, null, '+')
  // A side with no changes of its own prints its range line and nothing
  // else, so what it covers is read off the other side: the lines it would
  // have shown are that side's context lines.
  const lhs = old.lines.length === 0 ? fresh.lines.filter((l) => l.tag === ' ') : old.lines
  const rhs = fresh.lines.length === 0 ? old.lines.filter((l) => l.tag === ' ') : fresh.lines
  const oldStart = contextStart(oldHead, lhs.length)
  const newStart = contextStart(newHead, rhs.length)
  return { hunk: { oldStart, newStart, fn: fence[1] || null, lines: interleave(lhs, rhs) }, next: fresh.next }
}

// `*** 3,5 ****` is first and last inclusive and `*** 3 ****` one line, but
// a range covering nothing prints the line before it in that same bare form
// — so which one it is comes from how many lines the hunk holds, not from
// the range line, which cannot say.
const contextStart = (head, count) => (count === 0 ? Number(head[1]) : Number(head[1]) - 1)

function readSide(lines, at, stop, tag) {
  const out = []
  let i = at
  for (; i < lines.length; i++) {
    const raw = lines[i]
    if (stop && stop.test(raw)) break
    if (CONTEXT_FENCE.test(raw) || CONTEXT_OLD.test(raw) || (!stop && CONTEXT_NEW.test(raw))) break
    if (isNoNewline(raw)) { out[out.length - 1].text = chop(out.at(-1).text); continue }
    const mark = raw === '\n' ? ' ' : raw[0]
    if (mark !== ' ' && mark !== '!' && mark !== '-' && mark !== '+') break
    out.push({ tag: mark === ' ' ? ' ' : tag, text: raw === '\n' ? raw : raw.slice(2) })
  }
  return { lines: out, next: i }
}

// The two sides become one list: context once, each side's changes in turn.
function interleave(lhs, rhs) {
  const out = []
  let i = 0, j = 0
  while (i < lhs.length || j < rhs.length) {
    if (lhs[i]?.tag === ' ' && rhs[j]?.tag === ' ') { out.push(lhs[i]); i++; j++; continue }
    while (i < lhs.length && lhs[i].tag !== ' ') { out.push(lhs[i]); i++ }
    while (j < rhs.length && rhs[j].tag !== ' ') { out.push(rhs[j]); j++ }
    if (lhs[i]?.tag === ' ' && rhs[j] === undefined) { out.push(lhs[i]); i++ }
    else if (rhs[j]?.tag === ' ' && lhs[i] === undefined) { out.push(rhs[j]); j++ }
  }
  return out
}

const READERS = { unified: parseUnified, context: parseContext, normal: parseNormal }
