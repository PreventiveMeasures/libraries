// compareTrees: a path in both trees is modified or type-changed, a path in one
// added or deleted unless renames.js pairs it with another, as git diff -M does
// and, unless `renamesByPath` is false, by the paths a build moves files to.

import { MAX_SCORE } from './similarity.js'
import { findRenames } from './renames.js'
import { contentOf } from './text.js'
import { readTree, sameContent } from './tree.js'

// git's defaults: -M at 50%, diff.renameLimit at 1000.
const DEFAULT_RENAMES = 50
const DEFAULT_RENAME_LIMIT = 1000

// Code point order, which is git's byte order for UTF-8 paths; `<` on strings
// would put U+E000..U+FFFF after astral characters.
function byPath(a, b) {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
}

// -M's percentage as the least score out of MAX_SCORE, or null for no renames.
function minimumScore(renames) {
  if (renames === false) return null
  const percent = renames === true ? DEFAULT_RENAMES : renames
  if (typeof percent !== 'number') throw new TypeError(`renames must be a boolean or a percentage, not ${typeof renames}`)
  if (!(percent > 0 && percent <= 100)) throw new RangeError(`renames must be a percentage above 0 and at most 100, not ${renames}`)
  return Math.max(1, Math.trunc(MAX_SCORE * percent / 100))
}

function checkByPath(value) {
  if (typeof value !== 'boolean') throw new TypeError(`renamesByPath must be a boolean, not ${typeof value}`)
}

function checkLimit(limit) {
  if (limit !== Infinity && !(Number.isSafeInteger(limit) && limit >= 0)) throw new RangeError(`renameLimit must be a whole number or Infinity, not ${limit}`)
}

const sameFile = (a, b) => sameContent(a, b) && (a.type !== 'file' || a.mode === b.mode)

const change = (status, old, fresh, similarity = null) => ({ status, old, new: fresh, similarity, ...contentOf(old, fresh) })

function pathChanges(old, fresh) {
  const added = [], changes = [], deleted = []
  for (const [path, file] of old) {
    const now = fresh.get(path)
    if (now === undefined) deleted.push(file)
    else if (now.type !== file.type) changes.push(change('type-changed', file, now))
    else if (!sameFile(file, now)) changes.push(change('modified', file, now))
  }
  for (const [path, file] of fresh) if (!old.has(path)) added.push(file)
  deleted.sort((a, b) => byPath(a.path, b.path))
  added.sort((a, b) => byPath(a.path, b.path))
  return { changes, deleted, added }
}

export function compareTrees(a, b, { renames = true, renamesByPath = true, renameLimit = DEFAULT_RENAME_LIMIT } = {}) {
  const minimum = minimumScore(renames)
  checkByPath(renamesByPath)
  checkLimit(renameLimit)
  const { changes, deleted, added } = pathChanges(readTree(a, 'old'), readTree(b, 'new'))
  const pairs = minimum === null ? new Map() : findRenames(deleted, added, { minimum, limit: renameLimit, byPath: renamesByPath })
  for (const [d, file] of added.entries()) {
    const pair = pairs.get(d)
    changes.push(pair === undefined ? change('added', null, file) : change('renamed', deleted[pair.source], file, Math.trunc(pair.score * 100 / MAX_SCORE)))
  }
  const moved = new Set(pairs.values().map(({ source }) => source))
  for (const [s, file] of deleted.entries()) if (!moved.has(s)) changes.push(change('deleted', file, null))
  // A rename stands at its new path, as git lists it.
  return changes.sort((x, y) => byPath((x.new ?? x.old).path, (y.new ?? y.old).path))
}
