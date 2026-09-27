import assert from 'node:assert/strict'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isRefName, isSha } from './args.js'
import { githubRepoOfUrl } from './remote.js'

// Which commit a directory on disk is checked out at, where in its
// repository it sits, and — where the checkout says so — which GitHub
// repo that is. Read straight off `.git`, without running git: HEAD, the
// ref it names (loose, or in packed-refs), and one line of the config.
//
// Best-effort throughout, and field by field: anything that is not there,
// or not in the shape git writes it, is a field left out, never a throw.
// Only a `dir` that is not a string throws, being a caller's mistake
// rather than a checkout's.

const read = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

const isDirectory = async (path) => (await stat(path).catch(() => null))?.isDirectory() ?? false

// The closest `.git` at or above `start`: a directory, or a file with a
// `gitdir:` line pointing at one, as a worktree or a submodule has. Then
// the directory the refs and the config live in, which for a worktree is
// the one its `commondir` names.
async function findGitDirs(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    const info = await stat(dotGit).catch(() => null)
    if (info?.isDirectory()) return { root: dir, gitDir: dotGit, commonDir: dotGit }
    if (info?.isFile()) {
      const pointer = /^gitdir: (?<path>.+)$/u.exec((await read(dotGit))?.trim() ?? '')?.groups.path
      if (!pointer) return null
      const gitDir = resolve(dir, pointer)
      if (!await isDirectory(gitDir)) return null
      const common = (await read(join(gitDir, 'commondir')))?.trim()
      return { root: dir, gitDir, commonDir: common ? resolve(gitDir, common) : gitDir }
    }
    if (dirname(dir) === dir) return null
  }
}

// HEAD's commit: HEAD itself when detached, else the ref it names — its
// loose file, or its line in packed-refs. The ref is held to git's own
// name rules and to `refs/` before it is joined to a path, so a HEAD that
// says `ref: ../../somewhere` reads nothing outside the git directory.
async function headCommit(gitDir, commonDir) {
  const head = (await read(join(gitDir, 'HEAD')))?.trim()
  if (isSha(head)) return head
  const ref = /^ref: (?<ref>refs\/\S+)$/u.exec(head ?? '')?.groups.ref
  if (!isRefName(ref)) return null
  const loose = (await read(join(commonDir, ...ref.split('/'))))?.trim()
  if (isSha(loose)) return loose
  const packed = await read(join(commonDir, 'packed-refs'))
  for (const line of packed?.split('\n') ?? []) {
    const [sha, name, ...rest] = line.trim().split(' ')
    if (name === ref && rest.length === 0 && isSha(sha)) return sha
  }
  return null
}

// The origin's URL, off exactly the lines git writes for it and nothing
// cleverer: a config written any other way just has no `github`. Only the
// `owner/name` of a GitHub remote comes back out; the URL itself never
// does, since it can name a private host or carry a token.
const ORIGIN = '[remote "origin"]\n\turl = '

async function originGitHub(commonDir) {
  const config = await read(join(commonDir, 'config'))
  const at = config?.indexOf(ORIGIN) ?? -1
  if (at === -1) return undefined
  const url = config.slice(at + ORIGIN.length).split('\n')[0].trim()
  return githubRepoOfUrl(url)
}

// `{ github?, directory?, url?, commit? }` for the checkout `dir` is in,
// the shape getRepo (package.js) answers in: `github` is `owner/name` and
// `url` its page when the origin remote is a GitHub one; `directory` is
// where `dir` sits in the checkout, `/`-separated, absent at its root;
// `commit` is HEAD's. Empty where there is no checkout above `dir`.
export async function findGitCheckout(dir) {
  assert.ok(typeof dir === 'string' && dir !== '', `findGitCheckout: dir must be a directory path, got ${typeof dir === 'string' ? '""' : typeof dir}`)
  const start = await realpath(resolve(dir)).catch(() => null)
  if (start === null || !await isDirectory(start)) return {}
  const dirs = await findGitDirs(start)
  if (dirs === null) return {}
  const path = relative(dirs.root, start)
  if (isAbsolute(path) || path.split(sep).includes('..')) return {}
  const directory = path.split(sep).join('/')
  const github = await originGitHub(dirs.commonDir)
  const commit = await headCommit(dirs.gitDir, dirs.commonDir)
  return {
    ...(github && { github }),
    ...(directory && { directory }),
    ...(github && { url: `https://github.com/${github}` }),
    ...(commit && { commit }),
  }
}
