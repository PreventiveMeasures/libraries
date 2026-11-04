import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { printed, writeTree } from './fixtures.js'
import { linked } from './rn-bundle-app.js'

it('rn-bundle enables no disk compile cache in the main process or its Babel workers', () => {
  const { root, cleanup } = writeTree({
    'index.js': "console.log('built without a disk cache')\n",
    'babel.config.cjs': [
      "if (require('node:module').getCompileCacheDir() !== undefined) throw new Error('disk compile cache is enabled')",
      'module.exports = {}',
      '',
    ].join('\n'),
    'node_modules/@babel/core': linked('@babel/core'),
  })
  // Do not externally enable or disable Node's cache: this checks rn-bundle's own policy.
  const env = { ...process.env }
  delete env.NODE_COMPILE_CACHE
  delete env.NODE_DISABLE_COMPILE_CACHE
  try {
    // --self-test's second build always uses a worker, even for this single module.
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/rn-bundle.js', import.meta.url)), '--platform=ios', '--output=out.js', '--self-test', 'index.js'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(printed(join(root, 'out.js')), 'built without a disk cache\n')
    assert.match(result.stderr, /each of 1 modules is as Babel makes it/u)
  } finally {
    cleanup()
  }
})
