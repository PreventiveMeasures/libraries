// A pin: what package, from where, and at what. Of version 1, its location,
// the name its manifest gives the package, and a state of all three fields,
// null where not; of 2 and 3, its identity, kind and location, and a state
// of the fields that are.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, isCommit } from '../names.js'
import { checkerOf, field, record, required, string, text } from '../shape.js'
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

// A package's name as its manifest gives it, which version 1 keeps, and the
// one field of a pin of any text: none of a control, a line separator, or a
// format character, a bidi control or one of no width among them, which
// would hide or reorder what is shown of it.
const checkName = checker((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), 'a package\'s name, of no control, format or line separator character')

const PIN = 'which SwiftPM writes of every pin'
const LEGACY = ['package', 'repositoryURL', 'state']
const STATE = ['branch', 'revision', 'version']

// A pin's state, and where it is.
function stateOf(pin, where) {
  const here = at(where, 'state')
  return [record(pin.state, here, STATE), here]
}

// A repository's: a version or a branch, or neither, and the commit it was
// at. A field not there is `absent`: null of version 1, left out of 2 and
// 3. A branch is one the manifest gives, or the revision it gives where
// that is not a full hash, which SwiftPM keeps as a branch: refused where
// git check-ref-format refuses it as a branch's name, as `HEAD~1` is, which
// names no branch.
function readRepositoryState(state, where, absent = undefined) {
  if (state.branch !== absent && state.version !== absent) throw new LockfileError('a branch and a version both, where SwiftPM writes one or neither', where)
  const read = (key, check) => (state[key] === absent ? undefined : check(state[key], at(where, key)))
  return { version: read('version', checkVersion), branch: read('branch', checkRefName), revision: checkRevision(state.revision, at(where, 'revision')) }
}

const repository = (identity, location, name, state) => ({ identity, kind: 'remoteSourceControl', location, name, originalLocation: undefined, ...state })

// Of version 1: three fields each, null where not, as TSCBasic writes an
// Optional. Its kind is a repository's: a registry's package SwiftPM does
// not write in version 1, and one by a path is a local repository's.
export function readLegacyPin(value, where) {
  const pin = record(value, where, LEGACY)
  required(pin, LEGACY, where, PIN)
  const name = checkName(pin.package, at(where, 'package'))
  const location = checkLocation(pin.repositoryURL, at(where, 'repositoryURL'))
  const [state, here] = stateOf(pin, where)
  required(state, STATE, here, `${PIN}, null where it has none`)
  return repository(identityFrom(location, at(where, 'repositoryURL')), location, name, readRepositoryState(state, here, null))
}

function readRepositoryPin(pin, where) {
  const location = checkLocation(pin.location, at(where, 'location'))
  const identity = checkIdentity(text(pin.identity, at(where, 'identity')), location, at(where, 'identity'))
  if (pin.originalLocation !== undefined) throw new LockfileError('SwiftPM writes where a package was looked up from of a registry\'s package alone', at(where, 'originalLocation'))
  const [state, here] = stateOf(pin, where)
  required(state, ['revision'], here, 'the commit SwiftPM checked out, which it writes of every repository')
  return repository(identity, location, undefined, readRepositoryState(state, here))
}

// A registry's package: by its identity alone, as SwiftPM writes no
// location of one, at a version alone. Where SwiftPM looked it up from a
// repository's URL, as `--replace-scm-with-registry` has it do, that URL.
function readRegistryPin(pin, where) {
  const identity = checkRegistryIdentity(pin.identity, at(where, 'identity'))
  if (string(pin.location, at(where, 'location')) !== '') throw new LockfileError(`${quote(pin.location)} where SwiftPM writes "", the location of no registry's package`, at(where, 'location'))
  const originalLocation = field(pin, 'originalLocation', where, checkLocation)
  const [state, here] = stateOf(pin, where)
  for (const key of ['branch', 'revision']) {
    if (state[key] !== undefined) throw new LockfileError(`SwiftPM writes no ${key} of a registry's package, which it downloads by its version`, at(here, key))
  }
  required(state, ['version'], here, 'which SwiftPM writes of every registry\'s package')
  const version = checkVersion(state.version, at(here, 'version'))
  return { identity, kind: 'registry', location: undefined, name: undefined, originalLocation, version, branch: undefined, revision: undefined }
}

// Of versions 2 and 3: the fields SwiftPM writes, and none null.
export function readPin(value, where) {
  const pin = record(value, where, ['identity', 'kind', 'location', 'originalLocation', 'state'])
  required(pin, ['identity', 'kind', 'location', 'state'], where, PIN)
  const kind = string(pin.kind, at(where, 'kind'))
  if (kind === 'localSourceControl') throw new LockfileError('a repository on the machine that wrote the lockfile, by its path, which reads on that machine alone', at(where, 'kind'))
  if (kind === 'registry') return readRegistryPin(pin, where)
  if (kind === 'remoteSourceControl') return readRepositoryPin(pin, where)
  throw new LockfileError(`${quote(kind)} is not a kind SwiftPM writes: remoteSourceControl, localSourceControl or registry`, at(where, 'kind'))
}
