// Where a uv.lock package comes from: `source = { kind = value }`, of the
// kinds uv's SourceWire reads. Each comes back with `id`, the text uv
// shows it by, `registry+https://pypi.org/simple` or `virtual+.`, which is
// one source to uv where it is one text here.

import { LockfileError, at, quote } from '../error.js'
import { checkRelative, isCommit } from '../names.js'
import { string, table } from '../toml/shape.js'

const KINDS = ['registry', 'git', 'url', 'path', 'directory', 'editable', 'virtual']
const TREES = new Set(['directory', 'editable', 'virtual'])

// A URL as the url crate writes it, as uv writes one: with no credentials,
// which uv strips, and of a scheme it fetches over.
export function checkUrl(value, where, schemes = ['https:', 'http:', 'file:']) {
  const url = URL.parse(string(value, where))
  if (url === null || url.href !== value || !schemes.includes(url.protocol)) {
    throw new LockfileError(`${quote(value)} is not a URL in normal form, of ${schemes.map((scheme) => scheme.slice(0, -1)).join(', ')}`, where)
  }
  if (url.username !== '' || url.password !== '') throw new LockfileError(`${quote(value)} has credentials in it, which uv does not write`, where)
  return url
}

// A path as uv writes one, `/` between segments, from the workspace root.
export function checkPath(value, where) {
  if (/^(?:\/|[A-Za-z]:)/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is absolute, and only reads on the machine that wrote it`, where)
  return checkRelative(value, where)
}

const REFERENCES = ['branch', 'tag', 'rev']
const QUERY = new Set([...REFERENCES, 'subdirectory', 'path', 'lfs'])

// `git+URL`: the repository, `?branch=`, `?tag=` or `?rev=` and what was
// asked for, `subdirectory=`, `path=` to an archive in it, `lfs=true`, and
// `#` and the commit it resolved to. A full commit asked for by `rev` is
// that commit, as uv holds it.
export function readGit(value, where, needsCommit = true) {
  const url = checkUrl(value, where, ['https:', 'http:', 'ssh:', 'file:'])
  const fail = (why) => {
    throw new LockfileError(`${quote(value)} is not a git source: ${why}`, where)
  }
  const pairs = [...url.searchParams]
  const unknown = pairs.find(([key]) => !QUERY.has(key))
  if (unknown !== undefined) fail(`uv does not read ${quote(unknown[0])}`)
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) fail('a key twice in the query')
  const named = pairs.filter(([key]) => REFERENCES.includes(key))
  if (named.length > 1) fail('more than one of branch=, tag= and rev=')
  const query = Object.fromEntries(pairs)
  if (query.lfs !== undefined && query.lfs !== 'true') fail('lfs= other than true, which uv does not write')
  for (const key of ['subdirectory', 'path']) if (query[key] !== undefined) checkRelative(query[key], where)
  const commit = url.hash === '' ? undefined : url.hash.slice(1)
  if (commit === undefined ? needsCommit : !isCommit(commit)) fail('expected "#" and the full commit it resolved to')
  if (query.rev !== undefined && isCommit(query.rev.toLowerCase()) && commit !== undefined && query.rev.toLowerCase() !== commit) fail('rev= names another commit than the one it resolved to')
  const repository = new URL(url.href)
  repository.search = ''
  repository.hash = ''
  return {
    type: 'git',
    url: value,
    repository: repository.href,
    reference: named.length === 0 ? undefined : { kind: named[0][0], name: named[0][1] },
    commit,
    subdirectory: query.subdirectory,
    path: query.path,
    lfs: query.lfs === 'true',
  }
}

// A local registry is named by a path, a remote one by a URL.
function readRegistry(value, where) {
  if (/^[A-Za-z][\w+.-]*:\/\//u.test(string(value, where))) return { type: 'registry', url: checkUrl(value, where).href, path: undefined }
  return { type: 'registry', url: undefined, path: checkPath(value, where) }
}

function readKind(type, value, subdirectory, where) {
  const here = at(where, type)
  if (type === 'registry') return readRegistry(value, here)
  if (type === 'git') return readGit(value, here)
  if (type === 'url') {
    const url = checkUrl(value, here, ['https:', 'http:'])
    if (url.hash !== '') throw new LockfileError(`${quote(value)} has a fragment, which uv drops`, here)
    return { type, url: value, subdirectory: subdirectory === undefined ? undefined : checkRelative(string(subdirectory, at(where, 'subdirectory')), at(where, 'subdirectory')) }
  }
  return { type, path: checkPath(value, here) }
}

export function readSource(value, where) {
  table(value, where, [...KINDS, 'subdirectory'])
  const kinds = KINDS.filter((key) => value[key] !== undefined)
  if (kinds.length !== 1) throw new LockfileError(`expected one of ${KINDS.join(', ')}, found ${kinds.length === 0 ? 'none' : kinds.join(' and ')}`, where)
  const [type] = kinds
  if (value.subdirectory !== undefined && type !== 'url') throw new LockfileError('a subdirectory, which uv reads of a URL alone', at(where, 'subdirectory'))
  const source = readKind(type, value[type], value.subdirectory, where)
  return { ...source, id: idOf(source) }
}

// uv shows a source as its kind, `+`, and its URL or path; a URL's
// subdirectory, which it leaves out, is added as a fragment, which no URL
// here has.
function idOf(source) {
  if (source.type === 'registry') return `registry+${source.url ?? source.path}`
  if (source.type === 'git') return `git+${source.url}`
  if (source.type === 'url') return `direct+${source.url}${source.subdirectory === undefined ? '' : `#subdirectory=${source.subdirectory}`}`
  return `${source.type}+${source.path}`
}

export const isTree = (source) => TREES.has(source.type)

// Whether a source's file always has a hash: a URL's, a path's or a git
// archive's does; a registry's may not.
export const needsHash = (source) => source.type === 'url' || source.type === 'path' || (source.type === 'git' && source.path !== undefined)
