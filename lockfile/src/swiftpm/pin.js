// A pin: what package, from where, and at what. Of version 1, its location,
// the name its manifest gives the package, and a state of all three fields,
// null where not; of 2 and 3, its identity, kind and location, and a state
// of the fields that are.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, isCommit } from '../names.js'
import { checkerOf, field, record, string, text } from '../shape.js'
import { checkIdentity, checkLocation, checkRegistryIdentity, identityFrom } from './location.js'

const checker = checkerOf(text)

// A version as TSCUtility.Version describes the one it read, which SwiftPM
// writes: three numbers without a leading zero, then pre-release and build
// identifiers of letters, digits and hyphens. SemVer's form, but that an
// identifier may be empty, or a number with a leading zero, as SwiftPM
// reads a tag of either. No number past 2^53, which no tag has.
const IDENTIFIERS = '[\\dA-Za-z-]*(?:\\.[\\dA-Za-z-]*)*'
const VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${IDENTIFIERS})?(?:\\+${IDENTIFIERS})?$`, 'u')

const isSwiftVersion = (version) => VERSION.exec(version)?.slice(1, 4).every((part) => Number(part) <= Number.MAX_SAFE_INTEGER) ?? false

const checkVersion = checker(isSwiftVersion, 'a version as SwiftPM writes one')

// The commit SwiftPM checked out, as git rev-parse writes it: SwiftPM
// resolves a short hash a manifest gives, and keeps that as a branch's name.
const checkRevision = checker(isCommit, 'a full commit hash, as SwiftPM writes the commit it checked out')

// A branch, or the revision a manifest gives that is not a full hash, which
// SwiftPM keeps as a branch: refused where git check-ref-format refuses it
// as a branch's name, as `HEAD~1` is, which names no branch.
const checkBranch = checkRefName

// A package's name as its manifest gives it, which version 1 keeps.
const checkName = checker((name) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name), 'a package\'s name')

function required(holder, names, where, why) {
  const missing = names.find((name) => holder[name] === undefined)
  if (missing !== undefined) throw new LockfileError(`expected ${missing}, ${why}`, where)
}

// A repository's: a version or a branch, or neither, and the commit it was
// at. A field not there is null of version 1, as `nulls` says, and left out
// of 2 and 3.
function readRepositoryState(state, where, nulls) {
  const absent = nulls ? null : undefined
  if (state.branch !== absent && state.version !== absent) throw new LockfileError('a branch and a version both, where SwiftPM writes one or neither', where)
  const read = (key, check) => (state[key] === absent ? undefined : check(state[key], at(where, key)))
  return { version: read('version', checkVersion), branch: read('branch', checkBranch), revision: checkRevision(state.revision, at(where, 'revision')) }
}

// Of version 1: three fields each, null where not, as TSCBasic writes an
// Optional. Its kind is a repository's: a registry's package SwiftPM does
// not write in version 1, and one by a path is a local repository's.
export function readLegacyPin(value, where) {
  const pin = record(value, where, ['package', 'repositoryURL', 'state'])
  required(pin, ['package', 'repositoryURL', 'state'], where, 'which SwiftPM writes of every pin')
  const name = checkName(pin.package, at(where, 'package'))
  const location = checkLocation(pin.repositoryURL, at(where, 'repositoryURL'))
  const here = at(where, 'state')
  const state = record(pin.state, here, ['branch', 'revision', 'version'])
  required(state, ['branch', 'revision', 'version'], here, 'which SwiftPM writes of every pin, null where it has none')
  const identity = identityFrom(location, at(where, 'repositoryURL'))
  return { identity, kind: 'remoteSourceControl', location, name, originalLocation: undefined, ...readRepositoryState(state, here, true) }
}

function readRepositoryPin(pin, where) {
  const location = checkLocation(pin.location, at(where, 'location'))
  const identity = checkIdentity(text(pin.identity, at(where, 'identity')), location, at(where, 'identity'))
  if (pin.originalLocation !== undefined) throw new LockfileError('SwiftPM writes where a package was looked up from of a registry\'s package alone', at(where, 'originalLocation'))
  const here = at(where, 'state')
  const state = record(pin.state, here, ['branch', 'revision', 'version'])
  if (state.revision === undefined) throw new LockfileError('expected revision, the commit SwiftPM checked out, which it writes of every repository', here)
  return { identity, kind: 'remoteSourceControl', location, name: undefined, originalLocation: undefined, ...readRepositoryState(state, here, false) }
}

// A registry's package: by its identity alone, as SwiftPM writes no
// location of one, at a version alone. Where SwiftPM looked it up from a
// repository's URL, as `--replace-scm-with-registry` has it do, that URL.
function readRegistryPin(pin, where) {
  const identity = checkRegistryIdentity(pin.identity, at(where, 'identity'))
  if (string(pin.location, at(where, 'location')) !== '') throw new LockfileError(`${quote(pin.location)} where SwiftPM writes "", the location of no registry's package`, at(where, 'location'))
  const originalLocation = field(pin, 'originalLocation', where, checkLocation)
  const here = at(where, 'state')
  const state = record(pin.state, here, ['branch', 'revision', 'version'])
  for (const key of ['branch', 'revision']) {
    if (state[key] !== undefined) throw new LockfileError(`SwiftPM writes no ${key} of a registry's package, which it downloads by its version`, at(here, key))
  }
  if (state.version === undefined) throw new LockfileError('expected version, which SwiftPM writes of every registry\'s package', here)
  const version = checkVersion(state.version, at(here, 'version'))
  return { identity, kind: 'registry', location: undefined, name: undefined, originalLocation, version, branch: undefined, revision: undefined }
}

// Of versions 2 and 3: the fields SwiftPM writes, and none null.
export function readPin(value, where) {
  const pin = record(value, where, ['identity', 'kind', 'location', 'originalLocation', 'state'])
  required(pin, ['identity', 'kind', 'location', 'state'], where, 'which SwiftPM writes of every pin')
  const kind = string(pin.kind, at(where, 'kind'))
  if (kind === 'localSourceControl') throw new LockfileError('a repository on the machine that wrote the lockfile, by its path, which reads on that machine alone', at(where, 'kind'))
  if (kind === 'registry') return readRegistryPin(pin, where)
  if (kind === 'remoteSourceControl') return readRepositoryPin(pin, where)
  throw new LockfileError(`${quote(kind)} is not a kind SwiftPM writes: remoteSourceControl, localSourceControl or registry`, at(where, 'kind'))
}
