// A source's options, as each of Bundler's sources writes them in to_lock:
// GIT its repository, the commit it resolved to and what was asked for;
// PATH a directory; GEM the server it fetches from.

import { LockfileError, at, quote } from '../error.js'
import { fail } from '../lines.js'
import { checkRefName, checkRelative, isCommit, isHttpUrl } from '../names.js'

// The options of each, in the order Bundler writes them; the first are
// always written.
const OPTIONS = {
  GIT: { order: ['remote', 'revision', 'ref', 'branch', 'tag', 'submodules', 'glob'], required: 2 },
  PATH: { order: ['remote', 'glob'], required: 1 },
  GEM: { order: ['remote'], required: 0 },
}

// What Bundler reads every gemspec of a repository or a directory by,
// where none is given, and does not write.
const DEFAULT_GLOB = '{,*,*/*}.gemspec'

function readOptions({ type, number, options }) {
  const { order, required } = OPTIONS[type]
  const values = Object.create(null)
  let next = 0
  for (const { key, value, number: line } of options) {
    const index = order.indexOf(key)
    if (index === -1) throw fail(`${quote(key)} is not an option Bundler writes for a ${type} source`, line)
    if (key in values) throw fail(type === 'GEM' ? 'a second remote: Bundler fetches each gem of the source from either, and the lockfile does not say which' : `a second ${key}`, line)
    if (index < next) throw fail(`${key} after ${order[next - 1]}, where Bundler writes it before`, line)
    if (value.trim() !== value) throw fail(`${quote(value)} has a space at an end, which no ${key} Bundler writes has`, line)
    next = index + 1
    values[key] = value
  }
  const missing = order.slice(0, required).find((key) => !(key in values))
  if (missing !== undefined) throw fail(`a ${type} source without its ${missing}`, number)
  return values
}

// Undefined where none is written.
function readGlob(value, where) {
  if (value === DEFAULT_GLOB) throw new LockfileError(`${quote(value)}, which Bundler reads by where none is written, and does not write`, where)
  return value
}

// A repository by URL, or by path, as the Gemfile has it, a space and all,
// less a `/` at the end; `ref` what was asked for, which is a commit, a
// branch, a tag or anything else git reads, and `revision` the commit it
// was.
function readGit(values, where) {
  const { remote } = values
  if (remote.endsWith('/')) throw new LockfileError(`${quote(remote)} ends in "/", which Bundler leaves out of a repository`, at(where, 'remote'))
  const { revision, ref } = values
  if (!isCommit(revision)) throw new LockfileError(`${quote(revision)} is not a full commit hash`, at(where, 'revision'))
  if (ref !== undefined && /\s/u.test(ref)) throw new LockfileError(`${quote(ref)} is not a reference git reads`, at(where, 'ref'))
  if (ref !== undefined && isCommit(ref) && ref !== revision) throw new LockfileError(`the commit ${ref}, and the revision another`, at(where, 'ref'))
  if (values.submodules !== undefined && values.submodules !== 'true') throw new LockfileError(`expected "true", found ${quote(values.submodules)}`, at(where, 'submodules'))
  return {
    type: 'git',
    remote,
    revision,
    ref,
    branch: values.branch === undefined ? undefined : checkRefName(values.branch, at(where, 'branch')),
    tag: values.tag === undefined ? undefined : checkRefName(values.tag, at(where, 'tag')),
    submodules: values.submodules === 'true',
    glob: readGlob(values.glob, at(where, 'glob')),
  }
}

// A directory, from the lockfile's. Bundler writes one out of the project
// by its absolute path, which is the path on one machine alone.
function readPath(values, where) {
  const here = at(where, 'path')
  if (values.remote.startsWith('/')) throw new LockfileError(`${quote(values.remote)} is an absolute path, which is the path on one machine alone`, here)
  return { type: 'path', path: checkRelative(values.remote, here), glob: readGlob(values.glob, at(where, 'glob')) }
}

// What else RubyGems fetches gems from as from a server, by a URL in the
// normal form: a directory, by a file: URL of no host, so that it is one
// path to every reader, or an S3 bucket, by an s3: URL of the bucket.
function isNormalUrl(remote) {
  const url = URL.parse(remote)
  return url !== null && url.href === remote && (url.protocol === 'file:' ? url.host === '' : url.protocol === 's3:' && url.host !== '')
}

// A server of the gem API by its URL, or a directory or a bucket of gems,
// as Bundler writes it: with a `/` at the end. Bundler 2.4 and older write
// the credentials the Gemfile gives it.
function readGem(values, where) {
  const { remote } = values
  if (remote === undefined) return { type: 'gem', remote }
  const url = (isHttpUrl(remote) || isNormalUrl(remote)) && !/\s/u.test(remote)
  if (!url) throw new LockfileError(`${quote(remote)} is not an http(s) URL, or a file: or s3: URL in normal form`, at(where, 'remote'))
  if (!remote.endsWith('/')) throw new LockfileError(`${quote(remote)} does not end in "/", as Bundler writes a source`, at(where, 'remote'))
  return { type: 'gem', remote }
}

function readSource(raw, where) {
  const values = readOptions(raw)
  if (raw.type === 'GIT') return readGit(values, where)
  if (raw.type === 'PATH') return readPath(values, where)
  return readGem(values, where)
}

// What Bundler sorts the git and path sources by, as far as the lockfile
// says it: a path's identifier whole, and a repository's first part, its
// URL and then ` (`, whatever the rest each version of Bundler writes. A
// URL of credentials, which Bundler leaves out of it, or of a scheme in
// capitals, which it writes in lowercase, says nothing: undefined.
function orderKey(source) {
  if (source.type === 'path') return `source at \`${source.path}\``
  const url = /^([A-Za-z][\w+.-]*):\/\/([^/]*)/u.exec(source.remote)
  return url !== null && (/[A-Z]/u.test(url[1]) || url[2].includes('@')) ? undefined : `${source.remote} (`
}

const describe = (source) => `the ${source.type} source ${quote(source.remote ?? source.path)}`

// The git and path sources in Bundler's order, where the lockfile says it:
// Bundler sorts them by what identifies each. The GEM sources' order is of
// their URLs with the credentials the Gemfile gives, which the lockfile
// leaves out, and is not checked, but for the Gemfile's own, below.
function checkOrder(sources, raw) {
  let prior
  for (const [index, source] of sources.entries()) {
    const key = source.type === 'gem' ? undefined : orderKey(source)
    if (key === undefined) continue
    if (prior !== undefined && key < prior.key) throw fail(`${describe(source)} after ${describe(prior.source)}, where Bundler sorts them the other way`, raw[index].number)
    prior = { key, source }
  }
}

// The Gemfile's own GEM source, which Bundler always writes: of no remote
// where it names none, and then the first of the GEM sources, as `locally
// installed gems` sorts before any URL, and the one alone of no remote, as
// any other is a `source`'s. Its index where it has none, else -1.
function readLocal(sources, raw) {
  const first = sources.findIndex((source) => source.type === 'gem')
  if (first === -1) throw new LockfileError('no GEM source, which Bundler always writes')
  const own = sources[first].remote === undefined
  const late = sources.findIndex((source, index) => index > first && source.type === 'gem' && source.remote === undefined)
  if (late !== -1) throw fail(own ? 'a second GEM source of no remote, where Bundler writes one, the Gemfile\'s own' : 'a GEM source of no remote after one of a remote, where Bundler writes it first', raw[late].number)
  return own ? first : -1
}

// Each source, in Bundler's order, and the index of the Gemfile's own GEM
// source where it has no remote, else -1.
export function readSources(raw) {
  const sources = raw.map((source, index) => readSource(source, `sources[${index}]`))
  checkOrder(sources, raw)
  return { sources, local: readLocal(sources, raw) }
}
