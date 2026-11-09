import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extensionsChecksum, listExtensions } from '../src/pnpm/extensions.js'

// Each checksum is the packageExtensionsChecksum pnpm 10.34.9, 11.28.11,
// 12.8.1 and 12.18.0 wrote for the setting, all four the same but where it
// says. Checked too against object-hash 3.0.0 as pnpm 10 and 11 call it, on
// 20,000 random settings, with no difference.
describe('extensionsChecksum', () => {
  const MANY = {
    zeta: { peerDependencies: { react: '*' }, peerDependenciesMeta: { react: { optional: true }, vue: { optional: false } }, dependencies: { b: '^1.0.0', a: 'npm:c@2' }, optionalDependencies: { fsevents: '2' } },
    '@scope/alpha@>=1 <2': { dependencies: { '@types/node': '20.0.0' } },
    Beta: { dependencies: { x: '1' } },
  }
  const written = [
    ['a dependency added', { foo: { dependencies: { typescript: '5.9.3' } } }, 'sha256-m7IqOpadYgjAEWcuoBPm2sDcNmxqlIAIv04tXzn1G/E='],
    ['a selector with a range', { 'is-number@7': { dependencies: { typescript: '5.9.3' } } }, 'sha256-CKom+23t33vn9GfenmEQ2drT71b4vpJIFaEtCnLH4xA='],
    ['every field, whatever order they are written in', MANY, 'sha256-oabRX3OaME8QLpJgTHV75kWkIA2qyLoCmOOEVEJKH+I='],
    ['an empty extension', { foo: {} }, 'sha256-efk0vnk3hesrHD4FT/jqV28NqlgEHpgcl4JBDf1WxSc='],
    ['an empty field', { foo: { dependencies: {} } }, 'sha256-4QEfoHQyC65GjYtx6q72H5cLcztvia4bGiXzfZwG6hQ='],
    ['a peer with nothing said of it', { foo: { peerDependenciesMeta: { a: {} } } }, 'sha256-7pSU6DmIHXwPfYSaii/9+0vDzFcvgyBCpcNzNufUHK4='],
    ['names of digits, sorted as text', { foo: { dependencies: { 9: '1', 10: '1', 1: '1', a: '1', B: '1', _x: '1', '-y': '1', '@s/n': '1', '.z': '1' } } }, 'sha256-H2hu3oTGaKo3fCTL4eR8hszzOaxlJpIzNatY+1QXhO4='],
    ['a specifier beyond ASCII, by its length in UTF-16 units', { foo: { dependencies: { a: 'link:../päck\u{1F381}' } } }, 'sha256-mq/O7bk7Lp6Iv5L1kOxWWujoIszQSNGQEZS6WLynSvI='],
    ['a ${VAR} in a specifier, which none of them fills in', { foo: { dependencies: { a: '${HOME}' } } }, 'sha256-1BJvB49wZ0fZDVwGU0sOOK1NqNOJogyY2qQ0T8NCEvA='],
  ]
  for (const [name, setting, checksum] of written) {
    it(name, async () => {
      for (const major of [10, 11, 12]) assert.equal(await extensionsChecksum(listExtensions(setting, major), major), checksum, `pnpm ${major}`)
    })
  }

  // U+1F381 is before U+FFEE as UTF-16 units, and after it as a code point.
  it('sorts names as JavaScript does for pnpm 10 and 11, and by code point for pnpm 12', async () => {
    const setting = { foo: { dependencies: { '\u{1F381}': '1', '￮': '2', 'ä': '3' } } }
    for (const major of [10, 11]) assert.equal(await extensionsChecksum(listExtensions(setting, major), major), 'sha256-6KxmAzrKRmBe+oZA06hp3AQGNsOQb2HfJxPaT3C5sv0=')
    assert.equal(await extensionsChecksum(listExtensions(setting, 12), 12), 'sha256-tZkATH5jin3T77VayvAkA0g+XTlD6yrnLb8uzfbBNKw=')
  })

  it('is none where there are no extensions, and refuses text that is not well-formed', async () => {
    assert.equal(await extensionsChecksum(listExtensions(undefined)), undefined)
    assert.equal(await extensionsChecksum(listExtensions({})), undefined)
    await assert.rejects(extensionsChecksum(listExtensions({ foo: { dependencies: { a: '\uD800' } } })), /^DeptreeError: packageExtensions: expected well-formed text to hash$/u)
  })
})

describe('listExtensions', () => {
  it('reads each selector as pnpm does, in the order pnpm applies them', () => {
    const read = listExtensions({ 'foo@^1': {}, '@s/foo@>=1 <2': {}, foo: {}, 1: {}, 'foo@': {}, 'foo@latest': {} })
    assert.deepEqual(read.map(({ selector, name, range }) => [selector, name, range]), [['1', '1', undefined], ['foo@^1', 'foo', '^1'], ['@s/foo@>=1 <2', '@s/foo', '>=1 <2'], ['foo', 'foo', undefined], ['foo@', 'foo', ''], ['foo@latest', 'foo', 'latest']])
  })

  // pnpm 10 and 11 hash whatever is there, pnpm 12 only what it parses, as
  // it parses it, and pnpm 11 fails on most of these from 11.22.
  it('refuses what pnpm 10, 11 and 12 do not hash alike', () => {
    const refused = [
      [{ foo: null }, /^packageExtensions\["foo"\]: expected a mapping, found null$/u],
      [{ foo: { dependencies: null } }, /^packageExtensions\["foo"\]\.dependencies: expected a mapping, found null$/u],
      [{ foo: { dependencies: ['a'] } }, /^packageExtensions\["foo"\]\.dependencies: expected a mapping, found a list$/u],
      [{ foo: { optionalDependencies: { a: 5 } } }, /^packageExtensions\["foo"\]\.optionalDependencies\["a"\]: expected a string, found 5$/u],
      [{ foo: { peerDependencies: { a: true } } }, /^packageExtensions\["foo"\]\.peerDependencies\["a"\]: expected a string, found true$/u],
      [{ foo: { devDependencies: { a: '1' } } }, /^packageExtensions\["foo"\]: "devDependencies" is not supported: pnpm extends only dependencies, optionalDependencies, peerDependencies and peerDependenciesMeta$/u],
      [{ foo: { comment: 'why' } }, /^packageExtensions\["foo"\]: "comment" is not supported/u],
      [{ foo: { peerDependenciesMeta: { a: true } } }, /^packageExtensions\["foo"\]\.peerDependenciesMeta\["a"\]: expected a mapping, found true$/u],
      [{ foo: { peerDependenciesMeta: { a: { optional: 'true' } } } }, /^packageExtensions\["foo"\]\.peerDependenciesMeta\["a"\]: expected nothing but `optional`, true or false$/u],
      [{ foo: { peerDependenciesMeta: { a: { optional: true, extra: 'x' } } } }, /^packageExtensions\["foo"\]\.peerDependenciesMeta\["a"\]: expected nothing but `optional`, true or false$/u],
    ]
    for (const [setting, pattern] of refused) {
      for (const major of [10, 11, 12]) assert.throws(() => listExtensions(setting, major), (error) => error.name === 'DeptreeError' && pattern.test(error.message), JSON.stringify(setting))
    }
  })

  // pnpm keeps such an extension for a package.json with no name.
  it('refuses a selector that names no package', () => {
    for (const selector of ['>=1', '.foo', '_foo', ' foo', '@s/', 'f o o', 'foo/bar', '@1', '\uD800']) {
      assert.throws(() => listExtensions({ [selector]: {} }), /^DeptreeError: packageExtensions\[.*\]: the selector names no package, which is not supported$/u, selector)
    }
  })

  // As pnpm 12.8.1 and 12.18.0 read each: they fail on those npm's semver
  // does not read but `07`, which they take, and on `~=7.0` and an empty one.
  it('takes for pnpm 12 only a range it is seen to read as npm\'s semver does', () => {
    const taken = ['7', '7.0.0', '=7', '7.x', '7.*', '*', 'X', 'x.x.x', '>=7', '>=7 <8', '>6  <8', '<7.0.1-0', '^7.0.0-alpha.1', '~7.0', '6 || 7', '6||7', ' ^7 ', '6 - 7', '1.0.0-alpha - 7.0.0', '7 - 8 || 9']
    const refused = ['', ' ', 'latest', '07', '==7.0.0', '7.0.0.0', '>=7,<8', '~=7.0', '~>7.0', 'v7', '>= 7', '7.0.0+build', '6 - 7.x', '7 - x', '1 - 2 - 3', '7 ||', '|| 7']
    for (const range of taken) assert.equal(listExtensions({ [`foo@${range}`]: {} }, 12)[0].range, range)
    for (const range of refused) {
      assert.throws(() => listExtensions({ [`foo@${range}`]: {} }, 12), /^DeptreeError: packageExtensions\["foo@.*"\]: pnpm 12 fails on its range, ".*", or may read it otherwise than npm's semver, which is not supported$/u, range)
      for (const major of [10, 11]) assert.equal(listExtensions({ [`foo@${range}`]: {} }, major)[0].range, range, 'pnpm 10 and 11 read it as npm\'s semver does, which may take nothing')
    }
  })

  it('refuses for pnpm 12 a name of digits alone, which a mapping lists first wherever it is written', () => {
    assert.throws(() => listExtensions({ 'foo@1': {}, 42: {} }, 12), /^DeptreeError: packageExtensions\["42"\]: pnpm 12 applies the extensions in the order they are written, which is lost for a name of digits alone, and that is not supported$/u)
    assert.equal(listExtensions({ '42@1': {}, 4.2: {} }, 12).length, 2)
  })
})
