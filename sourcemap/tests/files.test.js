import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readSourceMap } from '@preventive/sourcemap'
import { packageOf, sourcePath } from '../src/files.js'

// A `sources` entry is whatever its bundler wrote: a path relative to the
// map, a webpack:// name, a file:// URL, an absolute path off the build
// machine. Each becomes a path, and a path through node_modules names the
// package it lies in, its version too where a store spells it.

describe('a source becomes a path', () => {
  it('drops webpack\'s scheme and namespace, and does not resolve it against the map', () => {
    assert.equal(sourcePath('webpack://fx/./src/a.js'), 'src/a.js')
    assert.equal(sourcePath('webpack:///./node_modules/x/i.js', 'dist/main.js.map'), 'node_modules/x/i.js')
    assert.equal(sourcePath('webpack-internal:///./src/a.js'), 'src/a.js')
    assert.equal(sourcePath('webpack://fx/external module "ext"'), 'external module "ext"')
  })

  it('reads a file:// URL as the path it is', () => {
    assert.equal(sourcePath('file:///home/u/a%20b.js', 'dist/x.map'), '/home/u/a b.js')
    assert.equal(sourcePath('file:///C:/work/a.js'), 'C:/work/a.js')
    assert.equal(sourcePath('file://localhost/home/u/a.js'), '/home/u/a.js')
    assert.equal(sourcePath('FILE://LocalHost/home/u/a.js'), '/home/u/a.js')
    assert.equal(sourcePath('file:/home/u/a.js'), '/home/u/a.js')
    assert.equal(sourcePath('file:///home/u/a%zz.js'), '/home/u/a%zz.js')
    assert.equal(sourcePath('file:///app/a.js#v1'), '/app/a.js')
    assert.equal(sourcePath('file:///app/a%23b.js'), '/app/a#b.js')
    // Another host's is a UNC path, under its server, which no `..` climbs above.
    assert.equal(sourcePath('file://server/share/a.js'), '//server/share/a.js')
    assert.equal(sourcePath('file://server/share/../../a.js'), '//server/a.js')
    // In one case, as Windows takes a server's name.
    assert.equal(sourcePath('file://SERVER/share/a.js'), '//server/share/a.js')
    assert.equal(sourcePath('\\\\SERVER\\share\\a.js'), '//server/share/a.js')
  })

  it('reads a URL as a path under its scheme and host, with nothing above them', () => {
    assert.equal(sourcePath('https://cdn.example/x.js', 'dist/x.map'), 'https://cdn.example/x.js')
    assert.equal(sourcePath('https://cdn.example/src/./b/../a.js'), 'https://cdn.example/src/a.js')
    assert.equal(sourcePath('ng://core/a.ts'), 'ng://core/a.ts')
    // As the URL Standard parses it: a host in one case, no default port,
    // a query as it is.
    assert.equal(sourcePath('HTTPS://CDN.Example:443/src/a.js'), 'https://cdn.example/src/a.js')
    assert.equal(sourcePath('https://cdn.example/src/a.js?redirect=/x/../y'), 'https://cdn.example/src/a.js?redirect=/x/../y')
    assert.equal(sourcePath('../src/a.js', 'https://cdn.example/dist/x.js.map'), 'https://cdn.example/src/a.js')
    assert.equal(sourcePath('../../../a.js', 'https://cdn.example/dist/x.js.map'), 'https://cdn.example/a.js')
    // A rooted source is resolved against a URL map path as any other is.
    assert.equal(sourcePath('/src/a.js', 'https://cdn.example/dist/x.js.map'), 'https://cdn.example/src/a.js')
    assert.equal(sourcePath('//other.example/a.js', 'https://cdn.example/dist/x.js.map'), 'https://other.example/a.js')
    assert.equal(sourcePath('file:///app/a.js', 'https://cdn.example/dist/x.js.map'), '/app/a.js')
    // Under a map at a file:// URL, the path it is.
    assert.equal(sourcePath('src/a.js', 'file:///app/out.js.map'), '/app/src/a.js')
    assert.equal(sourcePath('../a.js', 'file:///C:/app/out.js.map'), 'C:/a.js')
    assert.equal(sourcePath('/src/a.js', 'file:///app/out.js.map'), '/src/a.js')
    assert.equal(sourcePath('a%20b.js', 'file:///app/out.js.map'), '/app/a b.js')
  })

  it('keeps a name that is no path as it is', () => {
    assert.equal(sourcePath('data:text/javascript,1', 'dist/x.map'), 'data:text/javascript,1')
    assert.equal(sourcePath('virtual:entry', 'dist/x.map'), 'virtual:entry')
  })

  it('climbs above no drive', () => {
    assert.equal(sourcePath('C:\\a\\..\\..\\b.js'), 'C:/b.js')
    // A drive's letter in one case, as Windows takes it.
    assert.equal(sourcePath('c:/app/a.js'), 'C:/app/a.js')
    assert.equal(sourcePath('../../../x.js', 'C:/proj/out/m.map'), 'C:/x.js')
    assert.equal(sourcePath('/x.js', 'C:/proj/out/m.map'), '/x.js')
  })

  it('resolves a relative path against the map\'s own, and keeps an absolute one', () => {
    assert.equal(sourcePath('../../src/a.js', 'dist/esm/index.js.map'), 'src/a.js')
    assert.equal(sourcePath('../../src/a.js'), '../../src/a.js')
    assert.equal(sourcePath('../../../src/a.js', 'dist/index.js.map'), '../../src/a.js')
    assert.equal(sourcePath('/app/src/./a.js', 'dist/index.js.map'), '/app/src/a.js')
    assert.equal(sourcePath('C:\\app\\src\\a.js', 'dist\\index.js.map'), 'C:/app/src/a.js')
    assert.equal(sourcePath('..\\src\\a.js', 'dist\\index.js.map'), 'src/a.js')
  })
})

describe('a path through node_modules names its package', () => {
  const pkg = (path) => packageOf(path) && Object.values(packageOf(path))

  it('by the last node_modules on it', () => {
    assert.deepEqual(pkg('node_modules/dep/index.js'), ['dep', null, 'node_modules/dep', 'index.js'])
    assert.deepEqual(pkg('../node_modules/@scope/dep/lib/a.js'), ['@scope/dep', null, '../node_modules/@scope/dep', 'lib/a.js'])
    assert.deepEqual(pkg('/app/node_modules/a/node_modules/b/x/y.js'), ['b', null, '/app/node_modules/a/node_modules/b', 'x/y.js'])
    // A URL's by its path, a query its file's own.
    assert.deepEqual(pkg('https://cdn.example/node_modules/dep/a.js?v=1'), ['dep', null, 'https://cdn.example/node_modules/dep', 'a.js?v=1'])
    assert.equal(packageOf('https://cdn.example/app.js?redirect=/node_modules/evil/index.js'), null)
  })

  it('with the version a store keeps it under', () => {
    // pnpm 9, peers in parentheses; pnpm 8, after `_`; a scope as `+`; bun and deno's stores alike.
    assert.deepEqual(pkg('../node_modules/.pnpm/@kurkle+color@0.3.2/node_modules/@kurkle/color/dist/color.esm.js'), ['@kurkle/color', '0.3.2', '../node_modules/.pnpm/@kurkle+color@0.3.2/node_modules/@kurkle/color', 'dist/color.esm.js'])
    assert.equal(packageOf('node_modules/.pnpm/react-dom@18.2.0(react@18.2.0)/node_modules/react-dom/index.js').version, '18.2.0')
    assert.equal(packageOf('node_modules/.pnpm/react-dom@18.2.0_react@18.2.0/node_modules/react-dom/index.js').version, '18.2.0')
    assert.equal(packageOf('node_modules/.pnpm/a@1.0.0-beta.1+build.5/node_modules/a/index.js').version, '1.0.0-beta.1+build.5')
    assert.equal(packageOf('node_modules/.bun/is-number@7.0.0/node_modules/is-number/index.js').version, '7.0.0')
    assert.equal(packageOf('node_modules/.deno/is-number@7.0.0/node_modules/is-number/index.js').version, '7.0.0')
  })

  it('without a version where the path does not spell one', () => {
    // A store directory for another package, a git dependency, pnpm's hoisted node_modules, a plain install.
    assert.equal(packageOf('node_modules/.pnpm/other@1.0.0/node_modules/dep/index.js').version, null)
    assert.equal(packageOf('node_modules/.pnpm/dep@https+++codeload.github.com+a+b+tar.gz+abc/node_modules/dep/index.js').version, null)
    assert.equal(packageOf('node_modules/.pnpm/node_modules/dep/index.js').version, null)
    assert.equal(packageOf('node_modules/dep/index.js').version, null)
  })

  it('and none for a tool\'s own directory, a bare package directory, or no node_modules', () => {
    // npm's own rule, ASCII alone: no `_`-led name, no Kelvin sign for a `k`.
    for (const path of ['node_modules/.vite/deps/react.js', 'node_modules/.bin/tsc', 'node_modules/dep', 'node_modules/@scope', 'src/node_modules.js', 'src/a.js', 'node_modules/dep/', 'node_modules/_x/a.js', 'node_modules/\u212Aoa/a.js']) {
      assert.equal(packageOf(path), null, path)
    }
  })
})

it('a map\'s files carry both', () => {
  const map = readSourceMap({ version: 3, sources: ['../src/a.js', '../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js'], mappings: '' }, { path: 'dist/a.js.map' })
  assert.deepEqual(map.files.map((f) => [f.path, f.package?.name ?? null, f.package?.version ?? null, f.package?.path ?? null]), [
    ['src/a.js', null, null, null],
    ['node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js', 'ms', '2.1.3', 'index.js'],
  ])
})
