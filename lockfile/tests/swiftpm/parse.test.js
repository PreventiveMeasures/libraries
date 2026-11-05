import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { sha256Hex } from '../../src/sha256.js'
import { LockfileError, parsePackageResolved } from '../../swiftpm.js'
import { encode } from './write.js'

const HASH = 'a83bcc1eb645238502fa7c4471445697b0bf0c316057bdde9bfb30d907d2232c'
const REV = 'e3da04078777e6a1b72ce19981fbd6539b0847d8'
const LOG_URL = 'https://github.com/apple/swift-log.git'

const v1 = (pins) => `${encode({ object: { pins }, version: 1 }, ': ')}\n`
const v2 = (pins) => `${encode({ pins, version: 2 }, ' : ')}\n`
const v3 = (pins, originHash = HASH) => `${encode({ originHash, pins, version: 3 }, ' : ')}\n`

const legacy = (state = {}, fields = {}) => ({ package: 'swift-log', repositoryURL: LOG_URL, ...fields, state: { branch: null, revision: REV, version: '1.6.1', ...state } })
const AT_VERSION = Object.freeze({ revision: REV, version: '1.6.1' })
const REGISTRY_VERSION = Object.freeze({ version: '1.2.0' })
const pin = (state = AT_VERSION, fields = {}) => ({ identity: 'swift-log', kind: 'remoteSourceControl', location: LOG_URL, ...fields, state })
const registry = (fields = {}, state = REGISTRY_VERSION) => ({ identity: 'mona.LinkedList', kind: 'registry', location: '', ...fields, state })

const read = (text, options) => parsePackageResolved(text, options)
const plain = (value) => structuredClone(value)

// Refused at `where`, with `message` where given: the whole message, or a
// pattern it matches.
function refuses(text, where, message, options) {
  assert.throws(() => read(text, options), (error) => {
    assert.ok(error instanceof LockfileError, error)
    assert.equal(error.where, where)
    if (typeof message === 'string') assert.equal(error.message, message)
    else if (message !== undefined) assert.match(error.message, message)
    return true
  })
}

describe('the layout SwiftPM writes', () => {
  it('reads each version as written', () => {
    assert.equal(read(v1([legacy()])).version, 1)
    assert.equal(read(v2([pin()])).version, 2)
    assert.deepEqual(plain(read(v3([pin()]))), {
      version: 3,
      originHash: HASH,
      pins: { 'swift-log': { identity: 'swift-log', kind: 'remoteSourceControl', location: LOG_URL, name: undefined, originalLocation: undefined, version: '1.6.1', branch: undefined, revision: REV } },
    })
  })

  it('refuses the separator of the other writer', () => {
    refuses(`${encode({ object: { pins: [legacy()] }, version: 1 }, ' : ')}\n`, 'version', 'version: version 1 is written by TSCBasic\'s JSON, with ": " after a key, not " : "')
    refuses(`${encode({ pins: [pin()], version: 2 }, ': ')}\n`, 'version', 'version: version 2 is written by JSONEncoder, with " : " after a key, not ": "')
    refuses(v2([pin()]).replace('"kind" : ', '"kind": '), undefined, /^expected " : " after "kind", as after the file's first key, found .* at line 5$/u)
  })

  it('refuses JSON laid out otherwise', () => {
    refuses('', undefined, 'expected "{" alone on the first line, found nothing at line 1')
    refuses(JSON.stringify({ pins: [pin()], version: 2 }), undefined, /^expected "\{" alone on the first line/u)
    refuses(JSON.stringify({ pins: [pin()], version: 2 }, null, 4), undefined, 'expected 2 spaces of indentation and a key at line 2')
    refuses(`﻿${v2([pin()])}`, undefined, 'U+FEFF is not allowed at line 1')
    refuses(v2([pin()]).replace('  "pins"', '\t"pins"'), undefined, 'U+0009 is not allowed at line 2')
    refuses(v2([pin()]).replace('"version" : 2', '"version" : 2,'), undefined, 'expected a key after "," at line 14')
    refuses(`${v2([pin()]).trimEnd()},\n`, undefined, 'a comma after the last "}" at line 14')
    refuses(`${v2([pin()])}{}\n`, undefined, 'expected the end of the file after the last "}", found "{}" at line 15')
    refuses(v2([pin()]).replace('"version" : 2', '"version" : 02'), undefined, 'expected "," or the end of the line, found "2" at line 13')
    refuses(v2([pin()]).replace('"version" : 2', '"version" : 2.0'), undefined, /^expected "," or the end of the line/u)
  })

  it('takes line ends after the last "}", and refuses line ends of two kinds', () => {
    assert.equal(read(`${v2([pin()])}\n\n`).version, 2)
    refuses(v2([pin()]).replace('\n', '\r\n'), undefined, 'a LF line end, after CRLF ones at line 2')
  })

  it('refuses keys out of order or twice', () => {
    refuses(v2([pin()]).replace('"identity" : "swift-log",\n      "kind" : "remoteSourceControl"', '"kind" : "remoteSourceControl",\n      "identity" : "swift-log"'), undefined,
      '"identity" after "kind", where SwiftPM sorts an object\'s keys at line 5')
    refuses(v2([pin()]).replace('"kind" : "remoteSourceControl"', '"identity" : "swift-log"'), undefined, '"identity" is the key before too at line 5')
  })

  it('refuses escapes but of " and \\, and what JSON.stringify would not write', () => {
    refuses(v2([pin()]).replace('https://github.com/', 'https:\\/\\/github.com\\/'), undefined, /is not written as JSON writes/u)
    const branch = (raw) => v2([pin({ branch: 'main', revision: REV })]).replace('"main"', raw)
    assert.equal(read(branch(String.raw`"a\"b"`)).pins['swift-log'].branch, 'a"b')
    refuses(branch(String.raw`"a\nb"`), undefined, /escapes a control, which no field SwiftPM writes has at line 8$/u)
    refuses(branch(String.raw`"\ud800"`), undefined, /escapes a lone surrogate/u)
    refuses(branch('"\\u0061"'), undefined, /is not written as JSON writes "a"/u)
  })

  it('refuses no pins, as SwiftPM removes the file instead', () => {
    const message = /^an empty array, of no pins, where SwiftPM removes the file instead at line [23]$/u
    refuses('{\n  "pins" : [\n\n  ],\n  "version" : 2\n}\n', undefined, message)
    refuses('{\n  "pins" : [\n  ],\n  "version" : 2\n}\n', undefined, message)
    refuses('{\n  "object": {\n    "pins": [\n\n    ]\n  },\n  "version": 1\n}\n', undefined, /^an empty array/u)
  })

  it('refuses a container deeper than any SwiftPM writes', () => {
    const deep = v2([pin({ revision: REV, version: { a: { b: {} } } })])
    refuses(deep, undefined, /^a container deeper than any SwiftPM writes at line 10$/u)
  })
})

describe('the top of the file', () => {
  it('refuses a version this reader does not read', () => {
    refuses(`${encode({ pins: [pin()], version: 4 }, ' : ')}\n`, 'version', 'version: expected 1, 2 or 3, found the number 4')
    refuses(`${encode({ pins: [pin()], version: '2' }, ' : ')}\n`, 'version', 'version: expected 1, 2 or 3, found the string "2"')
    refuses(`${encode({ pins: [pin()] }, ' : ')}\n`, undefined, 'expected version, which SwiftPM writes in every Package.resolved')
  })

  it('refuses a field of another version, or none SwiftPM writes', () => {
    refuses(`${encode({ originHash: HASH, pins: [pin()], version: 2 }, ' : ')}\n`, undefined, 'unsupported field "originHash"')
    refuses(`${encode({ object: { pins: [legacy()] }, pins: [legacy()], version: 1 }, ': ')}\n`, undefined, 'unsupported field "pins"')
    refuses(`${encode({ object: { pins: [legacy()] }, x: 1, version: 1 }, ': ')}\n`, undefined, 'unsupported field "x"')
  })

  it('holds originHash of version 3 to a sha256 in lowercase hex, which SwiftPM always writes', () => {
    refuses(v3([pin()], HASH.toUpperCase()), 'originHash', /is not a sha256 in lowercase hex/u)
    refuses(`${encode({ pins: [pin()], version: 3 }, ' : ')}\n`, undefined, 'expected originHash, which SwiftPM writes in every version 3')
  })
})

describe('a repository\'s pin', () => {
  it('a version, a branch, or the commit alone', () => {
    const { pins } = read(v2([pin({ branch: 'release/1.x', revision: REV }, { identity: 'a', location: 'https://x.org/a' }), pin(), pin({ revision: REV }, { identity: 'z', location: 'https://x.org/z' })]))
    assert.deepEqual(Object.values(pins).map(({ version, branch, revision }) => [version, branch, revision]), [[undefined, 'release/1.x', REV], ['1.6.1', undefined, REV], [undefined, undefined, REV]])
  })

  it('refuses a branch and a version both, and no revision', () => {
    refuses(v2([pin({ branch: 'main', revision: REV, version: '1.6.1' })]), 'pins[0].state', 'pins[0].state: a branch and a version both, where SwiftPM writes one or neither')
    refuses(v2([pin({ version: '1.6.1' })]), 'pins[0].state', /^pins\[0\]\.state: expected revision/u)
    refuses(v1([legacy({ branch: 'main' })]), 'object.pins[0].state', /a branch and a version both/u)
  })

  it('refuses a revision that is not a full hash, in lowercase', () => {
    refuses(v2([pin({ revision: REV.slice(0, 7) })]), 'pins[0].state.revision', 'pins[0].state.revision: "e3da040" is not a full commit hash, as SwiftPM writes the commit it checked out')
    refuses(v2([pin({ revision: REV.toUpperCase() })]), 'pins[0].state.revision')
  })

  it('refuses null, which SwiftPM writes of version 1 alone', () => {
    refuses(v2([pin({ branch: null, revision: REV })]), 'pins[0].state.branch', 'pins[0].state.branch: expected a string, found null')
    refuses(v2([pin({ revision: REV }, { originalLocation: null })]), 'pins[0].originalLocation')
  })

  it('holds a branch to a name git takes for one', () => {
    for (const branch of ['main', 'release/1.x', '8d9834a', 'a"b']) assert.equal(read(v2([pin({ branch, revision: REV })])).pins['swift-log'].branch, branch)
    for (const branch of ['HEAD~1', '-x', 'a..b', 'a b', '', 'a/', 'x.lock']) refuses(v2([pin({ branch, revision: REV })]), 'pins[0].state.branch')
  })

  it('holds a version to the form TSCUtility.Version writes', () => {
    for (const version of ['0.0.0', '1.2.3-beta.1', '1.2.3-beta.01', '1.2.3+build.5', '1.2.3-', '1.2.3-a-b+c-d', '9007199254740991.0.0']) {
      assert.equal(read(v2([pin({ revision: REV, version })])).pins['swift-log'].version, version)
    }
    for (const version of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-be_ta', '1.2.3+a+b', ' 1.2.3', '1.2.3.4', '9007199254740992.0.0', '1.2.٣']) {
      refuses(v2([pin({ revision: REV, version })]), 'pins[0].state.version', /is not a version as SwiftPM writes one$/u)
    }
  })

  it('refuses originalLocation, which SwiftPM writes of a registry\'s package alone', () => {
    refuses(v2([pin(undefined, { originalLocation: LOG_URL })]), 'pins[0].originalLocation', /registry's package alone$/u)
  })

  it('refuses a repository by its path, which reads on one machine alone', () => {
    refuses(v2([pin(undefined, { kind: 'localSourceControl', location: '/src/swift-log' })]), 'pins[0].kind', /on the machine that wrote the lockfile/u)
    refuses(v1([legacy({}, { repositoryURL: '/src/swift-log' })]), 'object.pins[0].repositoryURL', /on the machine that wrote the lockfile/u)
    refuses(v2([pin(undefined, { location: 'file:///src/swift-log' })]), 'pins[0].location', /on the machine that wrote the lockfile/u)
  })

  it('refuses a kind SwiftPM does not write', () => {
    refuses(v2([pin(undefined, { kind: 'fileSystem' })]), 'pins[0].kind', 'pins[0].kind: "fileSystem" is not a kind SwiftPM writes: remoteSourceControl, localSourceControl or registry')
  })
})

describe('a repository\'s location and identity', () => {
  const at = (location, identity) => read(v2([pin(undefined, { identity, location })])).pins[identity]

  it('the last component, but a "/" that ends it, less ".git", in lowercase', () => {
    assert.equal(at('https://github.com/Apple/Swift-Log.git', 'swift-log').location, 'https://github.com/Apple/Swift-Log.git')
    assert.equal(at('https://github.com/apple/swift-log/', 'swift-log').identity, 'swift-log')
    assert.equal(at('https://github.com/apple/swift-log.git/', 'swift-log').identity, 'swift-log')
    assert.equal(at('https://github.com/apple/swift-log.GIT', 'swift-log.git').identity, 'swift-log.git')
    assert.equal(at('git@github.com:apple/swift-log.git', 'swift-log').identity, 'swift-log')
    assert.equal(at('ssh://git@github.com/apple/swift-log', 'swift-log').identity, 'swift-log')
    assert.equal(at('github.com:swift-log', 'github.com:swift-log').identity, 'github.com:swift-log')
  })

  it('refuses another identity, as a mirror of another name has SwiftPM write', () => {
    refuses(v2([pin(undefined, { identity: 'swift-log-mirror' })]), 'pins[0].identity', 'pins[0].identity: "swift-log-mirror" is not the identity of its location, "swift-log": SwiftPM writes one of another where a mirror of another name is configured, and without the mirror finds the package no pin')
    refuses(v2([pin(undefined, { identity: 'Swift-Log', location: 'https://github.com/apple/Swift-Log' })]), 'pins[0].identity')
  })

  it('refuses a location of no last component', () => {
    refuses(v2([pin(undefined, { identity: 'x', location: 'https://github.com/apple/.git' })]), 'pins[0].identity', /has no last component/u)
    refuses(v1([legacy({}, { repositoryURL: 'https://github.com/apple//' })]), 'object.pins[0].repositoryURL', /has no last component/u)
  })

  it('refuses what is not a URL of a host, ASCII and of no backslash', () => {
    const refused = [
      ['github.com/apple/swift-log', /is not a URL of a host that git fetches from/u],
      ['https://github.com/apple/swift-loǵ', /is not ASCII/u],
      ['https://github.com\\apple\\swift-log', /has a backslash/u],
      ['c:swift-log', /is a path on a drive to SwiftPM on Windows/u],
      ['https://github.com/apple/swift log', /is not a repository URL/u],
      ['ssh://-oProxyCommand=x/swift-log', /would read an option/u],
      ['ext::sh -c x', /is not a repository URL/u],
      ['ext::x/swift-log', /names a remote helper/u],
      ['', /expected a non-empty string/u],
    ]
    for (const [location, message] of refused) refuses(v2([pin(undefined, { identity: 'swift-log', location })]), 'pins[0].location', message)
  })
})

describe('a registry\'s pin', () => {
  it('by its identity, at a version, and where it was looked up from', () => {
    assert.deepEqual(plain(read(v2([registry({ originalLocation: 'https://github.com/mona/LinkedList' })])).pins['mona.LinkedList']), {
      identity: 'mona.LinkedList', kind: 'registry', location: undefined, name: undefined, originalLocation: 'https://github.com/mona/LinkedList', version: '1.2.0', branch: undefined, revision: undefined,
    })
  })

  it('refuses a location, a branch, a revision, and no version', () => {
    refuses(v2([registry({ location: 'https://x.org/a' })]), 'pins[0].location', 'pins[0].location: "https://x.org/a" where SwiftPM writes "", the location of no registry\'s package')
    refuses(v2([registry({}, { revision: REV, version: '1.2.0' })]), 'pins[0].state.revision', /SwiftPM writes no revision of a registry's package/u)
    refuses(v2([registry({}, { branch: 'main', version: '1.2.0' })]), 'pins[0].state.branch', /SwiftPM writes no branch/u)
    refuses(v2([registry({}, {})]), undefined, /^an empty object/u)
    refuses(v2([registry({}, { version: '1.2' })]), 'pins[0].state.version')
    refuses(v2([registry({ originalLocation: '/src/LinkedList' })]), 'pins[0].originalLocation', /on the machine that wrote the lockfile/u)
  })

  it('holds the identity to a registry\'s scope and name', () => {
    for (const identity of ['a.b', 'mona.Linked_List', 'm-o-n-a.a-b_c', `${'s'.repeat(39)}.${'n'.repeat(100)}`]) assert.ok(read(v2([registry({ identity })])).pins[identity])
    for (const identity of ['mona', 'mona.', '.x', '-mona.x', 'mona-.x', 'mo--na.x', 'mona.x_', 'mona.a__b', 'mona.a.b', 'mo_na.x', `${'s'.repeat(40)}.x`, `s.${'n'.repeat(101)}`, 'möna.x']) {
      refuses(v2([registry({ identity })]), 'pins[0].identity', /is not a registry's package, scope\.name$/u)
    }
  })
})

describe('the pins together', () => {
  const named = (identity) => registry({ identity })

  it('in the order SwiftPM sorts them: by identity, without case', () => {
    assert.deepEqual(Object.keys(read(v2([named('apple.y'), named('Mona.b'), named('mona.C'), named('Zed.x')])).pins), ['apple.y', 'Mona.b', 'mona.C', 'Zed.x'])
    assert.deepEqual(Object.keys(read(v2([named('a.b_c'), named('a.bb')])).pins), ['a.b_c', 'a.bb'])
    refuses(v2([named('Zed.x'), named('apple.y')]), 'pins[1]', 'pins[1]: "apple.y" after "Zed.x", where SwiftPM sorts pins by identity, without case')
    refuses(v2([pin(), named('mona.LinkedList')]), 'pins[1]', /after "swift-log"/u)
  })

  it('refuses an identity twice, in any case, as SwiftPM tells identities apart', () => {
    refuses(v2([named('mona.LinkedList'), named('mona.linkedlist')]), 'pins[1]', 'pins[1]: "mona.linkedlist" is the identity of pins[0] too, as SwiftPM compares identities, without case')
    refuses(v1([legacy(), legacy({}, { repositoryURL: 'https://gitlab.com/mirror/swift-log' })]), 'object.pins[1]', /is the identity of object\.pins\[0\] too/u)
  })

  it('by identity, an own key of a Record of no prototype, those of digits alone first, as JavaScript orders them', () => {
    const repository = (identity) => pin(undefined, { identity, location: `https://x.org/${identity}` })
    const { pins } = read(v2(['10', '9', '__proto__', 'constructor'].map(repository)))
    assert.equal(Object.getPrototypeOf(pins), null)
    assert.deepEqual(Object.keys(pins), ['9', '10', '__proto__', 'constructor'])
    assert.ok(Object.hasOwn(pins, '__proto__'))
    assert.equal(pins.__proto__.location, 'https://x.org/__proto__')
  })
})

describe('version 1', () => {
  it('a name, and each field of the state, null where none', () => {
    const resolved = read(v1([legacy({ branch: 'main', version: null }, { package: 'Logging' })]))
    assert.deepEqual(plain(resolved.pins['swift-log']), { identity: 'swift-log', kind: 'remoteSourceControl', location: LOG_URL, name: 'Logging', originalLocation: undefined, version: undefined, branch: 'main', revision: REV })
  })

  it('refuses a field left out, and a name of null, which SwiftPM writes of none', () => {
    refuses(v1([legacy({ branch: undefined })]), 'object.pins[0].state', 'object.pins[0].state: expected branch, which SwiftPM writes of every pin, null where it has none')
    refuses(v1([legacy({}, { package: null })]), 'object.pins[0].package', 'object.pins[0].package: expected a string, found null')
    refuses(v1([{ ...legacy(), package: undefined }]), 'object.pins[0]', 'object.pins[0]: expected package, which SwiftPM writes of every pin')
    refuses(v1([legacy({ revision: null })]), 'object.pins[0].state.revision', /expected a string, found null/u)
  })

  it('refuses the fields of version 2', () => {
    refuses(v1([pin()]), 'object.pins[0]', 'object.pins[0]: unsupported field "identity"')
  })

  it('refuses a name that would hide or reorder what is shown of it', () => {
    for (const name of ['Logging', 'Café', 'swift log', 'A+B']) assert.equal(read(v1([legacy({}, { package: name })])).pins['swift-log'].name, name)
    for (const name of ['Log‮ging', 'Log​ging', 'Log ging']) {
      refuses(v1([legacy({}, { package: name })]), 'object.pins[0].package', /is not a package's name, of no control, format or line separator character$/u)
    }
    refuses(v1([legacy({}, { package: 'Log﻿ging' })]), undefined, 'U+FEFF is not allowed at line 5')
    refuses(v1([legacy({}, { package: 'Log\u0085ging' })]), undefined, 'U+0085 is not allowed at line 5')
  })
})

describe('the options', () => {
  it('refuses what is not a string, and an option it does not take', () => {
    assert.throws(() => read(Buffer.from(v2([pin()]))), { name: 'TypeError', message: 'expected a string' })
    assert.throws(() => read(v2([pin()]), { podfile: '' }), { name: 'TypeError', message: 'unknown option "podfile", of manifest' })
    assert.throws(() => read(v3([pin()]), { manifest: 1 }), { name: 'TypeError', message: 'manifest: expected the manifest as a string or a Uint8Array' })
    assert.throws(() => read(v3([pin()]), { manifest: '\uD800' }), { name: 'TypeError', message: 'manifest: expected the manifest as well-formed text, or its bytes' })
  })

  it('hashes the manifest\'s bytes as SwiftPM decodes them: a BOM kept, a byte of no character as U+FFFD', () => {
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
    const bom = Buffer.from('﻿// swift-tools-version:6.0\n')
    assert.equal(read(v3([pin()], sha256(bom)), { manifest: bom }).version, 3)
    assert.equal(read(v3([pin()], sha256(bom)), { manifest: bom.toString('utf8') }).version, 3)
    const broken = Buffer.from([0x2F, 0x2F, 0xFF, 0xC3, 0x0A])
    assert.equal(read(v3([pin()], sha256(Buffer.from('//��\n'))), { manifest: broken }).version, 3)
    refuses(v3([pin()], sha256(broken)), 'originHash', /not the sha256 of the manifest given/u, { manifest: broken })
  })
})

describe('sha256', () => {
  it('is node:crypto\'s, of every length about a block\'s edges', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 151 + 7) % 256)
    for (let length = 0; length <= 300; length++) {
      assert.equal(sha256Hex(bytes.subarray(0, length)), createHash('sha256').update(bytes.subarray(0, length)).digest('hex'), `of ${length} bytes`)
    }
  })
})
