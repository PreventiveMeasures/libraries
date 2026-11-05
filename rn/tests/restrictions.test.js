import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { globRegExp, moduleOf, packagesOf, restrictionsOf } from '../src/restrictions.js'

describe('globRegExp', () => {
  const matches = (glob, path) => globRegExp(glob).test(path)

  it('has ** any path, dot files too, * and ? any characters and any one of a name', () => {
    for (const path of ['node_modules/a/b.js', 'node_modules/.pnpm/a@1/node_modules/a/b.js', 'node_modules/.bin']) assert.ok(matches('node_modules/**', path), path)
    assert.ok(!matches('node_modules/**', 'src/node_modules.js'))
    assert.ok(matches('src/**/x.js', 'src/x.js'))
    assert.ok(matches('src/**/x.js', 'src/a/.b/x.js'))
    assert.ok(matches('src/*.js', 'src/a.js'))
    assert.ok(!matches('src/*.js', 'src/a/b.js'))
    assert.ok(matches('src/?.js', 'src/a.js'))
    assert.ok(!matches('src/?.js', 'src/ab.js'))
    assert.ok(matches('../shared/**', '../shared/a.js'))
  })

  it('has {a,b} either, and the rest as it is', () => {
    assert.ok(matches('src/**/*.{ts,tsx}', 'src/a/b.tsx'))
    assert.ok(!matches('src/**/*.{ts,tsx}', 'src/a/b.js'))
    assert.ok(matches('{src,lib}/{a,b{1,2}}.js', 'lib/b2.js'))
    assert.ok(matches('app/[id]/(group)+.js', 'app/[id]/(group)+.js'))
    assert.ok(!matches('app/[id].js', 'app/i.js'))
    assert.ok(matches('a,b.js', 'a,b.js'))
  })

  it('takes a leading ./ for the project root, and is null of braces that do not pair', () => {
    assert.ok(matches('./src/**', 'src/a.js'))
    for (const glob of ['src/{a,b', 'src/a}', '}{']) assert.equal(globRegExp(glob), null, glob)
  })
})

describe('moduleOf', () => {
  it('is the package of the innermost node_modules directory of a path', () => {
    assert.equal(moduleOf('node_modules/react/index.js'), 'react')
    assert.equal(moduleOf('node_modules/@react-native/js-polyfills/console.js'), '@react-native/js-polyfills')
    assert.equal(moduleOf('node_modules/a/node_modules/b/index.js'), 'b')
    assert.equal(moduleOf('node_modules/.pnpm/@scope+a@1.0.0/node_modules/@scope/a/index.js'), '@scope/a')
    assert.equal(moduleOf('../../node_modules/react/index.js'), 'react')
    assert.equal(moduleOf('node_modules/loose.js'), 'loose.js')
  })

  it('is null of a path in none: the project, a workspace package', () => {
    for (const path of ['index.js', 'src/node_modules.js', '../packages/ui/index.js']) assert.equal(moduleOf(path), null, path)
  })
})

// package.json files, by path, as a host has them.
const hostOf = (manifests) => ({ isFile: (path) => Object.hasOwn(manifests, path), readFile: (path) => manifests[path] })
const MANIFESTS = {
  '/app/package.json': JSON.stringify({ name: 'app' }),
  // A package.json of no name, as one setting `type` for a directory: not a package's.
  '/app/src/legacy/package.json': JSON.stringify({ type: 'module' }),
  '/app/src/broken/package.json': '{',
  '/ws/ui/package.json': JSON.stringify({ name: '@org/ui' }),
  '/app/node_modules/rxjs/operators/package.json': JSON.stringify({ name: 'rxjs/operators' }),
}

describe('packagesOf', () => {
  const packageOf = packagesOf(hostOf(MANIFESTS))

  it('is the package of the nearest package.json that names one, but in node_modules, where it is that directory\'s', () => {
    assert.equal(packageOf('/app/index.js'), 'app')
    assert.equal(packageOf('/app/src/legacy/old.js'), 'app')
    assert.equal(packageOf('/app/src/broken/x.js'), 'app')
    assert.equal(packageOf('/ws/ui/src/Button.js'), '@org/ui')
    assert.equal(packageOf('/app/node_modules/rxjs/operators/index.js'), 'rxjs')
    assert.equal(packageOf('/loose/x.js'), null)
  })

  it('reads each package.json once', () => {
    const read = []
    const counting = packagesOf({ ...hostOf(MANIFESTS), readFile: (path) => (read.push(path), MANIFESTS[path]) })
    for (const path of ['/app/a.js', '/app/src/b.js', '/app/src/legacy/c.js', '/app/src/legacy/d.js']) counting(path)
    assert.deepEqual(read, ['/app/package.json', '/app/src/legacy/package.json'])
  })
})

describe('restrictionsOf', () => {
  const root = '/app'
  const FILES = ['index.js', 'src/a.js', 'src/legacy/b.js', '../ws/ui/index.js', '../loose/x.js', 'node_modules/react/index.js', 'node_modules/moment/moment.js', 'node_modules/@scope/ui/index.js', 'node_modules/@react-native/js-polyfills/console.js', 'node_modules/.pnpm/lodash@4/node_modules/lodash/lodash.js']
  const RULES = {
    allowedPaths: ['index.js', 'src/**', 'node_modules/**'],
    disallowedPaths: ['src/legacy/**', '**/moment.js'],
    allowedModules: ['app', 'react', '@scope/*', '@react-native/*', 'moment'],
    disallowedModules: ['moment', 'lodash', '@scope/{ui,x}'],
  }
  const packageOf = packagesOf(hostOf(MANIFESTS))
  const errorsOf = (config) => {
    const restrict = restrictionsOf(config, root)
    return Object.fromEntries(FILES.map((name) => [name, restrict(join(root, name), packageOf(join(root, name)))]))
  }

  it('is null where the config sets none', () => {
    assert.equal(restrictionsOf({}, root), null)
    assert.equal(restrictionsOf({ esm: true }, root), null)
  })

  it('has an error of each rule a file breaks', () => {
    assert.deepEqual(errorsOf({ allowedPaths: ['src/*.js'] })['src/legacy/b.js'], ["src/legacy/b.js matches none of rn.config.json's allowedPaths"])
    assert.deepEqual(errorsOf({ disallowedPaths: ['src/legacy/**'] })['src/legacy/b.js'], [`src/legacy/b.js matches "src/legacy/**" of rn.config.json's disallowedPaths`])
    assert.deepEqual(errorsOf({ allowedModules: ['react'] })['node_modules/@scope/ui/index.js'], ["node_modules/@scope/ui/index.js is of @scope/ui, which matches none of rn.config.json's allowedModules"])
    assert.deepEqual(errorsOf({ disallowedModules: ['lodash'] })['node_modules/.pnpm/lodash@4/node_modules/lodash/lodash.js'], [`node_modules/.pnpm/lodash@4/node_modules/lodash/lodash.js is of lodash, which matches "lodash" of rn.config.json's disallowedModules`])
    assert.deepEqual(errorsOf(RULES)['node_modules/moment/moment.js'], [
      `node_modules/moment/moment.js matches "**/moment.js" of rn.config.json's disallowedPaths`,
      `node_modules/moment/moment.js is of moment, which matches "moment" of rn.config.json's disallowedModules`,
    ])
  })

  it("takes globs of packages' names: * any of a scope's", () => {
    const errors = errorsOf({ allowedModules: ['app', '@react-native/*', 'react*'] })
    assert.deepEqual(Object.keys(errors).filter((name) => errors[name].length === 0), ['index.js', 'src/a.js', 'src/legacy/b.js', 'node_modules/react/index.js', 'node_modules/@react-native/js-polyfills/console.js'])
  })

  it("has allowedModules forbid any package it doesn't match, the project's and a workspace package's too, and a file of none", () => {
    const errors = errorsOf({ allowedModules: ['react'] })
    assert.deepEqual(errors['src/a.js'], ["src/a.js is of app, which matches none of rn.config.json's allowedModules"])
    assert.deepEqual(errors['../ws/ui/index.js'], ["../ws/ui/index.js is of @org/ui, which matches none of rn.config.json's allowedModules"])
    assert.deepEqual(errors['../loose/x.js'], ["../loose/x.js is of no package (no package.json above it has a name), which rn.config.json's allowedModules allows none of"])
    assert.deepEqual(errorsOf({ disallowedModules: ['app'] })['src/a.js'], [`src/a.js is of app, which matches "app" of rn.config.json's disallowedModules`])
    assert.deepEqual(errorsOf({ disallowedModules: ['*'] })['../loose/x.js'], [])
  })

  it('checks each rule on its own: rules together forbid what each forbids alone, and only that', () => {
    const together = errorsOf(RULES)
    const alone = Object.entries(RULES).map(([key, list]) => errorsOf({ [key]: list }))
    for (const name of FILES) assert.deepEqual(together[name], alone.flatMap((errors) => errors[name]), name)
    assert.deepEqual(Object.keys(together).filter((name) => together[name].length === 0), ['index.js', 'src/a.js', 'node_modules/react/index.js', 'node_modules/@react-native/js-polyfills/console.js'])
  })
})
