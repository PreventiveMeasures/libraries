// The patch `git diff` writes (builtin_diff, fill_metainfo in diff.c), less its
// `index` lines, which need git's object hashes. Hunks are @preventive/diff's:
// a run of lines free to move may sit elsewhere than git puts it.

import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'
import { diff } from '@preventive/diff'
import { quote } from './quote.js'
import { textOf } from './text.js'
import { sameContent } from './tree.js'

const gitMode = (file) => (file.type === 'symlink' ? '120000' : (0o100000 | file.mode).toString(8))

// git ends a label holding a space with a tab, so patch reads the whole name.
const label = (name) => (name.includes(' ') ? `${name}\t` : name)

// git's default hunk name (def_ff in xemit.c): the nearest line above the hunk
// starting with a letter, `_` or `$`, cut to 80 bytes, less trailing blanks.
const FUNCTION_LINE = /^[A-Za-z_$]/u
const BLANKS = /[\t\n\r ]+$/u

// git may cut a character in two; this cuts before it.
function cut(line) {
  const bytes = utf8fromString(line)
  let end = Math.min(bytes.length, 80)
  while ((bytes[end] & 0xC0) === 0x80) end--
  return utf8toString(bytes.subarray(0, end)).replace(BLANKS, '')
}

// git searches back only to the previous hunk's start, keeping what it found.
function hunkNames(text) {
  const lines = text.split('\n')
  let found = null, searched = -1
  return (start) => {
    for (let at = start - 1; at > searched; at--) {
      if (FUNCTION_LINE.test(lines[at])) {
        found = cut(lines[at])
        break
      }
    }
    searched = start - 1
    return found
  }
}

function body(one, two, from, to, context) {
  const newText = textOf(two), oldText = textOf(one)
  if (oldText === undefined || newText === undefined) {
    return one !== null && two !== null && sameContent(one, two) ? '' : `Binary files ${from} and ${to} differ\n`
  }
  const hunks = diff(oldText, newText, { context, slide: true, label: hunkNames(oldText) })
  return hunks === '' ? '' : `--- ${label(from)}\n+++ ${label(to)}\n${hunks}`
}

// One `diff --git` section; `similarity` is a rename's. As git does, a header
// with nothing under it is left out.
function section(one, two, similarity, context) {
  const a = quote((one ?? two).path, 'a/'), b = quote((two ?? one).path, 'b/')
  let meta = ''
  if (one === null) meta += `new file mode ${gitMode(two)}\n`
  else if (two === null) meta += `deleted file mode ${gitMode(one)}\n`
  else if (gitMode(one) !== gitMode(two)) meta += `old mode ${gitMode(one)}\nnew mode ${gitMode(two)}\n`
  if (similarity !== null) meta += `similarity index ${similarity}%\nrename from ${quote(one.path)}\nrename to ${quote(two.path)}\n`
  const rest = meta + body(one, two, one === null ? '/dev/null' : a, two === null ? '/dev/null' : b, context)
  return rest === '' ? '' : `diff --git ${a} ${b}\n${rest}`
}

export function formatPatch(changes, { context = 3 } = {}) {
  if (!(Number.isInteger(context) && context >= 0)) throw new RangeError(`context must be a whole number of lines, not ${context}`)
  let out = ''
  for (const { status, old, new: fresh, similarity } of changes) {
    switch (status) {
      // git writes a type change as a deletion and a creation.
      case 'type-changed':
        out += section(old, null, null, context) + section(null, fresh, null, context)
        break
      case 'renamed':
        out += section(old, fresh, similarity, context)
        break
      case 'added':
      case 'deleted':
      case 'modified':
        out += section(old, fresh, null, context)
        break
      default:
        throw new TypeError(`${JSON.stringify(status)} is not a change's status`)
    }
  }
  return out
}
