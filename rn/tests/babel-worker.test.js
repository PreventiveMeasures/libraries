import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { babelWorkers, newProfile, profileReport } from '../src/babel-worker.js'
import { writeTree } from './fixtures.js'

const CORE = fileURLToPath(import.meta.resolve('@babel/core'))

describe('babelWorkers', () => {
  const { root, cleanup } = writeTree({
    'broken.cjs': "throw new Error('broken core')\n",
    'mark.cjs': "module.exports = ({ types: t }) => ({ name: 'mark', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral('marked'))) } } } })\n",
  })
  after(cleanup)

  it('transforms in a worker, by the @babel/core given, failing with its errors', async () => {
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false })
    const files = await Promise.all(['a', 'b', 'c'].map((name) => transform(`const ${name} = 1 ?? 2`, join(root, `${name}.js`))))
    assert.deepEqual(files, ['const a = 1 ?? 2;', 'const b = 1 ?? 2;', 'const c = 1 ?? 2;'])
    await assert.rejects(transform('const a = (b: ) => 1', join(root, 'bad.js')), /bad\.js: Unexpected token/u)
  })

  it("leaves out the config's plugins of the keys it is given", async () => {
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false, plugins: [join(root, 'mark.cjs')] })
    assert.equal(await transform('a()', join(root, 'a.js')), 'a();\n"marked";')
    assert.equal(await transform('a()', join(root, 'a.js'), ['mark']), 'a();')
    assert.equal(await transform('a()', join(root, 'a.js'), ['other']), 'a();\n"marked";')
  })

  it('adds to a profile the time of each transform, and of each plugin: its files and visitor calls', async () => {
    const profile = newProfile()
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false, plugins: [join(root, 'mark.cjs')] }, profile)
    assert.equal(await transform('a()', join(root, 'a.js')), 'a();\n"marked";')
    assert.equal(await transform('b()', join(root, 'b.js'), ['mark']), 'b();')
    assert.equal(profile.files, 2)
    const { files, calls, ms } = profile.plugins.get('mark')
    assert.deepEqual([files, calls], [1, 1])
    assert.ok(ms > 0 && profile.ms > ms)
  })

  it('reports a profile, most time first, with that outside the plugins', () => {
    const plugins = new Map([['/app/node_modules/preset/index.js$0', { files: 1, calls: 1, ms: 1 }], ['transform-x', { files: 2, calls: 30, ms: 6 }]])
    assert.equal(
      profileReport({ files: 2, ms: 10, plugins }, '/app'),
      [
        'Babel: 2 files, 10 ms, summed over its workers',
        '      ms       %    files      calls  plugin',
        '       6    60.0        2         30  transform-x',
        '       1    10.0        1          1  node_modules/preset/index.js$0',
        '       3    30.0                      outside plugins: config, parsing, traversal, printing',
        '',
      ].join('\n'),
    )
  })

  it('fails each transform of a worker that dies, none left waiting', { timeout: 10_000 }, async () => {
    const transform = babelWorkers(join(root, 'broken.cjs'), {})
    for (const name of ['a', 'b', 'c']) await assert.rejects(transform('x', join(root, `${name}.js`)), /broken core/u)
  })
})
