import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { listOverrides, parseSelector } from '../src/pnpm/overrides.js'

// Selectors as pnpm 10 parses them (@pnpm/parse-overrides): a package, a
// range after its `@`, and a parent before a `>` that follows anything but
// a space, `|` or `@`.
describe('parseSelector', () => {
  const read = [
    ['foo', { target: { name: 'foo', range: undefined } }],
    ['foo@1', { target: { name: 'foo', range: '1' } }],
    ['@s/foo@^1.2.0', { target: { name: '@s/foo', range: '^1.2.0' } }],
    ['foo@>1 <2', { target: { name: 'foo', range: '>1 <2' } }],
    ['foo@1 || >2', { target: { name: 'foo', range: '1 || >2' } }],
    ['bar>foo', { parent: { name: 'bar', range: undefined }, target: { name: 'foo', range: undefined } }],
    ['bar@2>foo@1', { parent: { name: 'bar', range: '2' }, target: { name: 'foo', range: '1' } }],
    ['@s/bar@^2.1.0>@t/foo', { parent: { name: '@s/bar', range: '^2.1.0' }, target: { name: '@t/foo', range: undefined } }],
    ['foo@', { target: { name: 'foo', range: '' } }],
  ]
  for (const [selector, parsed] of read) {
    it(selector, () => assert.deepEqual(parseSelector(selector, 'x'), parsed))
  }

  // Yarn's globs among them, which pnpm reads resolutions as selectors and
  // cannot parse.
  for (const selector of ['**/foo', 'foo/**/bar', '.foo', '_foo', 'node_modules', ' foo', 'a>b>c', '@s/', 'f o o']) {
    it(`refuses ${JSON.stringify(selector)}`, () => {
      assert.throws(() => parseSelector(selector, 'x'), /^DeptreeError: x: pnpm cannot parse the selector/u)
    })
  }
})

describe('listOverrides', () => {
  const parseOverrides = (overrides, catalogs) => Object.fromEntries(listOverrides(overrides, catalogs).map(({ selector, spec }) => [selector, spec]))
  const catalogs = { __proto__: null, default: { foo: '^1.0.0', rec: 'catalog:', ws: 'workspace:*', ln: 'link:../x' }, next: { foo: '^2.0.0' } }

  it('resolves a catalog for the package a selector targets', () => {
    assert.deepEqual(parseOverrides({ foo: 'catalog:', 'bar>foo': 'catalog:next', baz: '1.0.0', qux: '-' }, catalogs), { foo: '^1.0.0', 'bar>foo': '^2.0.0', baz: '1.0.0', qux: '-' })
  })

  it('refuses a catalog pnpm cannot resolve', () => {
    assert.throws(() => parseOverrides({ bar: 'catalog:' }, catalogs), /^DeptreeError: overrides\["bar"\]: pnpm cannot resolve a catalog in the overrides: catalog "default" has no entry for "bar"$/u)
    assert.throws(() => parseOverrides({ rec: 'catalog:' }, catalogs), /is itself a catalog reference/u)
    assert.throws(() => parseOverrides({ ws: 'catalog:' }, catalogs), /uses a protocol pnpm refuses/u)
    assert.throws(() => parseOverrides({ ln: 'catalog:' }, catalogs), /uses a protocol pnpm refuses/u)
    assert.throws(() => parseOverrides({ foo: 'catalog:nope' }, catalogs), /catalog "nope" has no entry/u)
  })
})

// pnpm 11 trims selectors, takes a catalog's `workspace:` entry, and reads
// `name@` as converging on an exact version.
describe('listOverrides for pnpm 11', () => {
  const list = (overrides, catalogs = {}) => listOverrides(overrides, catalogs, 11)

  it('trims each selector, as the lockfile records it', () => {
    assert.deepEqual(list({ ' foo ': '1.0.0' }).map(({ selector }) => selector), ['foo'])
    assert.throws(() => list({ foo: '1.0.0', ' foo': '2.0.0' }), /"foo" is another selector's too, once pnpm 11 trims them/u)
  })

  it('takes a workspace: entry of a catalog', () => {
    assert.equal(list({ ws: 'catalog:' }, { __proto__: null, default: { ws: 'workspace:*' } })[0].spec, 'workspace:*')
  })

  it('reads name@ as converging on an exact version, and refuses it otherwise', () => {
    assert.deepEqual(list({ 'foo@': '1.2.3' }), [{ selector: 'foo@', target: { name: 'foo', range: '' }, spec: '1.2.3', converge: true }])
    assert.equal(listOverrides({ 'foo@': '1.2.3' }, {})[0].converge, undefined, 'pnpm 10 reads it as foo alone')
    assert.throws(() => list({ 'foo@': '^1.2.3' }), /"\^1\.2\.3" is not the exact version pnpm 11 holds a converging override to/u)
    assert.throws(() => list({ 'bar>foo@': '1.2.3' }), /an empty range with a parent is refused by pnpm 11/u)
  })
})
