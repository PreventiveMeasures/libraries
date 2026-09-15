// Which of diff's three output styles a piece of text is written in, and
// what part each of its lines plays. The part is named with a style — the
// vocabulary node:util's styleText takes, because that is what a Node
// caller will paint with — but nothing here paints, and nothing here is
// Node's: a caller holds the stream, knows whether a terminal is attached
// at all, and decides what a name means.
//
// The style is recognised from the text's own structural markers rather
// than from the command that produced it, because a caller may have nothing
// but the text — `cat` of a patch file deserves the same reading as a diff
// that just ran. Each marker is one a real diff emits and ordinary text does
// not, so a source file full of `+` bullets or `---` rules stays plain.

import { CONTEXT_FENCE, NORMAL_COMMAND, UNIFIED_HUNK } from './markers.js'

// Longest prefix first, so `---` is read as a file header rather than a
// removed line, and `+++` before `+`.
const RULES = {
  unified: [
    [/^--- /u, 'bold'], [/^\+\+\+ /u, 'bold'], [UNIFIED_HUNK, 'cyan'],
    [/^\+/u, 'green'], [/^-/u, 'red'], [/^\\ /u, 'gray'],
  ],
  context: [
    [CONTEXT_FENCE, 'cyan'], [/^\*{3} \d/u, 'cyan'], [/^--- \d/u, 'cyan'],
    [/^\*{3} /u, 'bold'], [/^--- /u, 'bold'],
    [/^! /u, 'yellow'], [/^\+ /u, 'green'], [/^- /u, 'red'],
  ],
  normal: [
    [NORMAL_COMMAND, 'cyan'], [/^< /u, 'red'], [/^> /u, 'green'], [/^---$/u, 'gray'],
  ],
}

// Context diffs also carry `---` headers, so the fence is looked for first.
function formatOf(lines) {
  if (lines.some((line) => CONTEXT_FENCE.test(line))) return 'context'
  if (lines.some((line) => UNIFIED_HUNK.test(line))) return 'unified'
  if (lines.some((line) => NORMAL_COMMAND.test(line))) return 'normal'
  return null
}

// 'unified', 'context' or 'normal', or null for text that is not a diff.
// Markers elsewhere in the text still count: a diff quoted in a message is
// read as one, and the lines around it simply take no style.
export const diffFormat = (text) => formatOf(text.split('\n'))

// One style name per line of `text`, null where a line takes none, so the
// array runs parallel to `text.split('\n')`. Null in place of the array
// when the text is not a diff at all — a caller can then hand the text back
// untouched without walking it.
export function diffLineStyles(text) {
  const lines = text.split('\n')
  const rules = RULES[formatOf(lines)]
  if (rules === undefined) return null
  return lines.map((line) => rules.find(([pattern]) => pattern.test(line))?.[1] ?? null)
}
