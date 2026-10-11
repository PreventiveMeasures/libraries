// Two trees compared as git compares them: every path that is not the same
// on both sides, one change for each, in the order git lists them.
//
// A path both trees have is modified, when its content or a file's mode
// differs, or changed in type, between a file and a link. A path only one has
// is added or deleted -- unless the deleted file and the added file are one
// file moved, which renames.js decides as `git diff -M` does, and which is
// then one change, renamed, at the new path. A type change is never a
// rename's either side, as it is not in git.
//
// Each change carries what it did to the content, line by line (text.js).

import { MAX_SCORE } from './similarity.js'
import { findRenames } from './renames.js'
import { contentOf } from './text.js'
import { readTree, sameContent } from './tree.js'

// git's -M default, 50%.
const DEFAULT_RENAMES = 50
const DEFAULT_RENAME_LIMIT = 1000

// Code point order, which is git's: it sorts paths as bytes, and UTF-8 bytes
// keep code point order. A string's own order would put U+E000..U+FFFF after
// everything past U+FFFF.
export function byPath(a, b) {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
}

// `renames` as the least score a rename takes, out of MAX_SCORE, or null for
// no renames: a percentage as -M takes one, `true` for its default.
function minimumScore(renames) {
  if (renames === false) return null
  const percent = renames === true ? DEFAULT_RENAMES : renames
  if (typeof percent !== 'number') throw new TypeError(`renames must be a boolean or a percentage, not ${typeof renames}`)
  if (!(percent > 0 && percent <= 100)) throw new RangeError(`renames must be a percentage above 0 and at most 100, not ${renames}`)
  return Math.max(1, Math.trunc(MAX_SCORE * percent / 100))
}

function checkLimit(limit) {
  if (limit !== Infinity && !(Number.isSafeInteger(limit) && limit >= 0)) throw new RangeError(`renameLimit must be a whole number or Infinity, not ${limit}`)
  return limit
}

const sameFile = (a, b) => sameContent(a, b) && (a.type !== 'file' || a.mode === b.mode)

// The changes before renames are looked for: what the paths both trees have
// say, and the files each tree has alone, in path order.
function pathChanges(old, fresh) {
  const added = [], changes = [], deleted = []
  for (const [path, file] of old) {
    const now = fresh.get(path)
    if (now === undefined) deleted.push(file)
    else if (now.type !== file.type) changes.push({ status: 'type-changed', old: file, new: now })
    else if (!sameFile(file, now)) changes.push({ status: 'modified', old: file, new: now })
  }
  for (const [path, file] of fresh) if (!old.has(path)) added.push(file)
  deleted.sort((a, b) => byPath(a.path, b.path))
  added.sort((a, b) => byPath(a.path, b.path))
  return { changes, deleted, added }
}

export function compareTrees(a, b, { renames = true, renameLimit = DEFAULT_RENAME_LIMIT } = {}) {
  const minimum = minimumScore(renames)
  const limit = checkLimit(renameLimit)
  const { changes, deleted, added } = pathChanges(readTree(a, 'old'), readTree(b, 'new'))
  const pairs = minimum === null ? new Map() : findRenames(deleted, added, { minimum, limit })
  const moved = new Set()
  for (const [d, file] of added.entries()) {
    const pair = pairs.get(d)
    if (pair === undefined) {
      changes.push({ status: 'added', old: null, new: file })
      continue
    }
    moved.add(pair.source)
    changes.push({ status: 'renamed', old: deleted[pair.source], new: file, similarity: Math.trunc(pair.score * 100 / MAX_SCORE) })
  }
  for (const [s, file] of deleted.entries()) if (!moved.has(s)) changes.push({ status: 'deleted', old: file, new: null })
  // A change stands where its new path would in the tree, or its old one if
  // it has none: a rename at its destination, as git puts it.
  changes.sort((x, y) => byPath((x.new ?? x.old).path, (y.new ?? y.old).path))
  return changes.map(({ status, old, new: fresh, similarity = null }) => ({ status, old, new: fresh, similarity, ...contentOf(old, fresh) }))
}
