import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, describe, it } from 'node:test'

import { switchesOf } from '../src/babel-switches.js'
import { linked } from './rn-bundle-app.js'
import { writeTree } from './fixtures.js'

const core = createRequire(import.meta.url)('@babel/core')

describe('switchesOf', () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
    'plugins/mark.js': "module.exports = () => ({ name: 'mark', visitor: {} })\n",
  })
  after(cleanup)
  const of = (entries) => switchesOf(core, entries, { cwd: root, root })

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
})
