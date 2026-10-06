import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getWeakEdge, weakEdges } from '@preventive/upstream/weak-edges.js'

const file = (pkg, path, ownSource) => ({ package: pkg, path, ...(ownSource === undefined ? {} : { ownSource }) })
const codegen = file('react-native', 'scripts/codegen/generate-artifacts-executor.js')
const config = file('react-native', 'react-native.config.js')
const release = file('@react-native-community/cli-tools', 'build/releaseChecker/index.js')
const babel = file('@babel/core', 'lib/config/files/module-types.js')
const plugins = file('@babel/core', 'lib/config/files/plugins.js')
const cosmiconfig = file('cosmiconfig', 'dist/loaders.js')
const fresh = file('import-fresh', 'index.js')

const observed = [
  ['react-native-codegen-discovery', codegen, file('react-native-shimmer', 'package.json')],
  ['react-native-codegen-discovery', codegen, file('react-native-shimmer', 'react-native.config.js')],
  ['react-native-codegen-discovery', codegen, file(undefined, 'tools/package.json', true)],
  ['react-native-release-version', release, file('react-native', 'package.json')],
  ['react-native-platform-config', config, file('@react-native-community/cli-platform-android', 'build/index.js')],
  ['react-native-platform-config', config, file('@react-native-community/cli-platform-ios', 'build/index.js')],
  ['babel-project-config', babel, file(undefined, 'babel.config.js', true)],
  ['babel-project-config', file('@babel/core', 'lib/config/index.js'), file('plugin', 'tools/babel.config.js')],
  ['babel-typescript-preset', babel, file('@babel/preset-typescript', 'lib/index.js')],
  ['babel-typescript-preset', plugins, file('@babel/preset-typescript', 'lib/index.js')],
  ['babel-typescript-preset', file('@babel/core', 'lib/config/helpers/deep.js'), file('@babel/preset-typescript', 'lib/helpers.js')],
  ['babel-react-native-preset', babel, file('@react-native/babel-preset', 'index.js')],
  ['babel-react-native-preset', plugins, file('@react-native/babel-preset', 'src/index.js')],
  ['babel-reanimated-plugin', babel, file('react-native-reanimated', 'plugin/index.js')],
  ['babel-reanimated-plugin', plugins, file('@org/react-native-reanimated', 'plugin/index.js')],
  ...['template-literals', 'shorthand-properties', 'nullish-coalescing-operator', 'export-namespace-from', 'typescript']
    .flatMap(name => [babel, plugins].map(from => ['babel-transform-plugin', from, file(`@babel/plugin-transform-${name}`, 'lib/index.js')])),
  ['cosmiconfig-config', cosmiconfig, file(undefined, 'metro.config.js', true)],
  ['cosmiconfig-config', cosmiconfig, file('react-native', 'react-native.config.js', false)],
  ['cosmiconfig-config', cosmiconfig, file('workspace-tool', 'tools/lint.config.js', false)],
  ['import-fresh-own-config', fresh, file(undefined, 'tools/metro.config.js', true)],
  ['import-fresh-own-config', file('import-fresh', 'dist/index.js'), file('app', 'dependencies/foo.config.js', true)],
]

test('the published catalog covers every observed weak-edge family and explains each match', () => {
  assert.equal(new Set(weakEdges.map(rule => rule.id)).size, weakEdges.length)
  const covered = new Set()
  for (const [id, from, to] of observed) {
    const before = structuredClone({ from, to })
    const rule = getWeakEdge(from, to)
    assert.equal(rule?.id, id, `${from.package}/${from.path} -> ${to.package}/${to.path}`)
    assert.ok(rule.reason.length > 0)
    assert.ok(weakEdges.includes(rule))
    assert.deepEqual({ from, to }, before)
    covered.add(id)
  }
  assert.deepEqual(covered, new Set(weakEdges.map(rule => rule.id)))
})

test('other files, package lookalikes, and ordinary plugin imports remain eligible', () => {
  for (const [from, to] of [
    [codegen, file('dep', 'not-package.json')], [codegen, file('dep', 'react-native.config.js.bak')],
    [file('react-native', 'scripts/codegen/other.js'), file('dep', 'package.json')],
    [release, file('other', 'package.json')], [release, file('react-native', 'index.js')],
    [file('@react-native-community/cli-tools', 'build/releaseChecker/index.js.bak'), file('react-native', 'package.json')],
    [file(undefined, 'react-native.config.js', true), file('@react-native-community/cli-platform-ios', 'build/index.js')],
    [config, file('@react-native-community/cli-platform-apple', 'build/index.js')],
    [config, file('@react-native-community/cli-platform-ios', 'build/helper.js')],
    [file('react-native', 'index.js'), file('@react-native-community/cli-platform-ios', 'build/index.js')],
    [file('@babel/core', 'lib/index.js'), file('@babel/preset-typescript', 'lib/index.js')],
    [file('@babel/core', 'lib/config-other/index.js'), file('@babel/preset-typescript', 'lib/index.js')],
    [babel, file('@babel/preset-typescript-other', 'lib/index.js')], [babel, file('@other/preset-typescript', 'lib/index.js')],
    [babel, file('@babel/preset-env', 'lib/index.js')], [babel, file('@babel/plugin-syntax-typescript', 'lib/index.js')],
    [babel, file('@babel/plugin-transform-typescript', 'lib/helpers.js')],
    [babel, file('@other/plugin-transform-typescript', 'lib/index.js')], [babel, file('@babel/plugin-transform-', 'lib/index.js')],
    [file('@babel/core', 'lib/config/index.js'), file('@babel/plugin-transform-typescript', 'lib/index.js')],
    [babel, file('@react-native/babel-preset', 'src/helpers.js')], [plugins, file('@org/react-native-reanimated-other', 'plugin/index.js')],
    [cosmiconfig, file('react-native', 'index.js')], [cosmiconfig, file('react-native', 'react-native.config.js.bak')],
    [cosmiconfig, file('react-native', 'react-native.config.cjs')], [cosmiconfig, file('react-native', 'config.js')],
    [file('cosmiconfig', 'dist/index.js'), file('react-native', 'react-native.config.js')],
  ]) assert.equal(getWeakEdge(from, to), undefined, `${from.package}/${from.path} -> ${to.package}/${to.path}`)
  for (const [, from, to] of observed) {
    assert.equal(getWeakEdge({ ...from, package: `${from.package}-other` }, to), undefined)
    assert.equal(getWeakEdge({ ...from, ownSource: true }, to), undefined, 'an own-source package-name collision is not an installed loader')
  }
})

test('own-source targets only match package-agnostic discovery rules', () => {
  for (const [id, from, to] of observed) {
    const rule = weakEdges.find(entry => entry.id === id)
    const ownTarget = { ...to, ownSource: true }
    const expected = rule.to.package === undefined ? id : undefined
    assert.equal(getWeakEdge(from, ownTarget)?.id, expected, `${id}: ${to.package}/${to.path}`)
  }
})

test('import-fresh uses affirmative per-file ownership, including colliding package display names', () => {
  for (const ownSource of [undefined, false]) {
    assert.equal(getWeakEdge(fresh, file('react-native', 'react-native.config.js', ownSource)), undefined)
    assert.equal(getWeakEdge(fresh, file(undefined, 'metro.config.js', ownSource)), undefined)
  }
  assert.equal(getWeakEdge(fresh, file('tools', 'metro.config.js', true))?.id, 'import-fresh-own-config')
  assert.equal(getWeakEdge(fresh, file('tools', 'metro.config.js', false)), undefined)
  assert.equal(getWeakEdge(cosmiconfig, file('tools', 'metro.config.js', false))?.id, 'cosmiconfig-config')
})

test('the matcher requires resolved owners and normalized package-relative paths', () => {
  const target = file('@babel/preset-typescript', 'lib/index.js')
  for (const path of ['', '/lib/config/index.js', './lib/config/index.js', 'lib/config/../index.js', 'lib//config/index.js',
    'lib\\config\\index.js', 'C:/lib/config/index.js', 'node_modules/@babel/core/lib/config/index.js',
    'lib/config/node_modules/other/index.js']) {
    assert.equal(getWeakEdge(file('@babel/core', path), target), undefined, path)
  }
  assert.equal(getWeakEdge(babel, file('@babel/preset-typescript', 'node_modules/other/index.js')), undefined)
  assert.equal(getWeakEdge(file('outer', 'node_modules/@babel/core/lib/config/index.js'), target), undefined)
  assert.equal(getWeakEdge(babel, target)?.id, 'babel-typescript-preset', 'a nested installed copy matches once attributed to its real owner')
  assert.equal(getWeakEdge(file(undefined, babel.path), target), undefined, 'a shortened display path does not establish the importer package')
})

test('filtering file edges removes false why paths and cycles without hiding ordinary imports between the same packages', () => {
  const app = file('app', 'index.js', true), preset = file('@babel/preset-typescript', 'lib/index.js')
  const raw = [[app, babel], [babel, preset], [preset, babel]]
  const filter = edges => edges.filter(([from, to]) => !getWeakEdge(from, to))
  const reachable = (edges, start, end) => {
    const pending = [start], seen = new Set([start])
    while (pending.length > 0) {
      const current = pending.pop()
      for (const [from, to] of edges) {
        if (from !== current) continue
        if (to === end) return true
        if (!seen.has(to)) { seen.add(to); pending.push(to) }
      }
    }
    return false
  }
  assert.equal(reachable(raw, app, preset), true)
  assert.equal(reachable(raw, babel, babel), true)
  assert.equal(reachable(filter(raw), app, preset), false, 'the preset has no strong recorded explanation from the app')
  assert.equal(reachable(filter(raw), babel, babel), false, 'the config load cannot close the cycle')
  assert.equal(raw.length, 3, 'raw load records remain available')

  const ordinary = file('@babel/core', 'lib/index.js')
  const mixed = [...raw, [app, ordinary], [ordinary, preset], [preset, ordinary]]
  assert.equal(reachable(filter(mixed), app, preset), true, 'an ordinary import from the same package still explains inclusion')
  assert.equal(reachable(filter(mixed), ordinary, ordinary), true, 'ordinary cycles remain visible')
})
