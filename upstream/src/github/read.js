import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { assertArgs, assertBoolean, assertGhsa, assertLogin, assertNumber, assertPath, assertRef, assertRepo, assertSha, assertTagName, assertTreeId, isSha, isSha1, isTagName, optional, sameName, show } from '../args.js'
import { verifiedDownload } from '../download.js'
import { decode, encodeSegment } from '../http.js'
import { gitTreeOfListing } from '../tree.js'
import { api, bindMethods, call, callWithHeaders, clientHeaders, isGone, repoApi } from './client.js'

const PER_PAGE = 100
const MAX_PAGES = 100

// A list of exactly `maxPages` full pages is whole only if the next is empty.
async function* pages(method, headers, pageUrl, maxPages = MAX_PAGES) {
  for (let page = 1; ; page++) {
    const body = await call(headers, pageUrl({ per_page: PER_PAGE, page }))
    assert.ok(Array.isArray(body), `${method}: expected an array for page ${page}`)
    assert.ok(page <= maxPages || body.length === 0, `${method}: more than ${maxPages} pages`)
    yield body
    if (body.length < PER_PAGE) return
  }
}

// A list GitHub pages by a cursor instead: the `after` of each page's
// Link header `next` link, the one thing read off the link, so the next
// page is asked of the list `pageUrl` names, wherever the link points. A
// next link proves a page more.
async function* cursorPages(method, headers, pageUrl, maxPages = MAX_PAGES) {
  const paging = { per_page: PER_PAGE }
  for (let page = 1; ; page++) {
    const answer = await callWithHeaders(headers, pageUrl(paging))
    assert.ok(Array.isArray(answer.body), `${method}: expected an array for page ${page}`)
    yield answer.body
    const next = /<([^>]*)>\s*;\s*rel="next"/u.exec(answer.headers.get('link') ?? '')?.[1]
    if (next === undefined) return
    paging.after = URL.parse(next)?.searchParams.get('after')
    assert.ok(paging.after, `${method}: page ${page} links the next with no cursor`)
    assert.ok(page < maxPages, `${method}: more than ${maxPages} pages`)
  }
}

const paginate = async (...args) => (await Array.fromAsync(pages(...args))).flat()
const getCurrentUser = (headers) => call(headers, api(['user']))

// No default for `options`: bindMethods counts it to refuse extra arguments.
async function listUserRepos(headers, options) {
  assertArgs('listUserRepos', options === undefined ? {} : options, { maxPages: optional(assertNumber) })
  return await paginate('listUserRepos', headers, (paging) => api(['user', 'repos'], { ...paging, sort: 'full_name' }), options?.maxPages)
}

async function getRepo(headers, options) {
  assertArgs('getRepo', options, { repo: assertRepo })
  const info = await call(headers, repoApi(options.repo))
  assert.ok(sameName(info?.full_name, options.repo), `getRepo: answered for ${show(info?.full_name)}, not ${options.repo}`)
  return info
}

export async function getRepoHead(headers, options) {
  assertArgs('getRepoHead', options, { repo: assertRepo, branch: optional(assertRef) })
  const { repo, branch } = options
  const ref = branch ?? (await getRepo(headers, { repo })).default_branch
  assertRef('getRepoHead', 'default branch', ref)
  const data = await call(headers, repoApi(repo, ['git', 'ref', 'heads', encodeSegment(ref)]))
  assert.ok(isSha(data?.object?.sha), `getRepoHead: no commit sha for ${repo}@${ref}`)
  return { branch: ref, oid: data.object.sha }
}

async function getRepoTag(headers, options) {
  assertArgs('getRepoTag', options, { repo: assertRepo, tag: assertTagName })
  const { repo, tag } = options
  const ref = await call(headers, repoApi(repo, ['git', 'ref', 'tags', encodeSegment(tag)]))
  assert.ok(ref?.ref === `refs/tags/${tag}`, `getRepoTag: GitHub answered for ${show(ref?.ref)}, not ${show(`refs/tags/${tag}`)}`)
  let { object } = ref
  for (let hops = 0; object?.type === 'tag' && isSha(object.sha) && hops < 8; hops++) {
    const annotated = await call(headers, repoApi(repo, ['git', 'tags', object.sha]))
    assert.ok(annotated?.sha === object.sha, `getRepoTag: GitHub answered for another tag object than ${object.sha}`)
    object = annotated.object
  }
  assert.ok(object?.type === 'commit' && isSha(object.sha), `getRepoTag: ${repo} has no commit for tag ${show(tag)}`)
  return { tag, oid: object.sha }
}

// GitHub lists each tag with the commit it names, an annotated one's too.
async function listRepoTags(headers, options) {
  assertArgs('listRepoTags', options, { repo: assertRepo, maxPages: optional(assertNumber) })
  const { repo, maxPages } = options
  const tags = await paginate('listRepoTags', headers, (paging) => repoApi(repo, ['tags'], paging), maxPages)
  return tags.map((entry) => {
    assert.ok(isTagName(entry?.name) && isSha(entry.commit?.sha), `listRepoTags: GitHub listed ${show(entry?.name)} in ${repo}, which is no tag name with a commit`)
    return { tag: entry.name, oid: entry.commit.sha }
  })
}

// GitHub's object for the path first: a directory, symlink or submodule is
// refused rather than read as a file's text. Up to 1 MB the object holds
// the content; past it, `encoding: none`, and the blob it names is read,
// which a push to the ref since cannot change. Either way the bytes must
// hash to that blob.
async function getRepoFile(headers, options) {
  assertArgs('getRepoFile', options, { repo: assertRepo, path: assertPath, ref: optional(assertRef) })
  const { repo, path, ref } = options
  const url = repoApi(repo, ['contents', ...path.split('/').map(encodeSegment)], ref === undefined ? {} : { ref })
  const file = await call(headers, url)
  assert.ok(file?.type === 'file' && file.path === path && Number.isSafeInteger(file.size) && isSha(file.sha), `getRepoFile: ${repo} has no file at ${show(path)}`)
  assert.ok(file.encoding === 'none' || (file.encoding === 'base64' && /^[\dA-Za-z+/=\n]*$/u.test(file.content ?? '')), `getRepoFile: unexpected encoding for ${show(path)}`)
  const bytes = file.encoding === 'none'
    ? await call({ ...headers, Accept: 'application/vnd.github.raw' }, repoApi(repo, ['git', 'blobs', file.sha]), { as: 'bytes' })
    : Buffer.from(file.content, 'base64')
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.ok(bytes.length === file.size && blob === file.sha, `getRepoFile: ${show(path)} came back as blob ${blob}, not ${file.sha}`)
  return decode(bytes, url)
}

// Follows the redirect to codeload.github.com. A tree id names its content,
// so the bytes are held to it, downloaded or cached, and cached by it alone,
// for good. What a tarball cannot show, a submodule's commit or a subtree
// with nothing in it, comes from GitHub's listings of the trees, which the
// id checks as well: a directory at a time, as a recursive listing of a
// large tree is cut short.
function lister(headers, repo) {
  const listings = new Map()
  return (sha) => {
    if (!listings.has(sha)) listings.set(sha, call(headers, repoApi(repo, ['git', 'trees', sha])).then((listing) => (Array.isArray(listing?.tree) ? listing.tree : [])))
    return listings.get(sha)
  }
}

async function treeTarball(method, headers, repo, tree) {
  const locate = () => repoApi(repo, ['tarball', tree])
  return await verifiedDownload({ method, dir: 'github/trees', what: tree, ext: 'tgz', algorithm: 'tree', expected: tree, locate, options: { headers, redirect: 'follow' }, objects: { list: lister(headers, repo) } })
}

// The commit's own archive, held to its tree as the tree's .gitattributes
// export it: listings as above, and the blobs of what says what is left
// out. Cached by the commit, and held to its tree again when read back.
async function exportedTarball(method, headers, repo, sha, tree) {
  const blob = (id) => call({ ...headers, Accept: 'application/vnd.github.raw' }, repoApi(repo, ['git', 'blobs', id]), { as: 'bytes' })
  const locate = () => repoApi(repo, ['tarball', sha])
  const objects = { list: lister(headers, repo), blob, commit: sha }
  return await verifiedDownload({ method, dir: 'github/archives', what: sha, ext: 'tgz', algorithm: 'archive', expected: tree, locate, options: { headers, redirect: 'follow' }, objects })
}

async function commitTree(method, headers, repo, sha) {
  const commit = await call(headers, repoApi(repo, ['git', 'commits', sha]))
  assert.ok(commit?.sha === sha && isSha1(commit.tree?.sha), `${method}: GitHub names no tree for ${repo}@${sha}`)
  return commit.tree.sha
}

// A full sha only, so the bytes are that commit's, not wherever a ref points
// now. Its tree's tarball, not its own, in which `git archive` rewrites the
// files marked `export-subst`; or, `exported`, its own.
async function getRepoTarball(headers, options) {
  assertArgs('getRepoTarball', options, { repo: assertRepo, sha: assertSha, exported: optional(assertBoolean) })
  const { repo, sha, exported } = options
  const tree = await commitTree('getRepoTarball', headers, repo, sha)
  return exported ? await exportedTarball('getRepoTarball', headers, repo, sha, tree) : await treeTarball('getRepoTarball', headers, repo, tree)
}

async function getRepoTreeTarball(headers, options) {
  assertArgs('getRepoTreeTarball', options, { repo: assertRepo, tree: assertTreeId })
  return await treeTarball('getRepoTreeTarball', headers, options.repo, options.tree)
}

// Not recursive: GitHub cuts short a recursive listing of a large tree.
async function listTree(method, headers, repo, tree) {
  const entries = (await call(headers, repoApi(repo, ['git', 'trees', tree])))?.tree
  assert.ok(Array.isArray(entries) && gitTreeOfListing(entries) === tree, `${method}: GitHub's listing of tree ${tree} in ${repo} is not that tree`)
  return entries.map(({ path, mode, type, sha }) => ({ path, mode, type, sha }))
}

async function treeAt(method, headers, options) {
  assertArgs(method, options, { repo: assertRepo, sha: assertSha, directory: optional(assertPath), path: optional(assertPath) })
  assert.ok(options.directory === undefined || options.path === undefined, `${method}: directory and path are one option, pass directory alone`)
  const { repo, sha, directory = options.path } = options
  let tree = await commitTree(method, headers, repo, sha)
  for (const name of directory?.split('/') ?? []) {
    const entry = (await listTree(method, headers, repo, tree)).find((candidate) => candidate.path === name)
    assert.ok(entry?.type === 'tree', `${method}: ${repo}@${sha} has no directory at ${show(directory)}`)
    tree = entry.sha
  }
  return tree
}

const getRepoTreeId = (headers, options) => treeAt('getRepoTreeId', headers, options)

async function listRepoDir(headers, options) {
  const tree = await treeAt('listRepoDir', headers, options)
  return await listTree('listRepoDir', headers, options.repo, tree)
}

async function getPullRequest(headers, options) {
  assertArgs('getPullRequest', options, { repo: assertRepo, number: assertNumber })
  const { repo, number } = options
  const pr = await call(headers, repoApi(repo, ['pulls', String(number)]))
  const base = pr?.base?.repo?.full_name
  assert.ok(pr?.number === number && sameName(base, repo), `getPullRequest: answered for ${show(base)}#${show(pr?.number)}, not ${repo}#${number}`)
  assert.ok(typeof pr.title === 'string' && pr.title.trim() !== '', `getPullRequest: ${repo}#${number} has no title`)
  assert.ok(['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean', `getPullRequest: ${repo}#${number} has no state`)
  const status = pr.merged ? 'merged' : (pr.state === 'closed' ? 'closed' : (pr.draft === true ? 'draft' : 'open'))
  return { title: pr.title, status }
}

async function getCollaboratorPermission(headers, options) {
  assertArgs('getCollaboratorPermission', options, { repo: assertRepo, username: assertLogin })
  const { repo, username } = options
  const body = await call(headers, repoApi(repo, ['collaborators', username, 'permission']))
  const login = body?.user?.login
  assert.ok(typeof body?.permission === 'string' && sameName(login, username), `getCollaboratorPermission: answered for ${show(login)}, not ${username}`)
  return body
}

// The repository's copy is the maintainer's latest text, there from the
// start; the global database has it only once GitHub has reviewed it, and
// is the fallback for a repository that is gone, not for one that failed.
async function getAdvisory(headers, options) {
  assertArgs('getAdvisory', options, { ghsa: assertGhsa, repo: optional(assertRepo) })
  const { ghsa, repo } = options
  const global = () => call(headers, api(['advisories', ghsa]))
  const advisory = await (repo === undefined ? global() : call(headers, repoApi(repo, ['security-advisories', ghsa])).catch((err) => {
    if (!isGone(err)) throw err
    return global()
  }))
  assert.ok(advisory?.ghsa_id === ghsa, `getAdvisory: answered for ${show(advisory?.ghsa_id)}, not ${ghsa}`)
  assert.ok(advisory.state === undefined || advisory.state === 'published', `getAdvisory: ${ghsa} is ${show(advisory.state)}, not published`)
  return advisory
}

async function listRepoAdvisories(headers, options) {
  assertArgs('listRepoAdvisories', options, { repo: assertRepo })
  const { repo } = options
  const pageUrl = (paging) => repoApi(repo, ['security-advisories'], { state: 'published', ...paging })
  return (await Array.fromAsync(cursorPages('listRepoAdvisories', headers, pageUrl))).flat()
}

export const readMethods = { getCurrentUser, listUserRepos, getRepo, getRepoHead, getRepoTag, listRepoTags, getRepoFile, getRepoTarball, getRepoTreeTarball, getRepoTreeId, listRepoDir, getPullRequest, getCollaboratorPermission, getAdvisory, listRepoAdvisories }
export const createClient = (options) => bindMethods(clientHeaders('createClient', options, true), readMethods)
