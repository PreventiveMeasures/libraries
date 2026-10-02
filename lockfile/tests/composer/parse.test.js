import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseComposerLock } from '../../composer.js'

const C = 'c'.repeat(40)
const README = [
  'This file locks the dependencies of your project to a known state',
  'Read more about it at https://getcomposer.org/doc/01-basic-usage.md#installing-dependencies',
  'This file is @generated automatically',
]

// A lockfile of Composer 2.10: an app from git and a zip, which provides a
// name; a library at its default branch, with a branch alias and the
// root's; a directory that replaces a name at self.version; and a dev
// tool at a beta, abandoned, with a bin. Each requirement is met: by an
// alias, by the replace, and by the provide.
const BASE = {
  _readme: README,
  'content-hash': '0123456789abcdef0123456789abcdef',
  packages: [
    {
      name: 'a/app',
      version: '1.0.0',
      source: { type: 'git', url: 'https://example.com/a/app.git', reference: C },
      dist: { type: 'zip', url: 'https://example.com/a/app.zip', reference: C, shasum: '' },
      require: { 'b/lib': '^2.0', php: '>=8.1' },
      provide: { 'x/impl': '1.0' },
      type: 'library',
      time: '2026-01-01T00:00:00+00:00',
    },
    {
      name: 'b/lib',
      version: 'dev-main',
      source: { type: 'git', url: 'git@example.com:b/lib.git', reference: C },
      require: { 'c/old': '^3.0' },
      'default-branch': true,
      type: 'library',
      extra: { 'branch-alias': { 'dev-main': '2.0.x-dev' } },
    },
    {
      name: 'c/new',
      version: 'v3.1.0',
      dist: { type: 'path', url: '../c', reference: C },
      replace: { 'c/old': 'self.version' },
      type: 'library',
      'transport-options': { relative: true },
    },
  ],
  'packages-dev': [
    {
      name: 'd/tool',
      version: '1.5.0-beta1',
      dist: { type: 'tar', url: 'https://example.com/d/tool.tar', shasum: 'a'.repeat(40) },
      require: { 'x/impl': '^1.0' },
      bin: ['bin/tool'],
      type: 'library',
      keywords: ['9', '10', 'cli'],
      abandoned: 'e/new',
    },
  ],
  aliases: [{ package: 'b/lib', version: 'dev-main', alias: '2.0.1', alias_normalized: '2.0.1.0' }],
  'minimum-stability': 'stable',
  'stability-flags': { 'b/lib': 20, 'd/tool': 10 },
  'prefer-stable': false,
  'prefer-lowest': false,
  platform: { php: '>=8.1' },
  'platform-dev': {},
  'plugin-api-version': '2.9.0',
}

const encode = (doc) => `${JSON.stringify(doc, null, 4)}\n`

// The fields of the top, and of a package, in the order Composer writes
// them.
const TOP = ['_readme', 'content-hash', 'packages', 'packages-dev', 'aliases', 'minimum-stability', 'stability-flags', 'prefer-stable', 'prefer-lowest', 'platform', 'platform-dev', 'platform-overrides', 'plugin-api-version']
const FIELDS = [
  'name', 'version', 'target-dir', 'source', 'dist', 'require', 'conflict', 'provide', 'replace', 'require-dev', 'suggest', 'default-branch',
  'bin', 'type', 'extra', 'autoload', 'autoload-dev', 'notification-url', 'include-path', 'php-ext', 'archive', 'scripts', 'license',
  'authors', 'description', 'homepage', 'keywords', 'support', 'funding', 'abandoned', 'transport-options', 'time',
]

// `key` set to `value` in its place of `order`.
function put(object, key, value, order = FIELDS) {
  const entries = Object.entries({ ...object, [key]: value }).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
  for (const name of Object.keys(object)) delete object[name]
  Object.assign(object, Object.fromEntries(entries))
}

// A link added among a package's, sorted.
const link = (pkg, type, target, constraint) => put(pkg, type, Object.fromEntries(Object.entries({ ...pkg[type], [target]: constraint }).sort(([a], [b]) => (a < b ? -1 : 1))))

// BASE with `change` made to a copy of it.
function edit(change) {
  const doc = structuredClone(BASE)
  change(doc)
  return encode(doc)
}

// BASE's text with each `from` replaced.
function replace(...edits) {
  let text = encode(BASE)
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `BASE has no ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  return text
}

const refuses = (text, message, where, options) => assert.throws(() => parseComposerLock(text, options), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

const plain = (value) => JSON.parse(JSON.stringify(value))

describe('BASE', () => {
  const lock = parseComposerLock(encode(BASE))

  it('the settings, and each package by name', () => {
    assert.deepEqual([lock.contentHash, lock.fresh, lock.pluginApiVersion, lock.minimumStability], ['0123456789abcdef0123456789abcdef', undefined, '2.9.0', 'stable'])
    assert.deepEqual(plain(lock.stabilityFlags), { 'b/lib': 'dev', 'd/tool': 'beta' })
    assert.deepEqual(Object.keys(lock.packages), ['a/app', 'b/lib', 'c/new', 'd/tool'])
    assert.deepEqual(Object.values(lock.packages).map((pkg) => pkg.dev), [false, false, false, true])
  })

  it('each requirement, and what meets it: an alias, a replace, a provide', () => {
    assert.deepEqual(plain(lock.packages['a/app'].require), {
      'b/lib': { constraint: '^2.0', platform: false, targets: ['b/lib'] },
      php: { constraint: '>=8.1', platform: true, targets: [] },
    })
    assert.deepEqual(lock.packages['b/lib'].require['c/old'].targets, ['c/new'])
    assert.deepEqual(lock.packages['d/tool'].require['x/impl'].targets, ['a/app'])
  })

  it('the aliases a package goes by', () => {
    assert.deepEqual(lock.packages['b/lib'].aliases, [
      { version: '2.0.x-dev', normalized: '2.0.9999999.9999999-dev', root: false },
      { version: '2.0.1', normalized: '2.0.1.0', root: true },
    ])
    assert.deepEqual(lock.packages['a/app'].aliases, [])
  })

  it('sources, dists, and the rest of a package', () => {
    const app = lock.packages['a/app']
    assert.deepEqual([app.normalized, app.stability, app.dist.shasum], ['1.0.0.0', 'stable', undefined])
    assert.deepEqual(plain(lock.packages['b/lib'].source), { type: 'git', url: 'git@example.com:b/lib.git', reference: C, mirrors: [] })
    const tool = lock.packages['d/tool']
    assert.deepEqual([tool.stability, tool.dist.shasum, tool.abandoned, tool.bin, tool.keywords], ['beta', 'a'.repeat(40), 'e/new', ['bin/tool'], ['9', '10', 'cli']])
    assert.deepEqual(plain(lock.packages['c/new'].transportOptions), { relative: true })
  })
})

describe('the text, as Composer writes it', () => {
  it('in any indentation, with LF or CRLF line ends', () => {
    parseComposerLock(encode(BASE).replaceAll(/^(?: {4})+/gmu, (spaces) => '  '.repeat(spaces.length / 4)))
    parseComposerLock(encode(BASE).replaceAll('\n', '\r\n'))
  })

  it('refuses what json_encode does not write', () => {
    refuses(encode(BASE).slice(0, -1), 'expected a line end, as Composer writes it, found the end of the file at line 113')
    refuses(`${encode(BASE)}\n`, 'expected the end of the file after the last "}", found an LF line end at line 114')
    refuses(replace(['\n    "content-hash"', '\r\n    "content-hash"']), 'expected a line end and "    " of indentation, as Composer writes it, found a CRLF line end at line 6')
    refuses(replace(['"name": "a/app",', '"name": "a/app",\n            "name": "a/app",']), '"name" is a key at line 10 too at line 11')
    refuses(replace(['"name": "a/app"', '"name": "a\\/app"']), '"\\"a\\\\/app\\"" is not written as Composer writes it, "\\"a/app\\"" at line 10')
    refuses(replace(['"b/lib": 20', '"b/lib": 20.0']), '20.0 is not written as Composer writes it, 20 at line 103')
    refuses(replace(['"relative": true', '"relative": {}']), 'an empty object, which Composer writes as "[]" at line 65')
    refuses(replace(['"relative": true', '"0": true']), 'an object of the keys 0 to 0, which Composer writes as a list at line 64')
    refuses(replace(['"version": "1.0.0"', '"version":  "1.0.0"']), 'expected a value, found " \\"1.0.0\\"," at line 11')
    refuses(`\uFEFF${encode(BASE)}`, 'expected "{" alone on the first line and an indented key on the next, as Composer writes the file at line 1')
    refuses(replace(['    "content-hash": "0123456789abcdef0123456789abcdef",\n', '<<<<<<< HEAD\n    "content-hash": "0123456789abcdef0123456789abcdef",\n=======\n    "content-hash": "fedcba9876543210fedcba9876543210",\n>>>>>>> other\n']), 'a merge conflict at line 7, which Composer reads as a lockfile of no content-hash where its sides differ in that alone')
  })
})

describe('the top of the file', () => {
  it('refuses a field Composer does not write, or not there', () => {
    refuses(edit((doc) => (doc.extra = 1)), 'unsupported field "extra"', undefined)
    refuses(edit((doc) => (doc.hash = 'x')), '`hash`, the md5 of composer.json that Composer 1.2 and older wrote, which is not read here', 'hash')
    refuses(edit((doc) => {
      const { _readme, ...rest } = doc
      Object.assign(doc, { _readme: undefined })
      for (const key of Object.keys(doc)) delete doc[key]
      Object.assign(doc, rest, { _readme })
    }), 'out of the order Composer writes, before "plugin-api-version"', '_readme')
    refuses(edit((doc) => delete doc['prefer-lowest']), 'expected "prefer-lowest", which Composer always writes', 'prefer-lowest')
    refuses(edit((doc) => (doc._readme = README.slice(1))), 'expected the three lines Composer writes', '_readme')
    refuses(edit((doc) => (doc['content-hash'] = 'ABCDEF0123456789abcdef0123456789')), '"ABCDEF0123456789abcdef0123456789" is not an md5 in lowercase hex', 'content-hash')
    refuses(edit((doc) => (doc['minimum-stability'] = 'rc')), 'expected one of stable, RC, beta, alpha, dev, found the string "rc"', 'minimum-stability')
    refuses(edit((doc) => (doc['prefer-stable'] = 1)), 'expected true or false, found the number 1', 'prefer-stable')
  })

  it('refuses Composer 1\'s, and plugin APIs it does not know', () => {
    refuses(edit((doc) => (doc['plugin-api-version'] = '1.1.0')), '"1.1.0" is Composer 1\'s, which is not read here', 'plugin-api-version')
    refuses(edit((doc) => delete doc['plugin-api-version']), 'no plugin-api-version: a lockfile of Composer 1.9 or older, which is not read here')
    refuses(edit((doc) => (doc['plugin-api-version'] = '2.11.0')), 'unsupported plugin-api-version: expected one of 2.0.0, 2.1.0, 2.2.0, 2.3.0, 2.6.0, 2.9.0, found the string "2.11.0"', 'plugin-api-version')
    refuses(edit((doc) => (doc['packages-dev'] = null)), 'null, as Composer 1 writes it after update --no-dev, which Composer 2 does not install from', 'packages-dev')
  })

  it('takes `[]` and `{}` for nothing, as one Composer writes them all', () => {
    parseComposerLock(edit((doc) => Object.assign(doc, { 'platform-dev': [], 'plugin-api-version': '2.6.0' })))
    refuses(edit((doc) => (doc.platform = {})).replace('"platform-dev": {}', '"platform-dev": []'), '"[]", where "platform" is "{}", as no Composer writes them both', 'platform-dev')
    // Of plugin-api-version 2.9.0, Composer 2.9 and later, `{}` alone.
    refuses(edit((doc) => (doc['platform-dev'] = [])), '"[]", which Composer of plugin-api-version 2.9.0 writes as "{}"', 'platform-dev')
  })

  it('stability-flags: sorted by 2.8 and later, and of a stability\'s number', () => {
    const unsorted = { 'd/tool': 10, 'b/lib': 20 }
    refuses(edit((doc) => (doc['stability-flags'] = unsorted)), 'out of the order Composer 2.8 and later sort it in, after "d/tool"', 'stability-flags["b/lib"]')
    parseComposerLock(edit((doc) => Object.assign(doc, { 'stability-flags': unsorted, 'platform-dev': [], 'plugin-api-version': '2.6.0' })))
    refuses(edit((doc) => (doc['stability-flags']['b/lib'] = 3)), 'expected one of 0, 5, 10, 15, 20, found the number 3', 'stability-flags["b/lib"]')
  })

  it('the platform, and its overrides', () => {
    refuses(edit((doc) => (doc.platform = { 'a/app': '*' })), '"a/app" is not a platform package\'s name in lowercase, as Composer writes one', 'platform["a/app"]')
    refuses(edit((doc) => (doc.platform = { php: '^^8' })), '"^^8" is not a version constraint Composer reads', 'platform.php')
    const lock = parseComposerLock(edit((doc) => put(doc, 'platform-overrides', { php: '8.3.0', 'ext-xdebug': false }, TOP)))
    assert.deepEqual(plain(lock.platformOverrides), { php: '8.3.0', 'ext-xdebug': false })
    refuses(edit((doc) => put(doc, 'platform-overrides', { php: false }, TOP)), 'false, which Composer refuses of php, as it cannot be missing', 'platform-overrides.php')
    refuses(edit((doc) => put(doc, 'platform-overrides', { php: true }, TOP)), 'expected a version, or false, found the boolean true', 'platform-overrides.php')
    // PlatformRepository refuses `false` of "php" as written, and keys the
    // rest in lowercase, the last of a name counting.
    refuses(edit((doc) => put(doc, 'platform-overrides', { PHP: false }, TOP)), 'false, which Composer refuses of php, as it cannot be missing', 'platform-overrides.PHP')
    refuses(edit((doc) => put(doc, 'platform-overrides', { php: '8.3.0', Php: false }, TOP)), 'false, which Composer refuses of php, as it cannot be missing', 'platform-overrides.Php')
    assert.deepEqual(plain(parseComposerLock(edit((doc) => put(doc, 'platform-overrides', { PHP: false, php: '8.3.0' }, TOP))).platformOverrides), { PHP: false, php: '8.3.0' })
  })
})

describe('a package', () => {
  const at = (index, rest = '') => `packages[${index}]${rest}`

  it('refuses a field Composer does not write, or does not write there', () => {
    refuses(edit((doc) => (doc.packages[0].foo = 1)), 'unsupported field "foo"', at(0))
    refuses(edit((doc) => (doc.packages[0].version_normalized = '1.0.0.0')), '`version_normalized`, which Composer leaves out of a lockfile', at(0, '.version_normalized'))
    refuses(edit((doc) => (doc.packages[0].repositories = [{ type: 'vcs' }])), "`repositories`, which Composer reads of the project's composer.json alone", at(0, '.repositories'))
    refuses(edit((doc) => {
      const { name, ...rest } = doc.packages[0]
      doc.packages[0] = { ...rest, name }
    }), 'out of the order Composer writes, before "time"', at(0, '.name'))
    refuses(edit((doc) => delete doc.packages[0].type), 'expected a type, which Composer always writes', at(0))
  })

  it('a name, and a version, as Composer takes them', () => {
    refuses(edit((doc) => (doc.packages[0].name = 'app')), '"app" is not a package name, a vendor and a package as Composer takes them', at(0, '.name'))
    refuses(edit((doc) => (doc.packages[0].name = 'a/con')), '"a/con" has a name Windows reserves in it, which Composer refuses', at(0, '.name'))
    // Caseless of ASCII alone, as PCRE without /u: not ſ for s, nor the
    // Kelvin sign for k.
    for (const name of ['ſymfony/app', 'a/\u212Aelvin']) {
      refuses(edit((doc) => (doc.packages[0].name = name)), `${JSON.stringify(name)} is not a package name, a vendor and a package as Composer takes them`, at(0, '.name'))
    }
    refuses(edit((doc) => (doc.packages[0].version = '1.0-ſtable')), '"1.0-ſtable" is not a version Composer locks a package at', at(0, '.version'))
    refuses(edit((doc) => (doc.packages[0].version = '1.0 as 2.0')), '"1.0 as 2.0" is not a version Composer locks a package at', at(0, '.version'))
    refuses(edit((doc) => (doc.packages[0].version = 'one')), '"one" is not a version Composer locks a package at', at(0, '.version'))
    refuses(edit((doc) => (doc.packages[0].type = 'Library')), '"Library", which Composer writes in lowercase', at(0, '.type'))
    refuses(edit((doc) => (doc.packages[0].type = '0')), '"0", which Composer reads as no value and does not write', at(0, '.type'))
    refuses(edit((doc) => (doc.packages[1]['default-branch'] = false)), 'expected true, as Composer writes it of the default branch alone, found the boolean false', at(1, '["default-branch"]'))
  })

  it('a source, and a dist, that Composer fetches', () => {
    refuses(edit((doc) => delete doc.packages[0].source.reference), 'expected a reference, without which Composer does not read a source', at(0, '.source'))
    refuses(edit((doc) => (doc.packages[0].source.type = 'cvs')), 'expected one of git, hg, svn, fossil, perforce, which Composer clones from', at(0, '.source.type'))
    refuses(edit((doc) => (doc.packages[0].source.url = '--upload-pack=x')), '"--upload-pack=x" starts with "-", which a tool would read as an option and Composer refuses', at(0, '.source.url'))
    refuses(edit((doc) => (doc.packages[0].source.url = 'ext::sh -c x')), '"ext::sh -c x" names a remote helper of git\'s, which is not supported', at(0, '.source.url'))
    refuses(edit((doc) => (doc.packages[0].source.url = 'file:///srv/git/app')), '"file:///srv/git/app" is not a URL git fetches from, https: http: ssh: git: git+ssh:', at(0, '.source.url'))
    // git's scp form, with a user or not, as of a host ssh's config names;
    // not where a URL parser would read it as a URL of another scheme.
    for (const url of ['example.com:a/app.git', 'github-work:org/app.git', 'git@example.com:a/app.git']) {
      assert.equal(parseComposerLock(edit((doc) => (doc.packages[0].source.url = url))).packages['a/app'].source.url, url)
    }
    refuses(edit((doc) => (doc.packages[0].source.url = 'file:/srv/git/app')), '"file:/srv/git/app" is of the host file to git, and a URL of file: to a URL parser', at(0, '.source.url'))
    refuses(edit((doc) => (doc.packages[0].source.url = 'HTTPS:example.com/app')), '"HTTPS:example.com/app" is of the host HTTPS to git, and a URL of https: to a URL parser', at(0, '.source.url'))
    refuses(edit((doc) => Object.assign(doc.packages[0].source, { type: 'hg', url: 'example.com:a/app' })), '"example.com:a/app" is not a URL hg fetches from, https: http: ssh:', at(0, '.source.url'))
    // FossilDriver takes ssh:// too, as fossil clones over it.
    assert.equal(parseComposerLock(edit((doc) => Object.assign(doc.packages[0].source, { type: 'fossil', url: 'ssh://fossil.example.com/repo' }))).packages['a/app'].source.url, 'ssh://fossil.example.com/repo')
    refuses(edit((doc) => Object.assign(doc.packages[0].source, { type: 'fossil', url: 'git://fossil.example.com/repo' })), '"git://fossil.example.com/repo" is not a URL fossil fetches from, https: http: ssh:', at(0, '.source.url'))
    for (const url of ['ssh://-oProxyCommand=x/app', 'ssh://%2doProxyCommand=x/app', 'git@-oProxyCommand=x:app']) {
      refuses(edit((doc) => (doc.packages[0].source.url = url)), `${JSON.stringify(url)} has a "-" where git or ssh would read an option`, at(0, '.source.url'))
    }
    refuses(edit((doc) => (doc.packages[0].source.url = '/srv/git/app')), '"/srv/git/app" is an absolute path, of the machine the lockfile was written on', at(0, '.source.url'))
    refuses(edit((doc) => (doc.packages[0].source.reference = 'main..x')), '"main..x" is not a branch or tag name git takes', at(0, '.source.reference'))
    refuses(edit((doc) => (doc.packages[0].source.type = 'perforce')), '"https://example.com/a/app.git" is not a Perforce port, [tcp|ssl:][host:]port, as Composer takes one', at(0, '.source.url'))
    refuses(edit((doc) => (doc.packages[0].dist.shasum = 'A'.repeat(40))), `"${'A'.repeat(40)}" is not a sha1 in lowercase hex, which Composer compares the download's with`, at(0, '.dist.shasum'))
    refuses(edit((doc) => (doc.packages[0].dist.type = 'git')), 'expected path or one of zip, tar, gzip, xz, rar, phar, file, which Composer installs from', at(0, '.dist.type'))
    refuses(edit((doc) => (doc.packages[2].dist.url = 'https://example.com/c')), '"https://example.com/c" is a URL, of https:, and not a path', at(2, '.dist.url'))
    // Of a scheme, which FileDownloader opens by PHP's stream wrappers.
    for (const [url, scheme] of [['data:text/plain,hello', 'data:'], ['phar://x.phar/a.zip', 'phar:'], ['ftp://example.com/a.zip', 'ftp:']]) {
      refuses(edit((doc) => (doc.packages[0].dist.url = url)), `${JSON.stringify(url)} is a URL, of ${scheme}, and not a path`, at(0, '.dist.url'))
    }
    assert.equal(parseComposerLock(edit((doc) => (doc.packages[0].dist.url = './data:x/a.zip'))).packages['a/app'].dist.url, './data:x/a.zip')
    // HttpDownloader takes a scheme in any case.
    const upper = parseComposerLock(edit((doc) => {
      doc.packages[0].dist.url = 'HTTPS://example.com/a/app.zip'
      put(doc.packages[0], 'notification-url', 'Http://example.com/downloads/')
    }))
    assert.deepEqual([upper.packages['a/app'].dist.url, upper.packages['a/app'].notificationUrl], ['HTTPS://example.com/a/app.zip', 'Http://example.com/downloads/'])
    // A mirror, which Composer may try first, held to what the URL is.
    const mirror = (url) => [{ url, preferred: true }]
    refuses(edit((doc) => (doc.packages[0].dist.mirrors = mirror('/srv/private/%package%'))), '"/srv/private/%package%" is an absolute path, of the machine the lockfile was written on', at(0, '.dist.mirrors[0].url'))
    refuses(edit((doc) => (doc.packages[0].source.mirrors = mirror('file:///srv/%package%.git'))), '"file:///srv/%package%.git" is not a URL git fetches from, https: http: ssh: git: git+ssh:', at(0, '.source.mirrors[0].url'))
    refuses(edit((doc) => (doc.packages[0].source.mirrors = mirror('ssh://-oProxyCommand=x/%package%'))), '"ssh://-oProxyCommand=x/%package%" has a "-" where git or ssh would read an option', at(0, '.source.mirrors[0].url'))
    const local = parseComposerLock(edit((doc) => {
      doc.packages[0].source.mirrors = mirror('git@mirror.example.com:%package%.git')
      doc.packages[2].dist.mirrors = mirror('../mirror/%package%')
    }))
    assert.deepEqual([local.packages['a/app'].source.mirrors[0].url, local.packages['c/new'].dist.mirrors[0].url], ['git@mirror.example.com:%package%.git', '../mirror/%package%'])
    const mirrored = parseComposerLock(edit((doc) => (doc.packages[0].dist.mirrors = [{ url: 'https://mirror.example.com/%package%/%reference%.%type%', preferred: true }])))
    assert.deepEqual(plain(mirrored.packages['a/app'].dist.mirrors), [{ url: 'https://mirror.example.com/%package%/%reference%.%type%', preferred: true }])
  })

  it('links as ArrayLoader writes them back', () => {
    refuses(edit((doc) => (doc.packages[0].require = { php: '>=8.1', 'b/lib': '^2.0' })), 'out of the order Composer sorts the keys in, after "php"', at(0, '.require["b/lib"]'))
    refuses(edit((doc) => link(doc.packages[0], 'require', 'B/lib', '^2.0')), '"B/lib" is not a package name in lowercase, as Composer writes a link\'s', at(0, '.require["B/lib"]'))
    refuses(edit((doc) => (doc.packages[0].require['b/lib'] = '^^2')), '"^^2" is not a version constraint Composer reads', at(0, '.require["b/lib"]'))
    refuses(edit((doc) => put(doc.packages[0], 'conflict', [])), 'expected a mapping, found a sequence', at(0, '.conflict'))
    refuses(edit((doc) => put(doc.packages[0], 'suggest', { 'x/y': ' self.version' })), '"self.version", which Composer writes as the package\'s version', at(0, '.suggest["x/y"]'))
  })

  it('an integer of 64 bits, past what a number holds, as a bigint', () => {
    const text = edit((doc) => put(doc.packages[0], 'extra', { id: 'ID', least: 'LEAST', small: 7 })).replace('"ID"', '9007199254740993').replace('"LEAST"', '-9223372036854775808')
    const { extra } = parseComposerLock(text).packages['a/app']
    assert.deepEqual([extra.id, extra.least, extra.small], [9007199254740993n, -9223372036854775808n, 7])
    // Past 64 bits, PHP reads a double, and writes it back so.
    assert.throws(() => parseComposerLock(text.replace('9007199254740993', '9223372036854775808')), /9223372036854775808 is not written as Composer writes it, 9\.223372036854776e\+18 at line/u)
  })

  it('what ArrayLoader changes, or drops, refused', () => {
    refuses(edit((doc) => (doc['packages-dev'][0].bin = 'bin/tool')), 'expected a sequence, found the string "bin/tool"', 'packages-dev[0].bin')
    refuses(edit((doc) => (doc['packages-dev'][0].bin = ['/bin/tool'])), '"/bin/tool" is not a path in the package, as Composer installs a bin from', 'packages-dev[0].bin[0]')
    refuses(edit((doc) => (doc['packages-dev'][0].bin = ['../../x'])), '"../../x" is not a path in the package, as Composer installs a bin from', 'packages-dev[0].bin[0]')
    for (const bin of ['C:\\outside\\tool', 'c:tool', '\\\\server\\share\\tool', '\\tool', 'bin\\..\\..\\tool']) {
      refuses(edit((doc) => (doc['packages-dev'][0].bin = [bin])), `${JSON.stringify(bin)} is not a path in the package, as Composer installs a bin from`, 'packages-dev[0].bin[0]')
    }
    parseComposerLock(edit((doc) => (doc['packages-dev'][0].bin = ['bin\\tool', './bin/tool'])))
    refuses(edit((doc) => (doc['packages-dev'][0].keywords = ['10', '9'])), 'out of the order Composer sorts keywords in, after "10"', 'packages-dev[0].keywords[1]')
    refuses(edit((doc) => (doc['packages-dev'][0].abandoned = '')), '"", which Composer reads as no value and does not write', 'packages-dev[0].abandoned')
    refuses(edit((doc) => put(doc.packages[0], 'license', 'MIT')), 'expected a sequence, found the string "MIT"', at(0, '.license'))
    refuses(edit((doc) => put(doc.packages[0], 'extra', [])), 'expected a non-empty mapping or sequence, found a sequence', at(0, '.extra'))
    refuses(edit((doc) => put(doc.packages[0], 'scripts', { test: 'phpunit' })), 'expected a sequence, as Composer writes even one listener, found the string "phpunit"', at(0, '.scripts.test'))
    refuses(edit((doc) => put(doc.packages[0], 'notification-url', 'x')), '"x" is not an http(s) URL, which Composer posts installs to', at(0, '["notification-url"]'))
    // As Package::getTargetDir leaves it, `.` and `..` dropped: `""` of `.`,
    // as Composer 2.7 and later write it.
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', '../x')), '"../x" is not written as Composer writes a target-dir, "x"', at(0, '["target-dir"]'))
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', './x/../y')), '"./x/../y" is not written as Composer writes a target-dir, "x/y"', at(0, '["target-dir"]'))
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', '.')), '"." is not written as Composer writes a target-dir, ""', at(0, '["target-dir"]'))
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', 'C:/x')), '"C:/x" is an absolute path, of the machine the lockfile was written on', at(0, '["target-dir"]'))
    assert.deepEqual(['', 'x/y', 'x\\y'].map((dir) => parseComposerLock(edit((doc) => put(doc.packages[0], 'target-dir', dir))).packages['a/app'].targetDir), ['', 'x/y', 'x\\y'])
    // A `\` is a separator to getTargetDir and to Windows, where one that
    // leads is of the drive's root.
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', 'x\\..\\y')), '"x\\\\..\\\\y" is not written as Composer writes a target-dir, "x/y"', at(0, '["target-dir"]'))
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', '\\x')), '"\\\\x" is of the drive\'s root on Windows, and not under the package\'s directory', at(0, '["target-dir"]'))
    refuses(edit((doc) => put(doc.packages[0], 'target-dir', 'C:\\x')), '"C:/x" is an absolute path, of the machine the lockfile was written on', at(0, '["target-dir"]'))
  })

  it('a time as DATE_RFC3339 writes it, of a real date', () => {
    for (const time of ['2026-02-29T00:00:00+00:00', '2026-01-01T00:00:00Z', '2026-01-01T24:00:00+00:00', '2026-01-01T00:00:00+25:00', '1767225600']) {
      refuses(edit((doc) => (doc.packages[0].time = time)), `"${time}" is not a time as Composer writes one, as 2026-10-02T00:00:00+00:00`, at(0, '.time'))
    }
    parseComposerLock(edit((doc) => (doc.packages[0].time = '2024-02-29T23:59:59-24:59')))
  })
})

describe('the packages together', () => {
  it('refuses them out of Composer\'s order, or twice', () => {
    refuses(edit((doc) => (doc.packages = doc.packages.toReversed())), 'out of the order Composer sorts packages in, by name then version, after "c/new"', 'packages[1]')
    refuses(edit((doc) => doc['packages-dev'].unshift(structuredClone(doc.packages[0]))), 'listed twice, first as packages[0]', 'packages-dev[0]')
    refuses(edit((doc) => link(doc.packages[2], 'replace', 'a/app', '*')), '"a/app" is the name of packages[0], and replaced by it too, which Composer installs neither of', 'packages[2]')
  })

  it('aliases of the root\'s, as Composer writes them', () => {
    refuses(edit((doc) => (doc.aliases[0].package = 'z/none')), '"z/none" is not a package in the lockfile, by its name in lowercase', 'aliases[0].package')
    refuses(edit((doc) => (doc.aliases[0].version = '2.0.x-dev')), '"2.0.x-dev" is not a version normalized, as Composer writes it', 'aliases[0].version')
    refuses(edit((doc) => (doc.aliases[0].version = 'dev-master')), '"dev-master", which Composer writes as 9999999-dev', 'aliases[0].version')
    refuses(edit((doc) => (doc.aliases[0].alias_normalized = '2.0.1')), 'expected "2.0.1.0", the alias normalized', 'aliases[0].alias_normalized')
    refuses(edit((doc) => doc.aliases.unshift({ ...doc.aliases[0], package: 'd/tool' })), 'out of the order Composer sorts aliases in, by package, after "d/tool"', 'aliases[1]')
    // Of a package in require and in require-dev both, and of its branch
    // alias's version: each an alias of the package, whatever its version.
    const lock = parseComposerLock(edit((doc) => {
      doc.aliases.push({ ...doc.aliases[0], alias: '3.0.0', alias_normalized: '3.0.0.0' })
      doc.aliases.push({ ...doc.aliases[0], version: '2.0.9999999.9999999-dev', alias: '4.0.0', alias_normalized: '4.0.0.0' })
    }))
    assert.deepEqual(lock.packages['b/lib'].aliases.filter((alias) => alias.root).map((alias) => alias.version), ['2.0.1', '3.0.0', '4.0.0'])
    assert.deepEqual(lock.aliases.map((alias) => alias.version), ['dev-main', 'dev-main', '2.0.9999999.9999999-dev'])
  })

  it('refuses a stability the lockfile does not take', () => {
    refuses(edit((doc) => delete doc['stability-flags']['d/tool']), 'of stability beta, which minimum-stability, stable, and stability-flags do not take, and Composer installs nothing against', 'packages-dev[0]')
    parseComposerLock(edit((doc) => {
      delete doc['stability-flags']['d/tool']
      doc['minimum-stability'] = 'beta'
    }))
  })

  it('refuses a conflict a package in the lockfile meets', () => {
    refuses(edit((doc) => put(doc['packages-dev'][0], 'conflict', { 'c/old': '>=3' })), 'conflicts with c/new v3.1.0, which the lockfile has', 'packages-dev[0].conflict["c/old"]')
    refuses(edit((doc) => put(doc['packages-dev'][0], 'conflict', { 'b/lib': '^2.0' })), 'conflicts with b/lib 2.0.x-dev, an alias of dev-main, which the lockfile has', 'packages-dev[0].conflict["b/lib"]')
    parseComposerLock(edit((doc) => put(doc['packages-dev'][0], 'conflict', { 'c/old': '<3', 'x/impl': '*' })))
  })

  it('reads a branch alias of a dev version as ArrayLoader does', () => {
    refuses(edit((doc) => (doc.packages[1].extra['branch-alias']['dev-main'] = 2)), 'expected a string, as Composer reads a branch alias of a dev version', 'packages[1].extra["branch-alias"]["dev-main"]')
    const none = parseComposerLock(edit((doc) => {
      doc.packages[1].extra['branch-alias'] = { 'dev-other': '3.x-dev' }
      doc.packages[0].require['b/lib'] = 'dev-main'
    }))
    assert.deepEqual(none.packages['b/lib'].aliases.map((alias) => alias.version), ['9999999-dev', '2.0.1'])
  })

  it('without composer.json, lets be a requirement nothing in the lockfile meets, as the root may provide it', () => {
    const lock = parseComposerLock(edit((doc) => {
      link(doc.packages[0], 'require', 'z/root-provides', '^1.0')
      link(doc.packages[0], 'require', 'c/new', '^4.0')
      link(doc.packages[0], 'require', 'd/tool', '*')
    }))
    assert.deepEqual(['z/root-provides', 'c/new', 'd/tool'].map((name) => lock.packages['a/app'].require[name].targets), [[], [], []])
  })
})

describe('with composer.json', () => {
  const JSON_ = JSON.stringify({ name: 'fixture/root', require: { 'a/app': '^1.0', 'b/lib': 'dev-main as 2.0.1' }, 'require-dev': { 'd/tool': '^1.5@beta' } })
  const with_ = (text, json = JSON_) => parseComposerLock(text, { composerJson: json })
  const root = (change) => {
    const json = JSON.parse(JSON_)
    change(json)
    return JSON.stringify(json)
  }

  it('compares the content-hash, and is fresh where it is composer.json\'s', () => {
    assert.equal(with_(encode(BASE)).fresh, false)
    // Locker::getContentHash of JSON_: md5 of its name, require and
    // require-dev, sorted, as json_encode writes them with no flags.
    assert.equal(with_(edit((doc) => (doc['content-hash'] = '4ab43a9484f1f1184ffcc5527d7b0031'))).fresh, true)
  })

  it('holds the lockfile to what the root requires', () => {
    refuses(encode(BASE), 'nothing in the lockfile that composer install --no-dev installs meets it, which composer install refuses', 'composerJson.require["z/missing"]', { composerJson: root((json) => (json.require['z/missing'] = '*')) })
    refuses(encode(BASE), 'nothing in the lockfile that composer install --no-dev installs meets it, which composer install refuses', 'composerJson.require["d/tool"]', { composerJson: root((json) => (json.require['d/tool'] = '*')) })
    refuses(encode(BASE), 'nothing in the lockfile meets it, which composer install refuses', 'composerJson["require-dev"]["a/app"]', { composerJson: root((json) => (json['require-dev']['a/app'] = '^2.0')) })
  })

  it('takes what the root provides or replaces for a requirement', () => {
    const text = edit((doc) => link(doc.packages[0], 'require', 'z/polyfill', '*'))
    refuses(text, 'nothing that composer install --no-dev installs meets it', 'packages[0].require["z/polyfill"]', { composerJson: JSON_ })
    assert.deepEqual(with_(text, root((json) => (json.replace = { 'z/polyfill': '*' }))).packages['a/app'].require['z/polyfill'].targets, [])
  })

  it('refuses a requirement of packages only packages-dev meets', () => {
    refuses(edit((doc) => link(doc.packages[0], 'require', 'd/tool', '*')), 'nothing that composer install --no-dev installs meets it, of d/tool 1.5.0-beta1, which the lockfile has', 'packages[0].require["d/tool"]', { composerJson: JSON_ })
  })

  it('refuses a conflict with the root, or what the root replaces in the lockfile', () => {
    refuses(encode(BASE), 'conflicts with c/new v3.1.0, which the lockfile has', 'composerJson.conflict["c/new"]', { composerJson: root((json) => (json.conflict = { 'c/new': '*' })) })
    refuses(encode(BASE), '"c/new" is replaced by of the root, and its name too, which Composer installs neither of', 'packages[2]', { composerJson: root((json) => (json.replace = { 'c/new': '*' })) })
  })

  it('refuses a composer.json Composer does not load', () => {
    refuses(encode(BASE), 'not JSON as PHP reads it: expected "," or "}", found the end of the file at line 1', 'composerJson', { composerJson: '{"name": "x/y"' })
    refuses(encode(BASE), 'a number past what a double holds, which Composer refuses of the file', 'composerJson.extra.n[1]', { composerJson: '{"extra": {"n": [1, -1e400]}}' })
    // As deep as json_decode reads at its depth of 512, the top one of it.
    const nested = (depth) => `{"extra": ${'['.repeat(depth - 1)}1${']'.repeat(depth - 1)}}`
    with_(encode(BASE), nested(511))
    refuses(encode(BASE), 'not JSON as PHP reads it: nested more than 511 deep at line 1', 'composerJson', { composerJson: nested(512) })
    with_(encode(BASE), '{"description": 1e400, "description": "x"}')
    refuses(encode(BASE), '"Fixture/Root" has capitals, which Composer refuses in composer.json', 'composerJson.name', { composerJson: root((json) => (json.name = 'Fixture/Root')) })
    refuses(encode(BASE), 'the root itself, which Composer refuses', 'composerJson.require["fixture/root"]', { composerJson: root((json) => (json.require['fixture/root'] = '*')) })
    refuses(encode(BASE), '"dev-main as foo" is not an alias of one version as another, which Composer refuses', 'composerJson.require["b/lib"]', { composerJson: root((json) => (json.require['b/lib'] = 'dev-main as foo')) })
    // RootPackageLoader::extractAliases takes the first alias in a part `|`
    // or `,` sets apart, and the rest as constraints.
    with_(encode(BASE), root((json) => (json.require['b/lib'] = '^3.0 || dev-main as 2.0.1')))
    refuses(encode(BASE), '"^3.0 || dev-main as foo" is not an alias of one version as another, which Composer refuses', 'composerJson.require["b/lib"]', { composerJson: root((json) => (json.require['b/lib'] = '^3.0 || dev-main as foo')) })
    refuses(encode(BASE), 'expected a mapping, found the string "oops"', 'composerJson.require', { composerJson: '{"require": "oops"}' })
    refuses(encode(BASE), 'expected a mapping, found a sequence', 'composerJson.replace', { composerJson: '{"replace": []}' })
    refuses(encode(BASE), 'expected a mapping, found null', 'composerJson["require-dev"]', { composerJson: '{"require-dev": null}' })
    refuses(encode(BASE), 'expected a string, found the bigint 3', 'composerJson.conflict["a/b"]', { composerJson: '{"conflict": {"a/b": 3}}' })
    refuses(encode(BASE), 'expected a string, found null', 'composerJson.name', { composerJson: '{"name": null}' })
    refuses(encode(BASE), 'expected a string, found the bigint 1', 'composerJson.version', { composerJson: '{"version": 1}' })
  })

  it('refuses a name of a link that Composer does not take, but a platform package\'s', () => {
    const provide = (name) => ({ composerJson: root((json) => (json.provide = { [name]: '*' })) })
    refuses(encode(BASE), '"A/B" has capitals, which Composer refuses in composer.json', 'composerJson.provide["A/B"]', provide('A/B'))
    refuses(encode(BASE), '"BAD NAME" is not a package name, a vendor and a package as Composer takes them', 'composerJson.provide["BAD NAME"]', provide('BAD NAME'))
    refuses(encode(BASE), '"a/b.json" ends in .json, which Composer refuses', 'composerJson.provide["a/b.json"]', provide('a/b.json'))
    refuses(encode(BASE), '"nul/x" has a name Windows reserves in it, which Composer refuses', 'composerJson.provide["nul/x"]', provide('nul/x'))
    assert.deepEqual(['PHP', 'ext-FOO'].map((name) => with_(encode(BASE), provide(name).composerJson).fresh), [false, false])
  })

  it('holds what is hashed of composer.json to Composer 2.10\'s schema', () => {
    const json = (value) => ({ composerJson: JSON.stringify(value) })
    const repository = (value) => json({ repositories: [value] })
    refuses(encode(BASE), '"master" is not as Composer\'s schema has it', 'composerJson.version', json({ version: 'master' }))
    refuses(encode(BASE), 'expected one of "dev", "alpha", "beta", "rc", "RC", "stable", found the string "Stable"', 'composerJson["minimum-stability"]', json({ 'minimum-stability': 'Stable' }))
    refuses(encode(BASE), 'expected true or false, found the string "yes"', 'composerJson["prefer-stable"]', json({ 'prefer-stable': 'yes' }))
    refuses(encode(BASE), 'expected a mapping or a sequence, found the string "x"', 'composerJson.extra', json({ extra: 'x' }))
    refuses(encode(BASE), 'expected a string or true or false, found the bigint 3', 'composerJson.config.platform.php', json({ config: { platform: { php: 3 } } }))
    refuses(encode(BASE), 'expected a mapping, found null', 'composerJson.config.platform', json({ config: { platform: null } }))
    refuses(encode(BASE), 'expected true or false, found the string "yes"', 'composerJson.repositories[0].canonical', repository({ type: 'composer', url: 'x', canonical: 'yes' }))
    refuses(encode(BASE), 'expected a type of repository Composer knows, found the string "nope"', 'composerJson.repositories[0].type', repository({ type: 'nope', url: 'x' }))
    refuses(encode(BASE), 'no "url", which Composer\'s schema requires', 'composerJson.repositories[0]', repository({ type: 'git' }))
    refuses(encode(BASE), 'no "version", which Composer\'s schema requires', 'composerJson.repositories[0].package', repository({ type: 'package', package: { name: 'a/b' } }))
    refuses(encode(BASE), 'a name, where the key names a repository, which Composer\'s schema refuses', 'composerJson.repositories.x.name', json({ repositories: { x: { type: 'path', url: 'x', name: 'x' } } }))
    const lock = parseComposerLock(encode(BASE), json({ version: 'dev-x as 1.0', extra: [], config: { platform: { php: false } }, repositories: [{ 'packagist.org': false }, { type: 'path', url: 'x', name: 'x', options: { symlink: null } }, { type: 'package', package: [] }] }))
    assert.equal(lock.fresh, false)
    assert.throws(() => parseComposerLock(encode(BASE), { composerJson: {} }), TypeError)
    assert.throws(() => parseComposerLock(encode(BASE), { composer: '{}' }), TypeError)
  })
})
