import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'

// Where there is no npm beside node, as in a bundled serverless function,
// semver is the `semver` package itself, an optional peer dependency. It is
// not installed here, so a process of its own finds npm's copy of it by
// NODE_PATH, as it would find the peer, with its binary not named node so
// that the npm beside it is not looked for.
const NODE_PATH = resolve(dirname(process.argv[0]), '../lib/node_modules/npm/node_modules')

const run = (setup, source) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
  ${setup}
  process.argv[0] = '/nowhere/not-node'
  const semver = await import(${JSON.stringify(new URL('../semver.js', import.meta.url).href)})
  process.stdout.write(JSON.stringify(${source}))
`], { encoding: 'utf8', env: { ...process.env, NODE_PATH } }))

const CALLS = `[
  semver.satisfies('4.17.20', '<4.17.21'),
  semver.satisfies('4.17.20-rc.1', '<4.17.21', { includePrerelease: true }),
  semver.compareVersions('1.9.0', '1.10.0'),
  semver.valid('v1.2.3'),
  semver.isExactVersion('1.2.3-rc.1'),
  semver.validRange('^1.2.0'),
  semver.intersects('^1.2.0', '^2.0.0'),
  semver.clean(' =v1.2.3 '),
  semver.major('v12.3.4', true),
]`
const ANSWERS = [true, true, -1, '1.2.3', true, '>=1.2.0 <2.0.0-0', false, '1.2.3', 12]

// What an ESM bundle that leaves semver out makes of the plain require():
// esbuild's stub, which throws.
const STUB = `
  const { registerHooks } = await import('node:module')
  registerHooks({
    load: (url, context, next) => (url.endsWith('/src/semver-peer.cjs')
      ? { format: 'commonjs', source: 'module.exports = () => { throw new Error(\\'Dynamic require of "semver" is not supported\\') }', shortCircuit: true }
      : next(url, context)),
  })
`

describe('without npm beside node, with the semver peer', () => {
  it('answers as semver does', () => {
    assert.deepEqual(run('', CALLS), ANSWERS)
  })

  it('answers so too where the plain require() is a bundle stub that throws', () => {
    assert.deepEqual(run(STUB, CALLS), ANSWERS)
  })
})
