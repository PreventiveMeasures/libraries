// git's own config reader as the reference: each document written to a
// file of its own and read by `git config --file <it> --null --list`, all
// in one shell. Each comes back as { entries }, its keys in order, each
// `[name, value]` with null for a key alone, or { error } where git refuses
// it; undefined where there is no git.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = 'i=0; while [ "$i" -lt "$1" ]; do if git config --file "$i" --null --list; then printf "\\001ok\\000"; else printf "\\001error\\000"; fi; i=$((i + 1)); done'

export const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

export function gitConfig(texts) {
  if (!hasGit) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-gitconfig-'))
  try {
    for (const [index, text] of texts.entries()) writeFileSync(join(dir, String(index)), text)
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }
    const { stdout, status } = spawnSync('sh', ['-c', SCRIPT, 'sh', String(texts.length)], { cwd: dir, env, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
    if (status !== 0) throw new Error(`the shell running git config exited with ${status}`)
    const results = []
    let entries = []
    for (const item of stdout.toString('utf8').split('\0').slice(0, -1)) {
      if (item.startsWith('\u0001')) {
        results.push(item === '\u0001ok' ? { entries } : { error: true })
        entries = []
        continue
      }
      const end = item.indexOf('\n')
      entries.push(end === -1 ? [item, null] : [item.slice(0, end), item.slice(end + 1)])
    }
    if (results.length !== texts.length) throw new Error(`git config read ${results.length} documents of ${texts.length}`)
    return results
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
