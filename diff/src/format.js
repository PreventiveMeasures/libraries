import { parseDiff } from './parse.js'

export class FormatError extends Error {
  constructor(detail) {
    super(`the rendered diff does not say what the change set says (${detail})`)
    this.name = 'FormatError'
  }
}

const KIND = { ' ': 'kept', '-': 'removed', '+': 'added' }

// What was printed, read back, has to give the blocks, and every line has to be one of the files' own:
// a removed or kept line the first's, an added line the second's, and a kept line in a context hunk that
// removes nothing the second's. That holds under any comparison, where rebuilding the second would not.
function verifyRendering(a, b, blocks, body) {
  if (blocks.length === 0 && body === '') return
  let files
  try {
    files = parseDiff(body)
  } catch (error) {
    throw new FormatError(`it does not read back (${error.message})`)
  }
  if (files.length !== 1) throw new FormatError(`${files.length} files read back, not one`)
  const [{ format, hunks, blocks: read }] = files
  if (read.length !== blocks.length) throw new FormatError(`${read.length} blocks read back, not ${blocks.length}`)
  for (const [i, got] of read.entries()) {
    const want = blocks[i]
    if (got.a0 !== want.a0 || got.a1 !== want.a1 || got.b0 !== want.b0 || got.b1 !== want.b1) throw new FormatError(`block ${i + 1} reads back somewhere else`)
  }
  for (const hunk of hunks) {
    const secondSideOnly = format === 'context' && !hunk.lines.some(({ tag }) => tag === '-')
    let ai = hunk.oldStart, bi = hunk.newStart
    for (const { tag, text } of hunk.lines) {
      const want = tag === '+' || (tag === ' ' && secondSideOnly) ? b[bi] : a[ai]
      if (text !== want) throw new FormatError(`a ${KIND[tag]} line is not the line it stands for`)
      if (tag !== '+') ai++
      if (tag !== '-') bi++
    }
  }
}

// Changes share a hunk when at most twice the context lies between them: when their context would touch
function groupHunks(blocks, context, aLength, bLength) {
  const hunks = []
  for (let i = 0; i < blocks.length;) {
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

// `label(index)` is what -p puts after a hunk's ranges, or null for nothing. The two lines a diff opens
// with are not taken: a label reading like diff content would ride through the check untouched.
const hunkFormat = (printHunk) => (a, b, blocks, { context, label = null }) => {
  let out = ''
  for (const hunk of groupHunks(blocks, context, a.length, b.length)) out += printHunk(a, b, hunk, label ? label(hunk.a0) : null)
  verifyRendering(a, b, blocks, out)
  return out
}

// A line without a terminator can only be a file's last, and says so on the next line
const NO_NEWLINE = '\n\\ No newline at end of file\n'
const printLine = (prefix, line) => prefix + line + (line.endsWith('\n') ? '' : NO_NEWLINE)
const named = (header, name) => `${header}${name === null ? '' : ` ${name}`}\n`

// First,last inclusive, one line bare, and an empty range as the line before it
const range = (start, end) => (end > start + 1 ? `${start + 1},${end}` : `${end > start ? start + 1 : start}`)

// Unified ranges are first,count: one line bare, an empty range as the line before it with `,0`
const unifiedRange = (start, end) => (end <= start ? `${start},0` : end === start + 1 ? `${start + 1}` : `${start + 1},${end - start}`)

export function formatNormal(a, b, blocks) {
  let out = ''
  for (const { a0, a1, b0, b1 } of blocks) {
    const letter = a0 === a1 ? 'a' : b0 === b1 ? 'd' : 'c'
    out += `${range(a0, a1)}${letter}${range(b0, b1)}\n`
    for (let i = a0; i < a1; i++) out += printLine('< ', a[i])
    if (letter === 'c') out += '---\n'
    for (let i = b0; i < b1; i++) out += printLine('> ', b[i])
  }
  verifyRendering(a, b, blocks, out)
  return out
}

export const formatUnified = hunkFormat((a, b, hunk, name) => {
  let out = named(`@@ -${unifiedRange(hunk.a0, hunk.a1)} +${unifiedRange(hunk.b0, hunk.b1)} @@`, name)
  let ai = hunk.a0, bi = hunk.b0
  for (const { a0, a1, b1 } of hunk.blocks) {
    for (; ai < a0; ai++, bi++) out += printLine(' ', a[ai])
    for (; ai < a1; ai++) out += printLine('-', a[ai])
    for (; bi < b1; bi++) out += printLine('+', b[bi])
  }
  for (; ai < hunk.a1; ai++, bi++) out += printLine(' ', a[ai])
  return out
})

export const formatContext = hunkFormat((a, b, { a0, a1, b0, b1, blocks }, name) => [
  named('***************', name),
  `*** ${range(a0, a1)} ****\n`,
  contextSide(a, a0, a1, blocks.map((block) => [block.a0, block.a1, block.b0 < block.b1]), '- '),
  `--- ${range(b0, b1)} ----\n`,
  contextSide(b, b0, b1, blocks.map((block) => [block.b0, block.b1, block.a0 < block.a1]), '+ '),
].join(''))

// `! ` marks a line whose block changes the other side too; a side with no changes prints nothing
function contextSide(lines, from, to, runs, mark) {
  if (!runs.some(([start, end]) => start < end)) return ''
  let out = ''
  let i = from
  for (const [start, end, both] of runs) {
    for (; i < start; i++) out += printLine('  ', lines[i])
    for (; i < end; i++) out += printLine(both ? '! ' : mark, lines[i])
  }
  for (; i < to; i++) out += printLine('  ', lines[i])
  return out
}
