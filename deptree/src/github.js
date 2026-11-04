// A git dependency that a package manager clones, `git clone` and then a
// checkout of one commit, from GitHub's tarball of that commit's tree
// instead: the files a checkout writes, without the .git it clones.

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { HttpError } from '@preventive/upstream/github.js'
import { DeptreeError, quote } from './error.js'
import { isGit } from './soldeer/zip.js'
import { MAX_BYTES } from './tarball.js'

// A GitHub repository as git takes its URL over https and ssh, `.git` after
// it or not, the scheme and host in any case: https://github.com/<repo>,
// ssh://git@github.com/<repo> and git@github.com:<repo>. The owner and name
// are as GitHub takes them.
const REPO = String.raw`(?<repo>(?=[\dA-Za-z-]{1,39}\/)[\dA-Za-z](?:-?[\dA-Za-z])*\/[\w.-]{1,100}?)(?:\.git)?`
const URL_FORM = new RegExp(String.raw`^(?:(?i:https):\/\/|(?i:ssh):\/\/git@)(?i:github\.com)\/${REPO}\/?$`, 'u')
const SCP_FORM = new RegExp(String.raw`^git@(?i:github\.com):${REPO}$`, 'u')

export function githubRepoOf(url) {
  const repo = (URL_FORM.exec(url) ?? SCP_FORM.exec(url))?.groups.repo
  return repo === undefined || /\/\.\.?$/u.test(repo) ? undefined : repo
}

const isRedirect = (error) => error instanceof HttpError && error.status >= 300 && error.status < 400

// A repository renamed or transferred since it was named, which GitHub
// answers with a redirect that git's clone follows, is asked for by the
// name GitHub gives it now, as upstream's getRepo follows the redirect;
// any other redirect is refused there.
async function followingMoves(github, repo, ask) {
  try {
    return await ask(repo)
  } catch (error) {
    if (!isRedirect(error)) throw error
    const moved = await github.getRepo({ repo, followRedirect: true })
    return await ask(moved.full_name)
  }
}

// The commit that `git clone --branch <tag>` checks out: a branch of that
// name before a tag, which is refused, as the branch can move; else the
// commit the tag names, through an annotated one. GitHub answers for the
// repository as it is now: the tag is held to no hash.
export async function tagCommit(github, repo, tag, where) {
  // `@`, and a name that starts with `-`, no branch can have.
  const branchName = !/^(?:@$|-)/u.test(tag)
  return await followingMoves(github, repo, async (name) => {
    const branch = branchName && await github.getRepoHead({ repo: name, branch: tag }).catch((error) => {
      if (error instanceof HttpError && error.status === 404) return undefined
      throw error
    })
    if (branch) throw new DeptreeError(`${quote(name)} has a branch named ${quote(tag)} as well as the tag, which git's clone takes before the tag`, where)
    return (await github.getRepoTag({ repo: name, tag })).oid
  })
}

// GitHub's tarball, which upstream holds to the tree GitHub names for the
// commit, files, symlinks and the submodules it shows as empty directories
// alike. Unpacked as a checkout with umask 0o022 writes it: directories
// 0o755, files 0o644 or 0o755 by the bit git keeps, symlinks as symlinks.
export async function checkoutOf(github, repo, rev, where) {
  const bytes = await followingMoves(github, repo, (name) => github.getRepoTarball({ repo: name, sha: rev }))
  let entries
  try {
    entries = unpack(await decompress(bytes, 'gzip', { limit: MAX_BYTES }))
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`its tarball from GitHub cannot be read: ${error.message}`, where, { cause: error })
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
    if (path.split('/').some(isGit)) throw new DeptreeError('a path with a .git in it, which git refuses to check out', `${where}: ${quote(path)}`)
    if (entry.type === 'directory') dirs.add(path)
    else if (entry.type === 'symlink') links.set(path, entry.linkname)
    else if (entry.type === 'file') files.set(path, { data: entry.data, mode: entry.mode & 0o100 ? 0o755 : 0o644 })
    else throw new Error(`unreachable: a ${entry.type} in a tarball of a git tree`)
  }
  return { dirs, files, links }
}
