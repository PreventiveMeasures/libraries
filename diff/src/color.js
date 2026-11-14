// Which format a text is in and what part each line plays, named as node:util's styleText names styles;
// nothing here paints. Read from the markers alone, so a patch shown by `cat` reads as a diff that ran.

import { CONTEXT_FENCE, NORMAL_COMMAND, UNIFIED_HUNK } from './markers.js'

// Longest prefix first, so `---` is a file header rather than a removed line
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

// Context diffs carry `---` headers too, so the fence is looked for first
function formatOf(lines) {
  if (lines.some((line) => CONTEXT_FENCE.test(line))) return 'context'
  if (lines.some((line) => UNIFIED_HUNK.test(line))) return 'unified'
  if (lines.some((line) => NORMAL_COMMAND.test(line))) return 'normal'
  return null
}

// A diff quoted in a message is read as one, and the lines around it take no style
export const diffFormat = (text) => formatOf(text.split('\n'))

export function diffLineStyles(text) {
  const lines = text.split('\n')
  const rules = RULES[formatOf(lines)]
  if (rules === undefined) return null
  return lines.map((line) => rules.find(([pattern]) => pattern.test(line))?.[1] ?? null)
}
