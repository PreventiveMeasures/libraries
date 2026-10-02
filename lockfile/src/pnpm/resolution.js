// Where a package's files come from. pnpm writes three kinds of resolution
// into a v9 lockfile for what an install fetches, and each is read here
// with every field it may carry; a field or a `type` beyond those —
// `revision`, a `binary`, the `variations` of a runtime, a `custom:`
// resolver's — is refused, since what it would fetch is not read here.

import { LockfileError, at, quote } from '../error.js'
import { checkIntegrity, checkRelative, checkRepo, checkWithin, isCommit, isHttpUrl } from '../names.js'
import { field, flag, kind, record, text } from '../shape.js'

// A tarball is fetched from an absolute http(s) URL or read from a local
// file, which pnpm writes as `file:` and a path from the lockfile's
// directory. A URL relative to the registry is refused, as it would be
// read as a path by anything but pnpm.
function checkTarball(value, where) {
  const tarball = text(value, where)
  if (tarball.startsWith('file:')) {
    checkRelative(tarball.slice(5), where)
  } else if (!isHttpUrl(tarball)) {
    throw new LockfileError(`${quote(tarball)} is not an http(s) URL or a file: path`, where)
  }
  return tarball
}

// A path pnpm writes by path.relative, which is empty from a directory to
// itself: that is read as `.`, as the directory itself is here.
export const readRelative = (value, where) => (value === '' ? '.' : checkRelative(value, where))

// `path` is a subdirectory of the tarball or repository that is the
// package, where it is not the root: a git dependency's `#path:`, as it
// was given, from the root by a `/` or not. pnpm joins it to where it
// unpacks the package, so it never climbs out of that.
const readPath = (resolution, where) => field(resolution, 'path', where, (value, here) => {
  checkWithin(text(value, here).replace(/^\//u, ''), here)
  return value
})

function readTarball(resolution, where) {
  record(resolution, where, ['integrity', 'tarball', 'path', 'gitHosted'])
  const { integrity, tarball } = resolution
  if (integrity === undefined && tarball === undefined) throw new LockfileError('expected an integrity or a tarball', where)
  return {
    type: 'tarball',
    integrity: field(resolution, 'integrity', where, checkIntegrity),
    tarball: field(resolution, 'tarball', where, checkTarball),
    path: readPath(resolution, where),
    gitHosted: flag(resolution.gitHosted, at(where, 'gitHosted')),
  }
}

function readGit(resolution, where) {
  record(resolution, where, ['type', 'repo', 'commit', 'path'])
  const commit = text(resolution.commit, at(where, 'commit'))
  if (!isCommit(commit)) throw new LockfileError(`${quote(commit)} is not a full commit hash`, at(where, 'commit'))
  const repo = checkRepo(resolution.repo, at(where, 'repo'))
  return { type: 'git', repo, commit, path: readPath(resolution, where) }
}

// From the lockfile's directory, empty where it is that directory, as the
// root project's `file:.` names it.
function readDirectory(resolution, where) {
  record(resolution, where, ['type', 'directory'])
  return { type: 'directory', directory: readRelative(resolution.directory, at(where, 'directory')) }
}

// By `type`, compared as `===` compares it: a key of an object would take
// the sequence `[git]` for `git`.
const READERS = new Map([[undefined, readTarball], ['git', readGit], ['directory', readDirectory]])

export function readResolution(value, where) {
  const resolution = record(value, where)
  const read = READERS.get(resolution.type)
  if (read === undefined) throw new LockfileError(`unsupported resolution type, ${kind(resolution.type)}`, at(where, 'type'))
  return read(resolution, where)
}
