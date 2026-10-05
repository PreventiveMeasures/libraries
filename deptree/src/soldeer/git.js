// A git dependency as Soldeer 0.12 installs it, `git clone` and then `git
// checkout` of the lockfile's rev, from GitHub's tarball of that commit's
// tree instead: the files a checkout writes, without the .git it clones.

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { DeptreeError, quote } from '../error.js'
import { MAX_BYTES } from '../tarball.js'
import { isGit } from './zip.js'

// A GitHub repository as git takes its URL over the protocols Soldeer has
// it allow, https and ssh, `.git` after it or not, the scheme and host in
// any case: https://github.com/<repo>, ssh://git@github.com/<repo> and
// git@github.com:<repo>. The owner and name are as GitHub takes them.
const REPO = String.raw`(?<repo>(?=[\dA-Za-z-]{1,39}\/)[\dA-Za-z](?:-?[\dA-Za-z])*\/[\w.-]{1,100}?)(?:\.git)?`
const URL_FORM = new RegExp(String.raw`^(?:(?i:https):\/\/|(?i:ssh):\/\/git@)(?i:github\.com)\/${REPO}\/?$`, 'u')
const SCP_FORM = new RegExp(String.raw`^git@(?i:github\.com):${REPO}$`, 'u')

export function githubRepoOf(url) {
  const repo = (URL_FORM.exec(url) ?? SCP_FORM.exec(url))?.groups.repo
  return repo === undefined || /\/\.\.?$/u.test(repo) ? undefined : repo
}

// GitHub's tarball, which upstream holds to the tree GitHub names for the
// commit, files, symlinks and the submodules it shows as empty directories
// alike. Unpacked as a checkout with umask 0o022 writes it: directories
// 0o755, files 0o644 or 0o755 by the bit git keeps, symlinks as symlinks.
export async function checkoutOf(github, repo, rev, where) {
  const bytes = await github.getRepoTarball({ repo, sha: rev })
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
