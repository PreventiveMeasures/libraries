// compareTrees: a path in both trees is modified or type-changed, a path in one
// added or deleted unless renames.js pairs it with another, as git diff -M does
// and, unless `renamesByPath` is false, by the paths a build moves files to.

import { MAX_SCORE } from './similarity.js'
import { findRenames } from './renames.js'
import { checkLineOptions, contentOf } from './text.js'
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

function checkOptions({ renamesByPath, renameLimit, renameGroup, paths, lines }) {
  if (typeof renamesByPath !== 'boolean') throw new TypeError(`renamesByPath must be a boolean, not ${typeof renamesByPath}`)
  if (renameLimit !== Infinity && !(Number.isSafeInteger(renameLimit) && renameLimit >= 0)) throw new RangeError(`renameLimit must be a whole number or Infinity, not ${renameLimit}`)
  if (renameGroup !== null && typeof renameGroup !== 'function') throw new TypeError(`renameGroup must be a function, not ${typeof renameGroup}`)
  if (paths !== 'tree' && paths !== 'keys') throw new RangeError(`paths must be 'tree' or 'keys', not ${paths}`)
  if (typeof lines !== 'boolean') throw new TypeError(`lines must be a boolean, not ${typeof lines}`)
}

const sameFile = (a, b) => sameContent(a, b) && (a.type !== 'file' || a.mode === b.mode)

const status = (kind, old, fresh, similarity = null) => ({ status: kind, old, new: fresh, similarity })

function pathChanges(old, fresh) {
  const added = [], changes = [], deleted = []
  for (const [path, file] of old) {
    const now = fresh.get(path)
    if (now === undefined) deleted.push(file)
    else if (now.type !== file.type) changes.push(status('type-changed', file, now))
    else if (!sameFile(file, now)) changes.push(status('modified', file, now))
  }
  for (const [path, file] of fresh) if (!old.has(path)) added.push(file)
  deleted.sort((a, b) => byPath(a.path, b.path))
  added.sort((a, b) => byPath(a.path, b.path))
  return { changes, deleted, added }
}

// With `group`, renames are looked for within each group alone, as in a tree
// of its own: a file is never taken for one of another group.
function renamePairs(deleted, added, { group, ...options }) {
  if (group === null) return findRenames(deleted, added, options)
  const pairs = new Map()
  const groupsOf = (files) => Map.groupBy(files.keys(), (i) => group(files[i].path))
  const sourcesBy = groupsOf(deleted)
  for (const [key, ds] of groupsOf(added)) {
    const ss = sourcesBy.get(key)
    if (ss === undefined) continue
    for (const [d, { source, score }] of findRenames(ss.map((s) => deleted[s]), ds.map((i) => added[i]), options)) pairs.set(ds[d], { source: ss[source], score })
  }
  return pairs
}

// A change with what it did to the content (text.js), found under `options`.
export const compareLines = (change, options) => ({ ...change, ...contentOf(change.old, change.new, checkLineOptions(options)) })

export function compareTrees(a, b, { renames = true, renamesByPath = true, renameLimit = DEFAULT_RENAME_LIMIT, renameGroup = null, paths = 'tree', lines = true, slide, horizon, whitespace, ignoreCase } = {}) {
  const minimum = minimumScore(renames)
  checkOptions({ renamesByPath, renameLimit, renameGroup, paths, lines })
  const lineOptions = checkLineOptions({ slide, horizon, whitespace, ignoreCase })
  const keys = paths === 'keys'
  const { changes, deleted, added } = pathChanges(readTree(a, 'old', keys), readTree(b, 'new', keys))
  const pairs = minimum === null ? new Map() : renamePairs(deleted, added, { minimum, limit: renameLimit, byPath: renamesByPath, group: renameGroup })
  for (const [d, file] of added.entries()) {
    const pair = pairs.get(d)
    changes.push(pair === undefined ? status('added', null, file) : status('renamed', deleted[pair.source], file, Math.trunc(pair.score * 100 / MAX_SCORE)))
  }
  const moved = new Set(pairs.values().map(({ source }) => source))
  for (const [s, file] of deleted.entries()) if (!moved.has(s)) changes.push(status('deleted', file, null))
  // A rename stands at its new path, as git lists it.
  changes.sort((x, y) => byPath((x.new ?? x.old).path, (y.new ?? y.old).path))
  return lines ? changes.map((change) => ({ ...change, ...contentOf(change.old, change.new, lineOptions) })) : changes
}
