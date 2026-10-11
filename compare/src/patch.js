// The changes as the patch `git diff` writes (builtin_diff and fill_metainfo
// in diff.c): a `diff --git` line for each, the lines that say what became
// of the file -- new, deleted, its mode, its rename and how similar it
// stayed -- and then its hunks, or a line saying binary files differ. A type
// change is written as git writes one, the old file deleted and the new one
// created, under two headers.
//
// The hunks are @preventive/diff's, so the change set is GNU diff's; where a
// run of changed lines could sit in more than one place, git's own search
// may print it elsewhere, and both are the same patch. What is left out is
// git's `index` line, which names each side by the hash of its object: git
// apply and patch need none to apply a text patch, and git apply has none to
// check a binary one against, which it would refuse anyway, having no bytes.

import { diff } from '@preventive/diff'
import { quote, quotePrefixed } from './quote.js'
import { textOf } from './text.js'
import { sameContent } from './tree.js'

// A regular file's type bits over its permissions, or a link's, in octal.
const gitMode = (file) => (file.type === 'symlink' ? '120000' : (0o100000 | file.mode).toString(8))

// patch would take a name with a space in it to end at the space; git ends
// the label with a tab, which patch takes to end it instead.
const label = (name) => (name.includes(' ') ? `${name}\t` : name)

// git's default for what a hunk header names: the nearest line above the
// hunk, in the old file, that starts with a letter, `_` or `$`, cut to 80
// bytes -- here to the last whole character within them -- and its blanks at
// the end dropped. git searches back only to where it searched for the hunk
// before, keeping what it found there; so does this.
const FUNCTION_LINE = /^[A-Za-z_$]/u
const BLANKS = /[\t\n\r ]+$/u

function cut(line) {
  let bytes = 0, end = 0
  for (const char of line) {
    const code = char.codePointAt(0)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes > 80) break
    end += char.length
  }
  return line.slice(0, end).replace(BLANKS, '')
}

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

// One `diff --git` section, for `one` becoming `two`, either of which may be
// null; `similarity` is a rename's, and null for anything else.
function section(one, two, similarity, context) {
  const a = quotePrefixed('a/', (one ?? two).path), b = quotePrefixed('b/', (two ?? one).path)
  const from = one === null ? '/dev/null' : a, to = two === null ? '/dev/null' : b
  let header = `diff --git ${a} ${b}\n`
  // Whether there is anything to say before the hunks; if not, the header
  // is written only above them.
  let said = true
  if (one === null) header += `new file mode ${gitMode(two)}\n`
  else if (two === null) header += `deleted file mode ${gitMode(one)}\n`
  else if (gitMode(one) === gitMode(two)) said = similarity !== null
  else header += `old mode ${gitMode(one)}\nnew mode ${gitMode(two)}\n`
  if (similarity !== null) header += `similarity index ${similarity}%\nrename from ${quote(one.path)}\nrename to ${quote(two.path)}\n`

  const newText = textOf(two), oldText = textOf(one)
  if (oldText === undefined || newText === undefined) {
    if (one !== null && two !== null && sameContent(one, two)) return said ? header : ''
    return `${header}Binary files ${from} and ${to} differ\n`
  }
  const hunks = diff(oldText, newText, { context, slide: true, label: hunkNames(oldText) })
  if (hunks === '') return said ? header : ''
  return `${header}--- ${label(from)}\n+++ ${label(to)}\n${hunks}`
}

export function formatPatch(changes, { context = 3 } = {}) {
  if (!(Number.isInteger(context) && context >= 0)) throw new RangeError(`context must be a whole number of lines, not ${context}`)
  let out = ''
  for (const change of changes) {
    const { status, old, new: fresh, similarity } = change
    switch (status) {
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
