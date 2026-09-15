// The three output styles — normal, unified and context — rendered from a
// change set. The formats are the ones every diff and patch already agree
// on, and the rules below are those formats, so the same change set gives
// the same bytes as any other implementation; that the change set is the
// right one is what myers.js guarantees.
//
// What is printed is then read back before it is returned, and has to say
// what it was given. That is the counterpart of the guarantee myers.js makes
// on the change set, and the hole it leaves: a change set can be right and
// the text describing it wrong, and nothing but a reader would ever notice.

import { parseDiff } from './parse.js'

export class FormatError extends Error {
  constructor(detail) {
    super(`the rendered diff does not say what the change set says (${detail})`)
    this.name = 'FormatError'
  }
}

// Read back, and held to the change set and to the two files. Every line
// printed is one of their lines: a context or removed line is the first
// file's, an added line the second's — which is true whatever comparison
// was in force, so this holds under the whitespace and case options too,
// where the two files' "equal" lines differ in text and rebuilding the
// second file from the diff would not give it back.
//
// Only the hunks are read. The label lines are the caller's to write, and a
// file named something that reads like a hunk header would otherwise fail a
// rendering that is perfectly correct.
function verifyRendering(a, b, blocks, body) {
  if (blocks.length === 0) {
    if (body !== '') throw new FormatError('there was nothing to print, and something was printed')
    return
  }
  let files
  try { files = parseDiff(body) } catch (e) { throw new FormatError(`it does not read back (${e.message})`) }
  if (files.length !== 1) throw new FormatError(`${files.length} files read back, not one`)
  const read = files[0].blocks
  if (read.length !== blocks.length) throw new FormatError(`${read.length} blocks read back, not ${blocks.length}`)
  for (const [i, got] of read.entries()) {
    const want = blocks[i]
    if (got.a0 !== want.a0 || got.a1 !== want.a1 || got.b0 !== want.b0 || got.b1 !== want.b1) throw new FormatError(`block ${i + 1} reads back somewhere else`)
  }
  for (const hunk of files[0].hunks) {
    let ai = hunk.oldStart, bi = hunk.newStart
    for (const { tag, text } of hunk.lines) {
      const want = tag === '+' ? b[bi] : a[ai]
      if (text !== want) throw new FormatError(`a ${tag === '+' ? 'added' : tag === '-' ? 'removed' : 'kept'} line is not the line it stands for`)
      if (tag !== '+') ai++
      if (tag !== '-') bi++
    }
  }
}

// From a change set to what the context formats print: hunks, each a run of
// changes close enough to share context lines. Two changes belong to one
// hunk when the unchanged lines between them number at most twice the
// context — exactly when their context lines would touch or overlap.

export function groupHunks(blocks, context, aLength, bLength) {
  const hunks = []
  let i = 0
  while (i < blocks.length) {
    let j = i
    while (j + 1 < blocks.length && blocks[j + 1].a0 - blocks[j].a1 <= 2 * context) j++
    const first = blocks[i], last = blocks[j]
    hunks.push({
      blocks: blocks.slice(i, j + 1),
      a0: Math.max(0, first.a0 - context), a1: Math.min(aLength, last.a1 + context),
      b0: Math.max(0, first.b0 - context), b1: Math.min(bLength, last.b1 + context),
    })
    i = j + 1
  }
  return hunks
}

// A line is printed as it is stored, terminator included; one without a
// terminator can only be a file's last, and says so on the next line.
const NO_NEWLINE = '\n\\ No newline at end of file\n'
const printLine = (prefix, line) => prefix + line + (line.endsWith('\n') ? '' : NO_NEWLINE)

// `3c3`, `5a6,7`, `8,9d9`; an empty range prints the line before it.
function normalRange(start, end) {
  return end > start + 1 ? `${start + 1},${end}` : `${end > start ? start + 1 : start}`
}

export function formatNormal(a, b, blocks) {
  let out = ''
  for (const { a0, a1, b0, b1 } of blocks) {
    const letter = a0 === a1 ? 'a' : b0 === b1 ? 'd' : 'c'
    out += normalRange(a0, a1) + letter + normalRange(b0, b1) + '\n'
    for (let i = a0; i < a1; i++) out += printLine('< ', a[i])
    if (letter === 'c') out += '---\n'
    for (let i = b0; i < b1; i++) out += printLine('> ', b[i])
  }
  verifyRendering(a, b, blocks, out)
  return out
}

// A unified range: one line prints bare, an empty range prints the line
// before it with `,0`.
function unifiedRange(start, end) {
  if (end <= start) return `${start},0`
  return end === start + 1 ? `${start + 1}` : `${start + 1},${end - start}`
}

// `header` is the two label lines, already built; `fn(index)` names the
// function a hunk starting at that line falls in, or null.
export function formatUnified(a, b, blocks, { context, header, fn }) {
  let out = header
  for (const hunk of groupHunks(blocks, context, a.length, b.length)) {
    const name = fn ? fn(hunk.a0) : null
    out += `@@ -${unifiedRange(hunk.a0, hunk.a1)} +${unifiedRange(hunk.b0, hunk.b1)} @@${name === null ? '' : ' ' + name}\n`
    let ai = hunk.a0, bi = hunk.b0
    for (const { a0, a1, b1 } of hunk.blocks) {
      for (; ai < a0; ai++, bi++) out += printLine(' ', a[ai])
      for (; ai < a1; ai++) out += printLine('-', a[ai])
      for (; bi < b1; bi++) out += printLine('+', b[bi])
    }
    for (; ai < hunk.a1; ai++, bi++) out += printLine(' ', a[ai])
  }
  verifyRendering(a, b, blocks, out.slice(header.length))
  return out
}

// A context range is first,last inclusive; a single line prints bare, an
// empty range as the line before it.
function contextRange(start, end) {
  if (end <= start) return `${start}`
  return end === start + 1 ? `${start + 1}` : `${start + 1},${end}`
}

export function formatContext(a, b, blocks, { context, header, fn }) {
  let out = header
  for (const hunk of groupHunks(blocks, context, a.length, b.length)) {
    const name = fn ? fn(hunk.a0) : null
    out += `***************${name === null ? '' : ' ' + name}\n`
    out += `*** ${contextRange(hunk.a0, hunk.a1)} ****\n`
    // A side with no changes of its own prints only its range line.
    if (hunk.blocks.some((block) => block.a0 < block.a1)) out += contextSide(a, hunk.a0, hunk.a1, hunk.blocks, 'a')
    out += `--- ${contextRange(hunk.b0, hunk.b1)} ----\n`
    if (hunk.blocks.some((block) => block.b0 < block.b1)) out += contextSide(b, hunk.b0, hunk.b1, hunk.blocks, 'b')
  }
  verifyRendering(a, b, blocks, out.slice(header.length))
  return out
}

// `! ` marks a line whose block both deletes and inserts; `- ` or `+ ` one
// whose block only does the one.
function contextSide(lines, from, to, blocks, side) {
  const end = side + '1', start = side + '0'
  const other = side === 'a' ? 'b' : 'a'
  let out = ''
  let i = from
  for (const block of blocks) {
    for (; i < block[start]; i++) out += printLine('  ', lines[i])
    const mark = block[other + '0'] < block[other + '1'] ? '! ' : side === 'a' ? '- ' : '+ '
    for (; i < block[end]; i++) out += printLine(mark, lines[i])
  }
  for (; i < to; i++) out += printLine('  ', lines[i])
  return out
}
