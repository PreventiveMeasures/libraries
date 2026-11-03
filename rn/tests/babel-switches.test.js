import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { switchesOf } from '../src/babel-switches.js'
import { transformerOf } from '../src/babel-transformer.js'
import { linked } from './rn-bundle-app.js'
import { writeTree } from './fixtures.js'

const core = createRequire(import.meta.url)('@babel/core')

describe('switchesOf', () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
    'plugins/mark.js': "module.exports = () => ({ name: 'mark', visitor: {} })\n",
    // A plugin that throws without its options, as @babel/plugin-proposal-decorators does of no version.
    'plugins/needs.js': "module.exports = (api, options) => {\n  if (options.version === undefined) throw new Error('needs a version')\n  return { name: 'needs', visitor: {} }\n}\n",
    // A plugin that reads a file as Babel loads it.
    'plugins/reads.js': "require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'data.txt'))\nmodule.exports = () => ({ name: 'reads', visitor: {} })\n",
    'data.txt': 'data',
    'babel.config.js': "module.exports = { plugins: [['./plugins/needs.js', { version: 1 }]] }\n",
  })
  after(cleanup)
  const config = { cwd: root, root, filename: join(root, 'index.js') }
  const of = (entries) => switchesOf(core, entries, { cwd: root, root }, config)

  it('names each plugin by the key Babel gives it, of its package, a path, or the key alone', () => {
    const { off, on, added } = of([['@babel/plugin-transform-react-jsx', false], ['./plugins/mark.js', true], ['transform-classes', true]])
    assert.deepEqual([[...off], [...on]], [['transform-react-jsx'], ['mark', 'transform-classes']])
    assert.deepEqual(added.map(({ key, name, plugin }) => [key, name, plugin?.key ?? null]), [['mark', './plugins/mark.js', 'mark'], ['transform-classes', 'transform-classes', null]])
  })

  it('takes the later of a plugin named twice, as its key and as its package, in its place', () => {
    const { off, on, added } = of([['transform-react-jsx', true], ['./plugins/mark.js', true], ['@babel/plugin-transform-react-jsx', false]])
    assert.deepEqual([[...off], [...on], added.map(({ key }) => key)], [['transform-react-jsx'], ['mark'], ['mark']])
    assert.deepEqual(of([['@babel/plugin-transform-react-jsx', false], ['transform-react-jsx', true]]).added.map(({ key, plugin }) => [key, plugin]), [['transform-react-jsx', null]])
  })

  it("takes a plugin that needs its options as the Babel config has it, of them; else fails, of no key", () => {
    const { off, errors } = of([['./plugins/needs.js', false]])
    assert.deepEqual([[...off], errors], [['needs'], []])
    const bare = switchesOf(core, [['./plugins/needs.js', false]], { cwd: root, root }, { ...config, configFile: false })
    assert.deepEqual([...bare.off], ['./plugins/needs.js'])
    assert.deepEqual(bare.errors, ["rn.config.json's babel names ./plugins/needs.js, which Babel can't load without its options (needs a version), and the Babel config has no plugin of it to take them from: name it by its key, as --profile shows it"])
  })
})

describe("Babel's workers, of plugins switched on", () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'plugins/reads.js': "require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'data.txt'))\nmodule.exports = () => ({ name: 'reads', visitor: {} })\n",
    'data.txt': 'data',
  })
  after(cleanup)

  it("have the fingerprint of the files a plugin added reads as Babel loads it, as of the config's", () => {
    const { fingerprint } = transformerOf({ corePath: createRequire(import.meta.url).resolve('@babel/core'), options: { cwd: root, root, babelrc: false, configFile: false, fingerprint: true, switches: [['./plugins/reads.js', true]] }, profile: false })
    assert.ok(fingerprint.reads.some(([path]) => path === join(root, 'data.txt')), JSON.stringify(fingerprint.reads))
  })
})
