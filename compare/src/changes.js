// compareTrees: a path in both trees is modified or type-changed, a path in one
// added or deleted unless renames.js pairs it with another, as git diff -M does
// and, unless `renamesByPath` is false, by the paths a build moves files to; on
// Node, a change to a declaration file holding types alone on each side stamped so.

import { proveTypeOnly } from '#types'
import { MAX_SCORE } from './similarity.js'
import { findRenames } from './renames.js'
import { checkLineOptions, contentOf, textOf } from './text.js'
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

// A declaration file as TypeScript names one: `.d.ts`, `.d.mts`, `.d.cts`, and
// `.d.css.ts` for a `.css` file's.
const DECLARATION = /\.d\.(?:[^./]+\.)?[cm]?ts$/u

// The module system a declaration file's extension fixes, or null where its package says and this cannot:
// `.mts` an ES module, `.cts` a CommonJS one, a `.ts` either. A module load and `export {}` run as one and
// throw as the other, so where a side's runtime is not empty and the format is null, or the two differ,
// a change across them is not types only.
const fixedModule = (path) => (path.endsWith('.mts') ? 'module' : path.endsWith('.cts') ? 'commonjs' : null)

// A path's directory, with its trailing slash, or '' at the root. A relative load resolves against it, so
// a rename that changes it can run a different module from the same runtime text.
const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1)

// A file's proof: that it holds types alone but for its `runtime` -- a hashbang, the module loads and
// `export {}` stripping leaves -- which a change must leave byte for byte untouched to be types only. A
// side not there has none. Not proven where the proof throws, as no check should.
function proven(file) {
  if (file === null) return { proven: true, runtime: '' }
  const text = textOf(file)
  try {
    return text === undefined ? { proven: false } : proveTypeOnly(text)
  } catch {
    return { proven: false }
  }
}

// Stamped where each side there is a declaration file proven to hold types alone and the two leave the
// same runtime -- a change touching only erased types (and comments). A mode changing is a change of its
// own. Where that runtime is not empty it runs the same on both sides only within one module format and
// one directory, so a rename across formats (a `.d.mts` to a `.d.cts`, either to a package-resolved
// `.d.ts`) does not qualify, nor one to another directory, where a relative load would resolve elsewhere;
// a modification keeps its path, hence its format and directory, and an added or deleted file matches only
// an empty one. Known limitation: a modification of a package-resolved `.d.ts` is taken to keep its format,
// though the `package.json` that resolves it could change `type` between the two trees and flip it; that
// flip is a change to `package.json`, seen in the diff on its own, and format is read from the extension
// here, not resolved from a package.

function stamped(change) {
  const sides = [change.old, change.new].filter((file) => file !== null)
  if (!sides.every((file) => file.type === 'file' && DECLARATION.test(file.path))) return change
  if (change.old && change.new && change.old.mode !== change.new.mode) return change
  const fresh = proven(change.new), old = proven(change.old)
  if (!old.proven || !fresh.proven || old.runtime !== fresh.runtime) return change
  if (old.runtime !== '' && change.old && change.new && change.old.path !== change.new.path) {
    const format = fixedModule(change.old.path)
    if (format === null || format !== fixedModule(change.new.path)) return change
    if (dirOf(change.old.path) !== dirOf(change.new.path)) return change
  }
  return { ...change, typeOnly: true }
}

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

export function compareTrees(a, b, { renames = true, renamesByPath = true, renameLimit = DEFAULT_RENAME_LIMIT, renameGroup = null, paths = 'tree', lines = true, horizon, whitespace, ignoreCase } = {}) {
  const minimum = minimumScore(renames)
  checkOptions({ renamesByPath, renameLimit, renameGroup, paths, lines })
  const lineOptions = checkLineOptions({ horizon, whitespace, ignoreCase })
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
  return (lines ? changes.map((change) => ({ ...change, ...contentOf(change.old, change.new, lineOptions) })) : changes).map(stamped)
}
