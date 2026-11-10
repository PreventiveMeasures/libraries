import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { globRegExp, installedOf, isPathGlob, packagesOf, restrictionsOf } from '../src/restrictions.js'

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

  it('has ** and a directory match a name holding a line break too', () => {
    for (const glob of ['secrets/**', '**', '**/*.js']) assert.ok(matches(glob, 'secrets/key\n.js'), glob)
    assert.ok(matches('src/**/x.js', 'src/a\nb/x.js'))
    assert.ok(globRegExp('secrets', true).test('secrets/key\n.js'))
  })

  it('has {a,b} either, and ? matches a character no glob may name', () => {
    assert.ok(matches('src/**/*.{ts,tsx}', 'src/a/b.tsx'))
    assert.ok(!matches('src/**/*.{ts,tsx}', 'src/a/b.js'))
    assert.ok(matches('{src,lib}/{a,b1,b2}.js', 'lib/b2.js'))
    assert.ok(matches('app/?group?/+not-found@1.js', 'app/(group)/+not-found@1.js'))
    // A name an object inherits is a name like any other.
    for (const glob of ['constructor', '__proto__', '{toString,hasOwnProperty}']) assert.ok(matches(glob, glob.replace(/^\{(\w+),.*/u, '$1')), glob)
    assert.ok(!matches('__proto__', 'other'))
  })

  it('takes a leading ./ for the project root, drops a trailing /, and is null of braces that do not pair', () => {
    assert.ok(matches('./src/**', 'src/a.js'))
    assert.ok(matches('src/', 'src'))
    for (const glob of ['src/{a,b', 'src/a}', '}{']) assert.equal(globRegExp(glob), null, glob)
  })

  it('is null but of a simple glob: names of letters, digits and _.@+-, *, ?, a whole ** and {a,b} lists, none nested', () => {
    const unsupported = [
      'app/[id].tsx', 'app/[...slug].tsx', 'x]y', 'a[[:digit:]]', 'src\\x', // a class, an escape
      '@(a|b).js', '!(a)', '{@,x}(a)', 'app/(group)/**', 'a$b', 'a b', 'a,b.js', // an extglob, and what one is made of
      'v{1..3}', '{a}', 'x${a,b}', '{{a,b}}', '{a,{b,c}}', '{a,b}}', // a range, a lone or nested brace
      'a**', '**b/c', 'src/a**/b', 'a/***/b', '{**,x}', // a `**` within a name
    ]
    for (const glob of unsupported) assert.equal(globRegExp(glob), null, glob)
    for (const glob of ['app/+not-found.tsx', 'app/?tabs?/**', '**', './**/', 'a/**/b', '{1..3,4}', '@scope/*', 'ünï/**']) assert.notEqual(globRegExp(glob), null, glob)
  })

  it('has, `within`, each path in a directory it matches too', () => {
    const within = (glob, path) => globRegExp(glob, true).test(path)
    for (const glob of ['secrets', 'secrets/', './secrets', 'secret?', '{secrets,keys}']) assert.ok(within(glob, 'secrets/deep/key.js'), glob)
    assert.ok(within('secrets', 'secrets'))
    assert.ok(!within('secrets', 'secrets.js'))
    assert.ok(!within('secrets', 'src/secrets/key.js'))
    assert.ok(within('src/*', 'src/a/b.js'))
    assert.ok(!within('src/*.js', 'src/a/b.js'))
    assert.ok(within('..', '../shared/a.js'))
    assert.ok(!globRegExp('secrets').test('secrets/key.js'))
  })
})

describe('isPathGlob', () => {
  it('is whether a path from the project root may match it: relative, with no ., .. but leading ones, or empty name', () => {
    for (const glob of ['secrets', 'secrets/', './src/**', '..', '../shared/**', '{src,lib}/**', '**']) assert.ok(isPathGlob(glob), glob)
    for (const glob of ['', '.', '/app/src', 'src\\x', 'src/../secrets/**', 'src/./x', 'a//b', 'src/{a']) assert.ok(!isPathGlob(glob), glob)
  })
})

describe('installedOf', () => {
  it('is the package of the innermost node_modules directory of a path: its directory, and the name it is installed under', () => {
    assert.deepEqual(installedOf('/app/node_modules/react/index.js'), { dir: '/app/node_modules/react', name: 'react' })
    assert.deepEqual(installedOf('/app/node_modules/@react-native/js-polyfills/console.js'), { dir: '/app/node_modules/@react-native/js-polyfills', name: '@react-native/js-polyfills' })
    assert.equal(installedOf('node_modules/a/node_modules/b/index.js').name, 'b')
    assert.equal(installedOf('node_modules/.pnpm/@scope+a@1.0.0/node_modules/@scope/a/index.js').name, '@scope/a')
    assert.equal(installedOf('node_modules/loose.js').name, 'loose.js')
  })

  it('is null of a path in none: the project, a workspace package', () => {
    for (const path of ['index.js', 'src/node_modules.js', '../packages/ui/index.js']) assert.equal(installedOf(path), null, path)
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
  // Installed under an npm alias: "time": "npm:moment@2".
  '/app/node_modules/time/package.json': JSON.stringify({ name: 'moment' }),
}

describe('packagesOf', () => {
  const packageOf = packagesOf(hostOf(MANIFESTS))

  it('is the package of the nearest package.json that names one', () => {
    assert.equal(packageOf('/app/index.js'), 'app')
    assert.equal(packageOf('/app/src/legacy/old.js'), 'app')
    assert.equal(packageOf('/app/src/broken/x.js'), 'app')
    assert.equal(packageOf('/ws/ui/src/Button.js'), '@org/ui')
    assert.equal(packageOf('/loose/x.js'), null)
  })

  it("is an installed package's by its package.json's name, else the name it is installed under, not a package.json within it", () => {
    assert.equal(packageOf('/app/node_modules/time/moment.js'), 'moment')
    assert.equal(packageOf('/app/node_modules/rxjs/operators/index.js'), 'rxjs')
    assert.equal(packageOf('/app/node_modules/@scope/ui/index.js'), '@scope/ui')
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

  it('has a path glob forbid, or allow, each file in a directory it matches', () => {
    assert.deepEqual(errorsOf({ disallowedPaths: ['src/legacy'] })['src/legacy/b.js'], [`src/legacy/b.js matches "src/legacy" of rn.config.json's disallowedPaths`])
    const allowed = errorsOf({ allowedPaths: ['index.js', 'src', 'node_modules'] })
    assert.deepEqual(Object.keys(allowed).filter((name) => allowed[name].length > 0), ['../ws/ui/index.js', '../loose/x.js'])
  })

  it("has a dev build's development's rules, and a release build's production's, besides the top level's", () => {
    const config = { disallowedPaths: ['src/legacy'], development: { disallowedPaths: ['src/a.js'] }, production: { disallowedModules: ['react'] } }
    const failing = (dev) => {
      const restrict = restrictionsOf(config, root, dev)
      return FILES.flatMap((name) => restrict(join(root, name), packageOf(join(root, name))))
    }
    assert.deepEqual(failing(true), [`src/a.js matches "src/a.js" of rn.config.json's development.disallowedPaths`, `src/legacy/b.js matches "src/legacy" of rn.config.json's disallowedPaths`])
    assert.deepEqual(failing(false), [`src/legacy/b.js matches "src/legacy" of rn.config.json's disallowedPaths`, `node_modules/react/index.js is of react, which matches "react" of rn.config.json's production.disallowedModules`])
    // A section's alone.
    assert.equal(restrictionsOf({ production: { allowedPaths: ['src'] } }, root, true), null)
    assert.equal(restrictionsOf({ production: { allowedPaths: ['src'] } }, root, false)(join(root, 'index.js'), 'app')[0], "index.js matches none of rn.config.json's production.allowedPaths")
  })

  it("checks a section's rules and the top level's each on its own: 8 rules forbid what each forbids alone, and only that", () => {
    const SECTION = { allowedPaths: ['src', 'node_modules', '../ws'], disallowedPaths: ['src/a.js'], allowedModules: ['app', 'react*', '@org/*', 'moment'], disallowedModules: ['@scope/*'] }
    const errorsIn = (config, dev) => {
      const restrict = restrictionsOf(config, root, dev)
      return Object.fromEntries(FILES.map((name) => [name, restrict(join(root, name), packageOf(join(root, name)))]))
    }
    const config = { ...RULES, production: SECTION }
    const together = errorsIn(config, false)
    const alone = [...Object.entries(RULES).map(([key, list]) => errorsIn({ [key]: list }, false)), ...Object.entries(SECTION).map(([key, list]) => errorsIn({ production: { [key]: list } }, false))]
    assert.equal(alone.length, 8)
    for (const name of FILES) assert.deepEqual(together[name], alone.flatMap((errors) => errors[name]), name)
    // What each set of 4 allows, less what the other forbids: neither overrides the other.
    assert.deepEqual(Object.keys(together).filter((name) => together[name].length === 0), ['node_modules/react/index.js'])
    // In development, the top level's alone.
    assert.deepEqual(errorsIn(config, true), errorsIn(RULES, true))
  })

  it('has a module rule check an installed package by its package.json\'s name and the name it is installed under, forbidding either, allowing both', () => {
    // A package naming itself as another (a git, tarball or file: dependency's package.json, or a registry
    // tarball's that differs from what was published), in node_modules and in pnpm's store, and an npm alias.
    const manifests = {
      ...MANIFESTS,
      '/app/node_modules/evil/package.json': JSON.stringify({ name: 'left' }),
      '/app/node_modules/.pnpm/evil@1.0.0/node_modules/evil/package.json': JSON.stringify({ name: 'left' }),
    }
    const files = ['node_modules/evil/index.js', 'node_modules/.pnpm/evil@1.0.0/node_modules/evil/index.js', 'node_modules/time/moment.js']
    const named = packagesOf(hostOf(manifests))
    const errorsIn = (config) => {
      const restrict = restrictionsOf(config, root)
      return files.map((name) => restrict(join(root, name), named(join(root, name))))
    }
    assert.deepEqual(errorsIn({ disallowedModules: ['evil', 'time'] }), [
      [`node_modules/evil/index.js is installed as evil (of left), which matches "evil" of rn.config.json's disallowedModules`],
      [`node_modules/.pnpm/evil@1.0.0/node_modules/evil/index.js is installed as evil (of left), which matches "evil" of rn.config.json's disallowedModules`],
      [`node_modules/time/moment.js is installed as time (of moment), which matches "time" of rn.config.json's disallowedModules`],
    ])
    assert.deepEqual(errorsIn({ disallowedModules: ['left', 'moment'] }).map((errors) => errors.length), [1, 1, 1])
    assert.deepEqual(errorsIn({ allowedModules: ['left', 'moment'] }), [
      ["node_modules/evil/index.js is installed as evil (of left), which matches none of rn.config.json's allowedModules"],
      ["node_modules/.pnpm/evil@1.0.0/node_modules/evil/index.js is installed as evil (of left), which matches none of rn.config.json's allowedModules"],
      ["node_modules/time/moment.js is installed as time (of moment), which matches none of rn.config.json's allowedModules"],
    ])
    assert.deepEqual(errorsIn({ allowedModules: ['evil', 'time'] })[2], ["node_modules/time/moment.js is of moment, which matches none of rn.config.json's allowedModules"])
    // Allowed where both names are: an alias by allowing the package and the name it is installed under.
    assert.deepEqual(errorsIn({ allowedModules: ['left', 'evil', 'moment', 'time'] }), [[], [], []])
  })

  it('checks each rule on its own: rules together forbid what each forbids alone, and only that', () => {
    const together = errorsOf(RULES)
    const alone = Object.entries(RULES).map(([key, list]) => errorsOf({ [key]: list }))
    for (const name of FILES) assert.deepEqual(together[name], alone.flatMap((errors) => errors[name]), name)
    assert.deepEqual(Object.keys(together).filter((name) => together[name].length === 0), ['index.js', 'src/a.js', 'node_modules/react/index.js', 'node_modules/@react-native/js-polyfills/console.js'])
  })
})
