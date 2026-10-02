// Composer as the reference, run by reference.php in one PHP process over
// every case. COMPOSER_PHAR names the phar, or else the `composer` on PATH
// is taken for one, as it is where installed from getcomposer.org; PHP
// names the interpreter, php by default. undefined comes back where
// either is missing.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('reference.php', import.meta.url))

function findPhar() {
  if (process.env.COMPOSER_PHAR !== undefined) return process.env.COMPOSER_PHAR
  const which = spawnSync('which', ['composer'], { encoding: 'utf8' })
  if (which.status !== 0) return undefined
  try {
    return realpathSync(which.stdout.trim())
  } catch {
    return undefined
  }
}

const PHAR = findPhar()

// Each case is [kind, ...arguments]; each result { value } or { error }.
export function composer(cases) {
  if (PHAR === undefined) return undefined
  const run = spawnSync(process.env.PHP ?? 'php', ['-d', 'memory_limit=-1', SCRIPT, PHAR], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.error !== undefined || run.status !== 0) return undefined
  return JSON.parse(run.stdout)
}

export const hasComposer = () => composer([['normalize', 'v1.0']])?.[0]?.value === '1.0.0.0'
