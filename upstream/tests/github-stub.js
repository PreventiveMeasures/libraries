// Shared by the GitHub client tests: a stubbed fetch, and the answers it
// gives.

import { gitTreeOfListing } from '../src/tree.js'

export const SHA = '3f786850e387550fdab836ed7e6dc881de23001b'
export const SHA2 = '89e6c98d92887913cadf06b2adb97f26cde4849b'

const API = 'https://api.github.com/repos/acme/app'

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

// Answers each request with `respond(call)` and keeps every one it was
// asked, so a test can check what went over the wire.
export function stubGitHub(respond) {
  const calls = []
  globalThis.fetch = (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', headers: options.headers, redirect: options.redirect, body: options.body && JSON.parse(options.body) }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return calls
}

// For a test that must not reach the network at all.
export function forbidRequests() {
  return stubGitHub(({ url }) => {
    throw new Error(`unexpected request: ${url}`)
  })
}

// The tree of `files`, by path, and GitHub's listing of each tree in it,
// by id.
export function treeOf(files) {
  const listings = {}
  const build = (paths) => {
    const entries = [...Map.groupBy(Object.entries(paths), ([path]) => path.split('/')[0])].map(([name, group]) => {
      if (group.length === 1 && group[0][0] === name) return { path: name, ...group[0][1] }
      return { path: name, mode: '040000', type: 'tree', sha: build(Object.fromEntries(group.map(([path, entry]) => [path.slice(name.length + 1), entry]))) }
    })
    const sha = gitTreeOfListing(entries)
    listings[sha] = entries
    return sha
  }
  return { tree: build(files), listings }
}

// A tree's listing with every tree's under it, by paths from it.
export const deepOf = (listings, id) => listings[id].flatMap((entry) => [entry, ...(entry.type === 'tree' ? deepOf(listings, entry.sha).map((under) => ({ ...under, path: `${entry.path}/${under.path}` })) : [])])

// GitHub, for acme/app at SHA: its commit of `tree`, and a listing of each
// tree, `?recursive=1` asked, cut short for each in `truncated`, with a
// `url` on each entry and a `size` on each blob, as GitHub answers.
export function stubTrees({ tree, listings }, { truncated = [], deep = {} } = {}) {
  return stubGitHub(({ url }) => {
    const { pathname, search } = new URL(url)
    if (pathname === `/repos/acme/app/git/commits/${SHA}`) return json({ sha: SHA, tree: { sha: tree } })
    const id = /^\/repos\/acme\/app\/git\/trees\/(?<id>[\da-f]{40})$/u.exec(pathname)?.groups.id
    if (!Object.hasOwn(listings, id) || !['', '?recursive=1'].includes(search)) return json({ message: 'Not Found' }, 404)
    const recursive = search !== ''
    const cut = recursive && truncated.includes(id)
    const entries = recursive ? (Object.hasOwn(deep, id) ? deep[id] : deepOf(listings, id)) : listings[id]
    const answered = entries && (cut ? entries.slice(0, 2) : entries).map((entry) => ({ ...entry, ...(entry.type === 'blob' && { size: 3 }), url: `${API}/git/${entry.type}s/${entry.sha}` }))
    return json({ sha: id, url: `${API}/git/trees/${id}`, tree: answered, truncated: cut })
  })
}
