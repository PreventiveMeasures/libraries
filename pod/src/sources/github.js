// A git source on GitHub, checked out of GitHub's tarball of the commit's tree, which upstream holds to the
// commit's own object: the files a checkout writes, without the .git it clones.

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { HttpError } from '@preventive/upstream/github.js'

import { PodError, quote } from '../error.js'
import { MAX_BYTES } from './archive.js'

// A name git's checkout refuses, as its verify_path does with core.protectNTFS: `.git` or `git~1` in any case,
// dots and spaces after it, then nothing or a `:`.
const isDotGit = (name) => /^(?:\.git|git~1)[. ]*(?::|$)/iu.test(name)

// A GitHub repository as git takes its URL over https and ssh, with `.git` after it or not:
// https://github.com/<repo>, ssh://git@github.com/<repo> and git@github.com:<repo>.
const REPO = String.raw`(?<repo>(?=[\dA-Za-z-]{1,39}\/)[\dA-Za-z](?:-?[\dA-Za-z])*\/[\w.-]{1,100}?)(?:\.git)?`
const URL_FORM = new RegExp(String.raw`^(?:(?i:https):\/\/|(?i:ssh):\/\/git@)(?i:github\.com)\/${REPO}\/?$`, 'u')
const SCP_FORM = new RegExp(String.raw`^git@(?i:github\.com):${REPO}$`, 'u')

export function githubRepoOf(url) {
  const repo = (URL_FORM.exec(url) ?? SCP_FORM.exec(url))?.groups.repo
  return repo === undefined || /\/\.\.?$/u.test(repo) ? undefined : repo
}

const isRedirect = (error) => error instanceof HttpError && error.status >= 300 && error.status < 400

// A repository renamed or transferred since, which GitHub answers with a redirect that git's clone follows, is
// asked for by the name GitHub gives it now.
async function followingMoves(github, repo, ask) {
  try {
    return await ask(repo)
  } catch (error) {
    if (!isRedirect(error)) throw error
    const moved = await github.getRepo({ repo, followRedirect: true })
    return await ask(moved.full_name)
  }
}

// That `commit` is one a clone has, which GitHub's API does not tell: it answers for a commit of any fork, and one
// no branch reaches. The default branch's history alone is asked of, so one on another branch is refused too.
export async function checkCloned(github, repo, commit, where) {
  const { status } = await followingMoves(github, repo, async (name) => {
    const { default_branch: branch } = await github.getRepo({ repo: name })
    return await github.compareCommits({ repo: name, base: commit, head: branch })
  })
  if (status !== 'ahead' && status !== 'identical') {
    throw new PodError(`${commit} is not in the history of the repository's default branch, which is all that is held to be in a clone of it`, where)
  }
}

// GitHub's tarball of the commit's tree, which upstream reads off the commit's own object and holds the tarball
// to; unpacked as a checkout with umask 0o022 writes it: 0o755 directories, 0o644 or 0o755 files, links as links.
export async function checkoutOf(github, repo, rev, where) {
  const bytes = await followingMoves(github, repo, async (name) => github.getRepoTreeTarball({ repo: name, tree: await github.getCommitTree({ repo: name, sha: rev }) }))
  let entries
  try {
    entries = unpack(await decompress(bytes, 'gzip', { limit: MAX_BYTES }))
  } catch (error) {
    if (error instanceof ArchiveError) throw new PodError(`its tarball from GitHub cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  const top = entries[0]?.name.split('/')[0]
  const dirs = new Set()
  const files = new Map()
  const links = new Map()
  for (const entry of entries) {
    if (entry.name === top) continue
    if (!entry.name.startsWith(`${top}/`)) throw new Error('unreachable: an entry outside the one top directory upstream holds the tarball to')
    const path = entry.name.slice(top.length + 1)
    if (path.split('/').some(isDotGit)) throw new PodError('a path with a .git in it, or its short name, which git refuses to check out', `${where}: ${quote(path)}`)
    if (entry.type === 'directory') dirs.add(path)
    else if (entry.type === 'symlink') links.set(path, entry.linkname)
    else if (entry.type === 'file') files.set(path, { data: entry.data, mode: entry.mode & 0o100 ? 0o755 : 0o644 })
    else throw new Error(`unreachable: a ${entry.type} in a tarball of a git tree`)
  }
  return { dirs, files, links }
}
