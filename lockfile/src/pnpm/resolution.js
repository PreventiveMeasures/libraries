// Where a package's files come from. pnpm writes three kinds of resolution
// into a v9 lockfile for what an install fetches, and each is read here
// with every field it may carry; a field or a `type` beyond those —
// `revision`, a `binary`, the `variations` of a runtime, a `custom:`
// resolver's — is refused, since what it would fetch is not read here.

import { LockfileError, at, quote } from '../error.js'
import { checkIntegrity, checkRelative, checkRepo, isCommit, isHttpUrl } from '../names.js'
import { flag, kind, optional, record, text } from '../shape.js'

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

// `path` is a subdirectory of the tarball or repository that is the
// package, where it is not the root: a git dependency's `#path:`.
const readPath = (resolution, where) => optional(resolution, 'path', where, text)

function readTarball(resolution, where) {
  record(resolution, where, ['integrity', 'tarball', 'path', 'gitHosted'])
  const { integrity, tarball } = resolution
  if (integrity === undefined && tarball === undefined) throw new LockfileError('expected an integrity or a tarball', where)
  return {
    type: 'tarball',
    integrity: optional(resolution, 'integrity', where, checkIntegrity),
    tarball: optional(resolution, 'tarball', where, checkTarball),
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

function readDirectory(resolution, where) {
  record(resolution, where, ['type', 'directory'])
  return { type: 'directory', directory: checkRelative(resolution.directory, at(where, 'directory')) }
}

export function readResolution(value, where) {
  const resolution = record(value, where)
  switch (resolution.type) {
    case undefined:
      return readTarball(resolution, where)
    case 'git':
      return readGit(resolution, where)
    case 'directory':
      return readDirectory(resolution, where)
    default:
      throw new LockfileError(`unsupported resolution type, ${kind(resolution.type)}`, at(where, 'type'))
  }
}
