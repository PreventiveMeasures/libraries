import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { assertDirectoryPath, isRefName, isSha } from './args.js'
import { githubRepoOfUrl } from './remote.js'

const ORIGIN = '[remote "origin"]\n\turl = ' // As git writes it. Only `owner/name` leaves here: the URL may carry a token.
const read = (path) => readFile(path, 'utf8').catch(() => null)
const isDirectory = async (path) => (await stat(path).catch(() => null))?.isDirectory() ?? false

// A `.git` file points at the real git dir (worktrees, submodules), and a
// worktree keeps its refs and config in the dir `commondir` names.
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

async function headCommit(gitDir, commonDir) {
  const head = (await read(join(gitDir, 'HEAD')))?.trim()
  if (isSha(head)) return head
  // Checked before it is joined to a path, so `ref: ../../x` can't read
  // outside the git dir.
  const ref = /^ref: (?<ref>refs\/\S+)$/u.exec(head ?? '')?.groups.ref
  if (!isRefName(ref)) return null
  const loose = (await read(join(commonDir, ...ref.split('/'))))?.trim()
  if (isSha(loose)) return loose
  const lines = (await read(join(commonDir, 'packed-refs')))?.split('\n').map((line) => line.trim().split(' ')) ?? []
  return lines.find(([sha, name, ...rest]) => name === ref && rest.length === 0 && isSha(sha))?.[0] ?? null
}

async function originGitHub(commonDir) {
  const config = `\n${await read(join(commonDir, 'config')) ?? ''}`
  const at = config.indexOf(`\n${ORIGIN}`)
  return at === -1 ? undefined : githubRepoOfUrl(config.slice(at + 1 + ORIGIN.length).split('\n')[0].trim())
}

export async function findGitCheckout(dir) {
  assertDirectoryPath('findGitCheckout', 'dir', dir)
  const start = await realpath(resolve(dir)).catch(() => null)
  const dirs = start && await isDirectory(start) ? await findGitDirs(start) : null
  if (dirs === null) return {}
  const directory = relative(dirs.root, start).split(sep).join('/')
  const github = await originGitHub(dirs.commonDir)
  const commit = await headCommit(dirs.gitDir, dirs.commonDir)
  return { ...(github && { github }), ...(directory && { directory }), ...(github && { url: `https://github.com/${github}` }), ...(commit && { commit }) }
}
