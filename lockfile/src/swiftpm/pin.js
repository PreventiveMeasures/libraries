// A pin: of version 1 by location, with the package's name and a state of
// three fields, null where none; of 2 and 3 by identity and kind.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, isCommit } from '../names.js'
import { checkerOf, field, record, string, text } from '../shape.js'
import { checkIdentity, checkLocation, checkRegistryIdentity } from './location.js'

const checker = checkerOf(text)

// TSCUtility.Version's description: SemVer's form, but that an identifier
// may be empty, or a number with a leading zero, as SwiftPM reads tags.
const IDENTIFIERS = '[\\dA-Za-z-]*(?:\\.[\\dA-Za-z-]*)*'
const VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${IDENTIFIERS})?(?:\\+${IDENTIFIERS})?$`, 'u')
const checkVersion = checker((version) => VERSION.exec(version)?.slice(1, 4).every((part) => Number(part) <= Number.MAX_SAFE_INTEGER) ?? false, 'a version as SwiftPM writes one')

const checkRevision = checker(isCommit, 'a full commit hash, as SwiftPM writes the commit it checked out')

// The one field of any text: nothing in it that hides or reorders it.
const checkName = checker((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), 'a package\'s name, of no control, format or line separator character')

// A repository at a commit, by a version, a branch or neither; a field not
// there is `absent`. A branch may be a short hash the manifest gives.
function repository(pin, where, absent, identity, location, name) {
  const here = at(where, 'state')
  const state = record(pin.state, here, ['branch', 'revision', 'version'])
  const read = (key, check) => (state[key] === absent ? undefined : check(state[key], at(here, key)))
  const version = read('version', checkVersion)
  const branch = read('branch', checkRefName)
  if (version !== undefined && branch !== undefined) throw new LockfileError('a branch and a version both, where SwiftPM writes one or neither', here)
  return { identity, kind: 'remoteSourceControl', location, name, originalLocation: undefined, version, branch, revision: checkRevision(state.revision, at(here, 'revision')) }
}

export function readLegacyPin(value, where) {
  const pin = record(value, where, ['package', 'repositoryURL', 'state'])
  const name = checkName(pin.package, at(where, 'package'))
  const location = checkLocation(pin.repositoryURL, at(where, 'repositoryURL'))
  return repository(pin, where, null, checkIdentity(location, at(where, 'repositoryURL')), location, name)
}

// By identity alone, at a version alone; with the repository's URL it was
// looked up by, as `--replace-scm-with-registry` has SwiftPM do.
function readRegistryPin(pin, where) {
  const identity = checkRegistryIdentity(pin.identity, at(where, 'identity'))
  if (string(pin.location, at(where, 'location')) !== '') throw new LockfileError(`${quote(pin.location)} where SwiftPM writes "", the location of no registry's package`, at(where, 'location'))
  const here = at(where, 'state')
  const none = 'SwiftPM writes none of a registry\'s package, which it downloads by its version'
  const { version } = record(pin.state, here, ['version'], { branch: none, revision: none })
  const originalLocation = field(pin, 'originalLocation', where, checkLocation)
  return { identity, kind: 'registry', location: undefined, name: undefined, originalLocation, version: checkVersion(version, at(here, 'version')), branch: undefined, revision: undefined }
}

export function readPin(value, where) {
  const pin = record(value, where, ['identity', 'kind', 'location', 'originalLocation', 'state'])
  const kind = string(pin.kind, at(where, 'kind'))
  if (kind === 'registry') return readRegistryPin(pin, where)
  if (kind === 'localSourceControl') throw new LockfileError('a repository on the machine that wrote the lockfile, by its path, which reads on that machine alone', at(where, 'kind'))
  if (kind !== 'remoteSourceControl') throw new LockfileError(`${quote(kind)} is not a kind SwiftPM writes: remoteSourceControl, localSourceControl or registry`, at(where, 'kind'))
  const location = checkLocation(pin.location, at(where, 'location'))
  const identity = checkIdentity(location, at(where, 'identity'), text(pin.identity, at(where, 'identity')))
  if (pin.originalLocation !== undefined) throw new LockfileError('SwiftPM writes where a package was looked up from of a registry\'s package alone', at(where, 'originalLocation'))
  return repository(pin, where, undefined, identity, location, undefined)
}
