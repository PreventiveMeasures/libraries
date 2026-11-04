import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { workletsGate } from '../src/worklets.js'
import { writeTree } from './fixtures.js'

describe("workletsGate, of Reanimated's Babel plugin", () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    // A version's plugin, of a hook this doesn't know of.
    'node_modules/react-native-worklets/plugin/index.js': "const hooks = new Set(['useAnimatedStyle', 'useNewHook'])\nmodule.exports = () => ({ name: 'worklets', visitor: {} })\n",
    'node_modules/react-native-reanimated/plugin/index.js': "module.exports = () => ({ name: 'reanimated', visitor: {} })\n",
  })
  after(cleanup)
  // Of the env Babel and NODE_ENV are of: a release, else not.
  const gate = (envName, NODE_ENV = envName) => {
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = NODE_ENV
    try {
      return workletsGate({ cwd: root, envName })
    } finally {
      if (was === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = was
    }
  }
  const quiet = gate('production')
  const worklets = { key: 'worklets', options: {} }

  it('leaves it out of a file that names nothing it acts on', () => {
    assert.equal(quiet(worklets, "export const a = () => ({ value: 1 })\n"), true)
    assert.equal(quiet({ key: 'reanimated', options: {} }, 'export const a = 1\n'), true)
  })

  it("keeps it where a worklet's directive or marker is, or a name it makes a worklet of the callbacks to, its own too", () => {
    for (const source of ["function f() {\n  'worklet'\n}\n", 'class A {\n  __workletClass = true\n}\n', 'useAnimatedStyle(() => ({}))\n', 'withTiming(1, {}, done)\n', 'Gesture.Pan().onUpdate(update)\n', 'FadeIn.withCallback(done)\n', 'useNewHook(() => 1)\n']) {
      assert.equal(quiet(worklets, source), false, source)
    }
  })

  it('keeps it with its options of the web or of a bundle of worklets, and any plugin but its own', () => {
    assert.equal(quiet({ key: 'worklets', options: { substituteWebPlatformChecks: true } }, 'export const a = 1\n'), false)
    assert.equal(quiet({ key: 'worklets', options: { bundleMode: true } }, 'export const a = 1\n'), false)
    assert.equal(quiet({ key: 'transform-classes', options: {} }, 'export const a = 1\n'), false)
  })

  it("keeps it, but in a release, where a shared value's `.value` may be read in a style, which it warns of", () => {
    const source = 'export const A = () => <View style={{ width: width.value }} />\n'
    assert.equal(quiet(worklets, source), true)
    assert.equal(gate('development')(worklets, source), false)
    assert.equal(gate('production', 'development')(worklets, source), false)
    assert.equal(gate('development')({ key: 'worklets', options: { disableInlineStylesWarning: true } }, source), true)
    // However the member is spaced or commented.
    for (const spaced of ['width. value', 'width./* a */value', 'width.\n  value']) assert.equal(gate('development')(worklets, `<View style={{ width: ${spaced} }} />\n`), false, spaced)
  })

  it("keeps it where the plugin's code can't be read", () => {
    assert.equal(workletsGate({ cwd: '/nowhere', envName: 'production' })(worklets, 'export const a = 1\n'), false)
  })

  it("reads the plugin's code Babel loaded, from wherever, though the project resolves none", () => {
    // As a preset's own, or that of a config elsewhere.
    const elsewhere = writeTree({ 'node_modules/react-native-worklets/plugin/index.js': "const hooks = ['useOtherHook']\nmodule.exports = () => ({ name: 'worklets', visitor: {} })\n" })
    const modules = createRequire(import.meta.url).cache
    const before = new Set(Object.keys(modules))
    try {
      createRequire(join(elsewhere.root, 'package.json'))('react-native-worklets/plugin')
      const loaded = workletsGate({ cwd: '/nowhere', envName: 'production' })
      assert.equal(loaded(worklets, 'export const a = 1\n'), true)
      assert.equal(loaded(worklets, 'useOtherHook(() => 1)\n'), false)
    } finally {
      for (const path of Object.keys(modules)) if (!before.has(path)) delete modules[path]
      elsewhere.cleanup()
    }
  })
})
