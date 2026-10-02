// Where a uv.lock package comes from: `source = { kind = value }`, of the
// kinds uv's SourceWire reads. Each comes back with `id`, the text uv
// shows it by, `registry+https://pypi.org/simple` or `virtual+.`, which is
// one source to uv where it is one text here.

import { LockfileError, at, quote } from '../error.js'
import { checkRelative, isCommit } from '../names.js'
import { checkPath } from '../python/files.js'
import { oneOf, string, table } from '../toml/shape.js'
import { checkUrl } from './shape.js'

const KINDS = ['registry', 'git', 'url', 'path', 'directory', 'editable', 'virtual']
const TREES = new Set(['directory', 'editable', 'virtual'])

const REFERENCES = new Set(['branch', 'tag', 'rev'])
const QUERY = new Set([...REFERENCES, 'subdirectory', 'path', 'lfs'])

const notGit = (value, why, where) => new LockfileError(`${quote(value)} is not a git source: ${why}`, where)
const NO_COMMIT = 'expected "#" and the full commit it resolved to'

// `git+URL`: the repository, `?branch=`, `?tag=` or `?rev=` and what was
// asked for, `subdirectory=`, `path=` to an archive in it, `lfs=true`, and
// `#` and the commit it resolved to, which a requirement may not have yet.
// A full commit asked for by `rev` is that commit, as uv holds it.
export function readGit(value, where) {
  const url = checkUrl(value, where, ['https:', 'http:', 'ssh:', 'file:'])
  const pairs = [...url.searchParams]
  const unknown = pairs.find(([key]) => !QUERY.has(key))
  if (unknown !== undefined) throw notGit(value, `uv does not read ${quote(unknown[0])}`, where)
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw notGit(value, 'a key twice in the query', where)
  const named = pairs.filter(([key]) => REFERENCES.has(key))
  if (named.length > 1) throw notGit(value, 'more than one of branch=, tag= and rev=', where)
  const query = Object.fromEntries(pairs)
  if (query.lfs !== undefined && query.lfs !== 'true') throw notGit(value, 'lfs= other than true, which uv does not write', where)
  for (const key of ['subdirectory', 'path']) if (query[key] !== undefined) checkRelative(query[key], where)
  const commit = url.hash === '' ? undefined : url.hash.slice(1)
  if (commit !== undefined && !isCommit(commit)) throw notGit(value, NO_COMMIT, where)
  const rev = query.rev?.toLowerCase()
  if (rev !== undefined && commit !== undefined && isCommit(rev) && rev !== commit) throw notGit(value, 'rev= names another commit than the one it resolved to', where)
  url.search = ''
  url.hash = ''
  return {
    type: 'git',
    url: value,
    repository: url.href,
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
  if (type === 'git') {
    const git = readGit(value, here)
    if (git.commit === undefined) throw notGit(value, NO_COMMIT, here)
    return git
  }
  if (type === 'url') {
    if (checkUrl(value, here, ['https:', 'http:']).hash !== '') throw new LockfileError(`${quote(value)} has a fragment, which uv drops`, here)
    return { type, url: value, subdirectory: subdirectory === undefined ? undefined : checkPath(subdirectory, at(where, 'subdirectory')) }
  }
  return { type, path: checkPath(value, here) }
}

export function readSource(value, where) {
  const type = oneOf(table(value, where, [...KINDS, 'subdirectory']), KINDS, where)
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
