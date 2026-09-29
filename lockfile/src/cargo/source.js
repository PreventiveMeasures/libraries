// Where a package comes from, as Cargo.lock writes it: `registry+` and a
// registry's index, `sparse+` and an index over HTTP, or `git+`, a
// repository, the branch, tag or rev asked for, and after `#` the commit it
// resolved to. Two sources are one where cargo holds them so: of one kind,
// asking for the same branch, tag or rev, at the same URL once canonical
// (github.com's in https and lower case, no trailing `/` or `.git`),
// whatever the commit. `identity` is that, as a string.

import { LockfileError, quote } from '../error.js'

export const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index'
const REFERENCES = new Set(['branch', 'tag', 'rev'])
const COMMIT = /^(?:[\da-f]{40}|[\da-f]{64})$/u

function canonical(url) {
  const github = url.hostname === 'github.com'
  const copy = new URL(github ? `https:${url.href.slice(url.protocol.length)}` : url.href)
  let path = copy.pathname.replace(/\/$/u, '')
  if (github) path = path.toLowerCase()
  copy.pathname = path.replace(/\.git$/u, '')
  return copy.href
}

// A URL as the url crate writes it, which is how cargo writes one back.
function parseUrl(text) {
  const url = URL.parse(text)
  return url !== null && url.href === text ? url : undefined
}

const identity = (kind, url, reference = []) => JSON.stringify([kind, canonical(url), ...reference])

// `edge` for a source in a package's `dependencies`, which cargo writes
// without the commit; a package's own source has it.
export function parseLockSource(text, where, edge) {
  const fail = (why) => {
    throw new LockfileError(`${quote(text)} is not a source: ${why}`, where)
  }
  const [, kind, rest] = /^(registry|sparse|git)\+(.*)$/su.exec(text) ?? fail('expected registry+, sparse+ or git+ and a URL')
  if (kind !== 'git') {
    const url = parseUrl(kind === 'sparse' ? text : rest)
    if (url === undefined || url.search !== '' || url.hash !== '') fail('expected a URL in normal form, without a query or a fragment')
    return { kind, identity: identity(kind, url), commit: undefined }
  }
  const [, base, query, commit] = /^([^#?]*)(?:\?([^#]*))?(?:#(.*))?$/su.exec(rest)
  if (edge ? commit !== undefined : !COMMIT.test(commit ?? '')) fail(edge ? 'a dependency names no commit' : 'expected "#" and the commit it resolved to')
  const url = parseUrl(base)
  if (url === undefined) fail('expected a URL in normal form')
  const pairs = [...new URLSearchParams(query ?? '')]
  if (pairs.length > 1 || (pairs.length === 1 && !REFERENCES.has(pairs[0][0]))) fail('expected at most one of branch=, tag= or rev=')
  return { kind, identity: identity(kind, url, pairs[0]), commit }
}

// The identity of what a manifest names: `registry-index` and a URL, a git
// repository and a reference, or crates.io where neither is given.
export function registryIdentity(index) {
  const url = parseUrl(index)
  if (url === undefined) return undefined
  return url.protocol.startsWith('sparse+') ? identity('sparse', url) : identity('registry', url)
}

export const CRATES_IO_IDENTITY = identity('registry', new URL(CRATES_IO.slice('registry+'.length)))

export function gitIdentity(repository, reference) {
  const url = URL.parse(repository)
  return url === null ? undefined : identity('git', url, reference)
}
