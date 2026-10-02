import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { LockfileError, parsePodfileLock } from '../../cocoapods.js'
import { sha1Hex } from '../../src/cocoapods/sha1.js'
import { random } from '../random.js'

const sha = (char) => char.repeat(40)
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

// As CocoaPods 1.17 writes it: a pod of a spec repo of its own, of a name
// it quotes; a root and its subspec from the trunk, with a dependency that
// names no pod, as one on another platform does; one by git, by a branch,
// at the commit it came to; one by path, of a prerelease.
const BASE = `PODS:
  - "A+B (1.0)"
  - Core (2.0.0):
    - Core/Base (= 2.0.0)
  - Core/Base (2.0.0):
    - Other (~> 1.0)
  - Git (0.1.0):
    - Missing (< 2.0, >= 1.0)
  - Local (1.0.0-beta.1)
  - Other (1.2.3)

DEPENDENCIES:
  - "A+B (= 1.0)"
  - Core (~> 2.0)
  - Git (from \`https://example.com/git.git\`, branch \`main\`)
  - Local (from \`../Local\`)

SPEC REPOS:
  https://example.com/specs.git:
    - "A+B"
  trunk:
    - Core
    - Other

EXTERNAL SOURCES:
  Git:
    :branch: main
    :git: https://example.com/git.git
  Local:
    :path: "../Local"

CHECKOUT OPTIONS:
  Git:
    :commit: ${COMMIT}
    :git: https://example.com/git.git

SPEC CHECKSUMS:
  "A+B": ${sha('a')}
  Core: ${sha('b')}
  Git: ${sha('c')}
  Local: ${sha('d')}
  Other: ${sha('e')}

PODFILE CHECKSUM: ${sha('f')}

COCOAPODS: 1.17.0
`

function edit(...edits) {
  let text = BASE
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `BASE has no ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  return text
}

const refuses = (text, message, where, options) => assert.throws(() => parsePodfileLock(text, options), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

const plain = (value) => structuredClone(value)

describe('a Podfile.lock', () => {
  const lock = parsePodfileLock(BASE)

  it('the version that wrote it, and the Podfile\'s checksum', () => {
    assert.deepEqual([lock.cocoapods, lock.podfileChecksum], ['1.17.0', sha('f')])
  })

  it('every pod, by name, with what its podspec depends on', () => {
    assert.deepEqual(Object.keys(lock.pods), ['A+B', 'Core', 'Core/Base', 'Git', 'Local', 'Other'])
    assert.deepEqual(plain(lock.pods['Core/Base']), { name: 'Core/Base', root: 'Core', version: '2.0.0', dependencies: [{ name: 'Other', requirements: ['~> 1.0'] }] })
    assert.deepEqual(plain(lock.pods.Git.dependencies), [{ name: 'Missing', requirements: ['< 2.0', '>= 1.0'] }])
    assert.equal(lock.pods.Local.version, '1.0.0-beta.1')
  })

  it('the Podfile\'s dependencies', () => {
    assert.deepEqual(plain(lock.dependencies), [
      { name: 'A+B', requirements: ['= 1.0'], external: false },
      { name: 'Core', requirements: ['~> 2.0'], external: false },
      { name: 'Git', requirements: [], external: true },
      { name: 'Local', requirements: [], external: true },
    ])
  })

  it('each root, from a spec repo or an external source, with its checksum and checkout', () => {
    assert.deepEqual(plain(lock.roots.Core), { name: 'Core', version: '2.0.0', pods: ['Core', 'Core/Base'], checksum: sha('b'), repo: 'trunk', external: undefined, checkout: undefined })
    assert.equal(lock.roots['A+B'].repo, 'https://example.com/specs.git')
    assert.deepEqual(plain(lock.roots.Git.external), { type: 'git', url: 'https://example.com/git.git', commit: undefined, tag: undefined, branch: 'main', submodules: undefined })
    assert.deepEqual(plain(lock.roots.Git.checkout), { type: 'git', url: 'https://example.com/git.git', commit: COMMIT, tag: undefined, branch: undefined, submodules: undefined })
    assert.deepEqual(plain(lock.roots.Local), { name: 'Local', version: '1.0.0-beta.1', pods: ['Local'], checksum: sha('d'), repo: undefined, external: { type: 'path', path: '../Local', options: {} }, checkout: undefined })
  })

  it('records with a null prototype', () => {
    for (const record of [lock.pods, lock.roots, lock.roots.Local.external.options]) assert.equal(Object.getPrototypeOf(record), null)
  })

  it('CRLF line ends throughout, as git may check it out with', () => {
    assert.deepEqual(plain(parsePodfileLock(BASE.replaceAll('\n', '\r\n'))), plain(lock))
    assert.throws(() => parsePodfileLock(BASE.replace('\n', '\r\n')), /a LF line end, after CRLF ones at line 2/u)
  })

  it('a lockfile of no pods, and none without a Podfile\'s checksum', () => {
    const empty = parsePodfileLock(`PODFILE CHECKSUM: ${sha('f')}\n\nCOCOAPODS: 1.17.0\n`)
    assert.deepEqual([Object.keys(empty.pods), Object.keys(empty.roots), empty.dependencies], [[], [], []])
    assert.equal(parsePodfileLock('COCOAPODS: 1.17.0\n').podfileChecksum, undefined)
  })
})

describe('the YAML CocoaPods writes', () => {
  it('refuses a comment, a tab, a byte order mark and a format character', () => {
    refuses(`# A comment\n${BASE}`, 'a comment, which CocoaPods does not write at line 1')
    refuses(edit(['  - Core (~> 2.0)', '\t- Core (~> 2.0)']), 'U+0009 is not allowed at line 14')
    refuses(`\uFEFF${BASE}`, 'U+FEFF is not allowed at line 1')
    refuses(edit([':path: "../Local"', ':path: "../Lo\u202Ecal"']), 'U+202E is not allowed at line 30')
  })

  it('refuses YAML YAMLHelper does not write', () => {
    refuses(edit(['  - Other (1.2.3)', '  - [Other]']), '"[Other]" is not a scalar as CocoaPods writes one at line 10')
    refuses(edit(['  - Other (1.2.3)', '  - &a Other (1.2.3)']), '"&a Other (1.2.3)" is not a scalar as CocoaPods writes one at line 10')
    refuses(edit(['  - Other (1.2.3)', '  - !str Other']), '"!str Other" is not a scalar as CocoaPods writes one at line 10')
    refuses(edit(['  - Other (1.2.3)', '  -']), 'expected one space and a value after "-" at line 10')
    refuses(edit(['  - Other (1.2.3)', '  -  Other (1.2.3)']), 'expected one space and a value after "-" at line 10')
    refuses(edit(['COCOAPODS: 1.17.0', 'COCOAPODS:  1.17.0']), 'more than one space after ":" at line 46')
    refuses(edit(['COCOAPODS: 1.17.0', 'COCOAPODS: "1.17.0']), 'a quoted scalar with no closing quote in "\\"1.17.0" at line 46')
    refuses(edit(['COCOAPODS: 1.17.0', 'COCOAPODS: "1.17.0" x']), '" x" after a quoted scalar at line 46')
    refuses(edit([`  Other: ${sha('e')}`, `  Other: ${sha('e')}\n  Other: ${sha('e')}`]), 'a second "Other" at line 43')
    refuses(edit(['    - Other (~> 1.0)', '    - Other (~> 1.0)\n       (2.0)']), 'bad indentation at line 7')
    refuses(edit(['    - Other (~> 1.0)', '      - Other (~> 1.0)']), 'line 6: expected "    - Other (~> 1.0)", as CocoaPods 1.17.0 writes it, found "      - Other (~> 1.0)"')
    refuses(edit(['COCOAPODS: 1.17.0', 'COCOAPODS:']), 'nothing under "COCOAPODS" at line 46')
    refuses(`PODS:\n${Array.from({ length: 10 }, (_, depth) => `${'  '.repeat(depth + 1)}- a${depth}:`).join('\n')}\n${'  '.repeat(11)}- b\n`, 'nested deeper than a Podfile.lock is at line 6')
    refuses(`COCOAPODS: ${'a'.repeat(2 ** 20)}\n`, 'a line longer than 1048576 characters at line 1')
    refuses('', 'an empty file, where CocoaPods writes its version at least at line 1')
    refuses('- COCOAPODS\n', 'expected a mapping at column 0 at line 1')
  })

  it('refuses a key longer than 1024 characters, its quotes counted, which Psych does not read', () => {
    const repo = (url) => edit(['  https://example.com/specs.git:', `  ${url}:`])
    // 1024 characters, in more UTF-16 code units than that.
    const url = `https://example.com/${'\u{1F600}'.repeat(1002)}`
    assert.equal(parsePodfileLock(repo(JSON.stringify(url))).roots['A+B'].repo, url)
    refuses(repo(JSON.stringify(`${url}x`)), 'a key longer than 1024 characters, which Psych does not read at line 19')
    refuses(repo(`https://example.com/${'x'.repeat(1005)}`), 'a key longer than 1024 characters, which Psych does not read at line 19')
  })

  it('refuses an escape but \\" and \\\\, as \\# which Psych does not read', () => {
    const message = (escape) => `"${escape}", an escape this reader does not take: CocoaPods writes \\# before {, $ and @, which Psych does not read back at line 30`
    refuses(edit([':path: "../Local"', ':path: "../\\#{Local}"']), message('\\\\#'))
    refuses(edit([':path: "../Local"', ':path: "../\\u00e9"']), message('\\\\u'))
  })

  it('reads a value as Psych reads it, refusing one that is not a string where CocoaPods wrote one', () => {
    const typed = (value, type) => `"${value}", which Psych reads as ${type}, where a Podfile.lock holds a string, a symbol, true or false at line 42`
    refuses(edit([`Other: ${sha('e')}`, 'Other: 1,000']), typed('1,000', 'an integer'))
    refuses(edit([`Other: ${sha('e')}`, 'Other: 1:30']), typed('1:30', 'a number'))
    refuses(edit([`Other: ${sha('e')}`, 'Other: 2026-10-02']), typed('2026-10-02', 'a date'))
    refuses(edit([`Other: ${sha('e')}`, 'Other: nUll']), typed('nUll', 'null'))
    refuses(edit([`Other: ${sha('e')}`, 'Other: off']), 'expected a string, found the boolean false', '["SPEC CHECKSUMS"].Other')
  })
})

describe('the layout', () => {
  it('refuses an order, a spacing or a quoting CocoaPods does not write', () => {
    refuses(edit(['  - Local (1.0.0-beta.1)\n  - Other (1.2.3)', '  - Other (1.2.3)\n  - Local (1.0.0-beta.1)']), 'line 9: expected "  - Local (1.0.0-beta.1)", as CocoaPods 1.17.0 writes it, found "  - Other (1.2.3)"')
    refuses(edit(['\n\nDEPENDENCIES', '\n\n\nDEPENDENCIES']), 'line 12: expected "DEPENDENCIES:", as CocoaPods 1.17.0 writes it, found ""')
    refuses(edit(['  - Other (1.2.3)', '  - "Other (1.2.3)"']), 'line 10: expected "  - Other (1.2.3)", as CocoaPods 1.17.0 writes it, found "  - \\"Other (1.2.3)\\""')
    refuses(edit([':path: "../Local"', ":path: '../Local'"]), 'line 30: expected "    :path: \\"../Local\\"", as CocoaPods 1.17.0 writes it, found "    :path: \'../Local\'"')
    refuses(BASE.slice(0, -1), 'line 46: expected a line end, as CocoaPods 1.17.0 writes it')
    refuses(`${BASE}\n`, 'line 47: expected the end of the file, as CocoaPods 1.17.0 writes it')
  })

  it('quotes yes, no, on and off from CocoaPods 1.10, and dates from 1.13', () => {
    const branch = (name, written, version) => edit(['branch `main`', `branch \`${name}\``], [':branch: main', `:branch: ${written}`], ['COCOAPODS: 1.17.0', `COCOAPODS: ${version}`])
    assert.equal(parsePodfileLock(branch('yes', "'yes'", '1.10.2')).roots.Git.external.branch, 'yes')
    refuses(branch('Yes', 'Yes', '1.9.3'), 'expected a string, found the boolean true', '["EXTERNAL SOURCES"].Git[":branch"]')
    assert.equal(parsePodfileLock(branch('2026-10-02', "'2026-10-02'", '1.13.0')).roots.Git.external.branch, '2026-10-02')
    refuses(branch('2026-10-02', "'2026-10-02'", '1.12.1'), 'line 27: expected "    :branch: 2026-10-02", as CocoaPods 1.12.1 writes it, found "    :branch: \'2026-10-02\'"')
  })
})

describe('the sections', () => {
  it('refuses a section CocoaPods does not write, and a lockfile without its version', () => {
    refuses(edit(['COCOAPODS: 1.17.0', 'COCOAPODS: 1.17.0\n\nOTHER: x']), 'unsupported section "OTHER" at line 48')
    refuses(edit(['\n\nCOCOAPODS: 1.17.0', '']), 'expected COCOAPODS, the version of CocoaPods that wrote the file, which it always writes')
  })

  it('refuses an empty section, list of dependencies or spec repo, which CocoaPods leaves out', () => {
    refuses(edit([`CHECKOUT OPTIONS:\n  Git:\n    :commit: ${COMMIT}\n    :git: https://example.com/git.git`, 'CHECKOUT OPTIONS:\n  {}']), 'an empty CHECKOUT OPTIONS, which CocoaPods leaves out at line 32')
    refuses(edit(['DEPENDENCIES:\n', 'OTHER:\n  []\n\nDEPENDENCIES:\n']), 'unsupported section "OTHER" at line 12')
    refuses(edit(['  - Other (1.2.3)', '  - Other (1.2.3):\n    []']), 'nothing under "Other (1.2.3)" at line 10')
    refuses(edit(['  - Other (1.2.3)', '  - Other (1.2.3):\n      []']), 'none it depends on, where CocoaPods writes the pod alone', 'PODS[5]["Other (1.2.3)"]')
    refuses(edit(['    - "A+B"\n', '    - "A+B"\n  other:\n    []\n']), 'no pod of the spec repo, where CocoaPods leaves it out', '["SPEC REPOS"].other')
  })

  it('refuses a CocoaPods before 1.5 or after 1.x', () => {
    for (const version of ['1.4.0', '2.0.0', '0.39.0', '1.17.0.1', 'nope']) {
      refuses(edit(['COCOAPODS: 1.17.0', `COCOAPODS: ${version}`]), `"${version}" is not a version of CocoaPods from 1.5 to 1.x, which this reader reads`, 'COCOAPODS')
    }
    assert.equal(parsePodfileLock(edit(['COCOAPODS: 1.17.0', 'COCOAPODS: 1.16.0.rc.1'])).cocoapods, '1.16.0.rc.1')
  })

  it('refuses a section of another shape', () => {
    refuses(edit(['COCOAPODS: 1.17.0', 'COCOAPODS:\n  - 1.17.0']), 'expected a string, found a sequence', 'COCOAPODS')
    refuses(edit([`PODFILE CHECKSUM: ${sha('f')}`, 'PODFILE CHECKSUM: F00']), '"F00" is not a sha1 in lowercase hex', '["PODFILE CHECKSUM"]')
    refuses(BASE.replace(/^PODS:\n[^]*?\n\n/u, 'PODS:\n  A: B\n\n'), 'expected a sequence, found a mapping', 'PODS')
    refuses(edit(['COCOAPODS: 1.17.0', "COCOAPODS: '1.17'"]), '"1.17" is not a version of CocoaPods from 1.5 to 1.x, which this reader reads', 'COCOAPODS')
  })
})

describe('pods', () => {
  it('refuses a pod not as Specification#to_s writes it', () => {
    refuses(edit(['  - Other (1.2.3)', '  - Other']), '"Other" is not a pod and its version, as CocoaPods writes them', 'PODS[5]')
    refuses(edit(['  - Other (1.2.3)', '  - Other (v1.2.3)']), '"v1.2.3" is not a version', 'PODS[5]')
    refuses(edit(['  - Other (1.2.3)', '  - ".Other (1.2.3)"']), '".Other" is not a pod\'s name', 'PODS[5]')
    // A name of 1024 characters is read, to be refused for what follows.
    const subspec = (length) => `Other/${'x'.repeat(length - 6)}`
    assert.throws(() => parsePodfileLock(edit(['  - Other (1.2.3)', `  - ${subspec(1024)} (1.2.3)`])), /^LockfileError: PODS\[5\]: "Other\/x+…" is not one the Podfile's dependencies lead to/u)
    assert.throws(() => parsePodfileLock(edit(['  - Other (1.2.3)', `  - ${subspec(1025)} (1.2.3)`])), /^LockfileError: PODS\[5\]: "Other\/x+…" is not a pod's name$/u)
    refuses(edit(['    - Other (~> 1.0)', '    - Other (~> 1.0):\n      - Deeper']), 'expected a string, found a mapping', 'PODS[2]["Core/Base (2.0.0)"][0]')
  })

  it('refuses requirements not as Gem::Requirement writes them', () => {
    const at = 'PODS[3]["Git (0.1.0)"][0]'
    refuses(edit(['(< 2.0, >= 1.0)', '(>= 1.0, < 2.0)']), '"< 2.0" after ">= 1.0", where CocoaPods sorts requirements', at)
    refuses(edit(['(< 2.0, >= 1.0)', '(<2.0)']), '"<2.0" is not a requirement, as CocoaPods writes one', at)
    refuses(edit(['(< 2.0, >= 1.0)', '(>= 0)']), '">= 0", which CocoaPods writes as no requirement at all', at)
    refuses(edit(['(< 2.0, >= 1.0)', '(from `../Missing`)']), '"Missing (from `../Missing`)" names an external source, which only the Podfile\'s dependencies do', at)
  })

  it('refuses a pod twice, and a root\'s pods at two versions', () => {
    refuses(edit(['  - Other (1.2.3)', '  - Other (1.2.3)\n  - Other (1.2.4)']), 'a second "Other"', 'PODS[6]')
    refuses(edit(['  - Core/Base (2.0.0):', '  - Core/Base (2.0.1):']), 'at "2.0.1", where its root\'s other pods are at "2.0.0"', 'PODS[2]')
  })

  it('refuses a pod the Podfile\'s dependencies do not lead to', () => {
    const text = edit(['  - Other (1.2.3)', '  - Other (1.2.3)\n  - Stray (1.0)'], ['    - Other\n', '    - Other\n    - Stray\n'], [`  Other: ${sha('e')}`, `  Other: ${sha('e')}\n  Stray: ${sha('e')}`])
    refuses(text, '"Stray" is not one the Podfile\'s dependencies lead to, which CocoaPods would not install', 'PODS[6]')
  })
})

describe('in time linear in its length', () => {
  // Refused within a second: V8 hashes a string past 16383 characters by
  // its length alone, so a table of thousands of them took seconds.
  const quick = (text) => {
    const start = performance.now()
    assert.throws(() => parsePodfileLock(text), LockfileError)
    const took = performance.now() - start
    assert.ok(took < 1000, `${Math.round(took)} ms`)
  }
  const long = (index) => `P${'x'.repeat(16400)}${index}`

  it('many keys, or names, past 16383 characters', () => {
    quick(`SPEC CHECKSUMS:\n${Array.from({ length: 2000 }, (_, index) => `  ${long(index)}: ${sha('a')}`).join('\n')}\n`)
    quick(`PODS:\n${Array.from({ length: 2000 }, (_, index) => `  - ${long(index)} (1.0)`).join('\n')}\n`)
  })
})

describe('roots', () => {
  it('refuses a root without a checksum, or a checksum of no root', () => {
    refuses(edit([`  Other: ${sha('e')}\n`, '']), 'no checksum of "Other" in SPEC CHECKSUMS, which CocoaPods writes of every podspec', 'PODS[5]')
    refuses(edit([`  Other: ${sha('e')}`, `  Other: ${sha('e')}\n  Stray: ${sha('e')}`]), '"Stray" is the root of no pod in PODS', '["SPEC CHECKSUMS"].Stray')
    refuses(edit([`  Other: ${sha('e')}`, '  Other: abc0']), '"abc0" is not a sha1 in lowercase hex', '["SPEC CHECKSUMS"].Other')
    refuses(edit([`  Core: ${sha('b')}`, `  Core/Base: ${sha('b')}`]), '"Core/Base" is a subspec\'s name, where a root\'s is', '["SPEC CHECKSUMS"]["Core/Base"]')
  })

  it('refuses a root of no spec repo and no external source, or of two', () => {
    refuses(edit(['    - Other\n', '']), '"Other" is from no spec repo and no external source', 'PODS[5]')
    refuses(edit(['    - Core\n', '    - Core\n    - Local\n']), '"Local" is from an external source and a spec repo both', '["EXTERNAL SOURCES"].Local')
    refuses(edit(['    - "A+B"\n', '    - "A+B"\n    - Core\n']), '"Core" is in "https://example.com/specs.git" too', '["SPEC REPOS"].trunk[0]')
    refuses(edit(['    - Other\n', '    - Other\n    - Stray\n']), '"Stray" is the root of no pod in PODS', '["SPEC REPOS"].trunk[2]')
  })
})

describe('the Podfile\'s dependencies', () => {
  it('refuses one of no pod in PODS', () => {
    refuses(edit(['  - Core (~> 2.0)', '  - Core (~> 2.0)\n  - Core/Missing']), '"Core/Missing" is no pod in PODS', 'DEPENDENCIES[2]')
  })

  it('takes a name twice, as two targets ask for it', () => {
    assert.equal(parsePodfileLock(edit(['  - Core (~> 2.0)', '  - Core (~> 2.0)\n  - Core (~> 2.0)'])).dependencies.length, 5)
  })

  it('holds a description to the external source', () => {
    refuses(edit(['branch `main`)', 'tag `main`)']), '"from `https://example.com/git.git`, tag `main`" is not "from `https://example.com/git.git`, branch `main`", as CocoaPods describes the external source', 'DEPENDENCIES[2]')
    refuses(edit(['  - Local (from `../Local`)', '  - Local (from `../Local`)\n  - Other (from `../Other`)']), '"Other" has no external source in EXTERNAL SOURCES', 'DEPENDENCIES[4]')
    refuses(edit(['  - Local (from `../Local`)', '  - Local']), '"Local" is from an external source no dependency of the Podfile names', '["EXTERNAL SOURCES"].Local')
  })
})

// A dependency as YAMLHelper writes it: plain where it may be, else as
// Ruby's String#inspect writes it.
const scalar = (text) => (/^\w[\w/ ()~<>=.:`,-]*$/u.test(text) ? text : `"${text.replace(/["\\]/gu, '\\$&')}"`)

// A pod by `options`, from a Podfile that describes it so, with the
// checkout options `checkout`.
function external(options, description, checkout) {
  const yaml = (map) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `    :${key}:${value.startsWith('\n') ? '' : ' '}${value}`).join('\n')
  const text = edit(
    ['  Git:\n    :branch: main\n    :git: https://example.com/git.git', `  Git:\n${yaml(options)}`],
    [`  Git:\n    :commit: ${COMMIT}\n    :git: https://example.com/git.git`, checkout === undefined ? '' : `  Git:\n${yaml(checkout)}`],
    ['  - Git (from `https://example.com/git.git`, branch `main`)', `  - ${scalar(`Git (from ${description})`)}`],
  )
  return checkout === undefined ? text.replace('CHECKOUT OPTIONS:\n\n\n', '') : text
}

describe('external sources', () => {
  const GIT = 'https://example.com/git.git'

  it('git by a tag, a commit, or nothing, with submodules', () => {
    const tag = parsePodfileLock(external({ git: GIT, tag: 'v1' }, `\`${GIT}\`, tag \`v1\``, { git: GIT, tag: 'v1' })).roots.Git
    assert.deepEqual([tag.external.tag, tag.checkout.tag, tag.checkout.commit], ['v1', 'v1', undefined])
    const short = parsePodfileLock(external({ git: GIT, commit: 'abc1234' }, `\`${GIT}\`, commit \`abc1234\``, { git: GIT, commit: 'abc1234' })).roots.Git
    assert.equal(short.checkout.commit, 'abc1234')
    const upper = COMMIT.toUpperCase()
    assert.equal(parsePodfileLock(external({ git: GIT, commit: upper }, `\`${GIT}\`, commit \`${upper}\``, { git: GIT, commit: upper })).roots.Git.checkout.commit, upper)
    const sub = parsePodfileLock(external({ git: GIT, submodules: 'true' }, `\`${GIT}\``, { git: GIT, commit: COMMIT, submodules: 'true' })).roots.Git
    assert.deepEqual([sub.external.submodules, sub.checkout.submodules], [true, true])
  })

  it('a podspec, carrying options CocoaPods passes over, and a checkout of its own source', () => {
    const git = parsePodfileLock(external({ podspec: 'specs/Git.podspec', tag: 'hermes-1' }, '`specs/Git.podspec`', { git: 'https://example.com/other.git', commit: COMMIT })).roots.Git
    assert.deepEqual(plain(git.external), { type: 'podspec', podspec: 'specs/Git.podspec', options: { tag: 'hermes-1' } })
    assert.equal(git.checkout.url, 'https://example.com/other.git')
    assert.equal(parsePodfileLock(external({ podspec: 'https://example.com/Git.podspec' }, '`https://example.com/Git.podspec`')).roots.Git.checkout, undefined)
  })

  it('hg and svn, described by their URL alone', () => {
    const hg = parsePodfileLock(external({ hg: GIT, branch: 'default' }, `\`${GIT}\``, { hg: GIT, revision: COMMIT })).roots.Git
    assert.deepEqual([hg.external.type, hg.external.branch, hg.checkout.revision], ['hg', 'default', COMMIT])
    const svn = parsePodfileLock(external({ svn: GIT, tag: "'1.0'", folder: 'trunk' }, `\`${GIT}\``, { svn: GIT, tag: "'1.0'", folder: 'trunk' })).roots.Git
    assert.deepEqual([svn.checkout.tag, svn.checkout.folder, svn.checkout.revision], ['1.0', 'trunk', undefined])
  })

  it('a file over http with no headers, as YAMLHelper writes an empty sequence', () => {
    const zip = { http: 'https://example.com/Git.zip', headers: '\n      []' }
    const git = parsePodfileLock(external(zip, '`{:http=>"https://example.com/Git.zip", :headers=>[]}`', zip)).roots.Git
    assert.deepEqual([git.external.headers, git.checkout.headers], [[], []])
    refuses(external({ http: 'https://example.com/Git.zip', headers: '[]' }, '`{:http=>"https://example.com/Git.zip", :headers=>[]}`', zip), 'line 27: expected "    :headers:", as CocoaPods 1.17.0 writes it, found "    :headers: []"')
  })

  it('a file over http, described with Hash#inspect, of Ruby 3.3 and of 3.4', () => {
    const URL = 'https://example.com/Git.zip'
    const options = { http: URL, type: 'zip', flatten: 'false', headers: '\n      - "Accept: */*"\n      - "X-Token: a+b"' }
    const describedBy = (inspected) => parsePodfileLock(external(options, `\`${inspected}\``, options)).roots.Git
    const git = describedBy(`{:http=>"${URL}", :headers=>["X-Token: a+b", "Accept: */*"], :type=>"zip", :flatten=>false}`)
    assert.deepEqual(plain(git.external), { type: 'http', url: URL, fileType: 'zip', flatten: false, sha1: undefined, sha256: undefined, headers: ['Accept: */*', 'X-Token: a+b'] })
    assert.deepEqual(plain(git.checkout), plain(git.external))
    describedBy(`{type: "zip", http: "${URL}", flatten: false, headers: ["Accept: */*", "X-Token: a+b"]}`)
    assert.throws(() => describedBy(`{:http=>"${URL}", type: "zip", :flatten=>false, :headers=>["Accept: */*", "X-Token: a+b"]}`), /is not the options of EXTERNAL SOURCES, as Ruby's Hash#inspect writes them/u)
    assert.throws(() => describedBy(`{:http=>"${URL}", :type=>"zip", :headers=>["Accept: */*", "X-Token: a+b"]}`), /is not the options of EXTERNAL SOURCES/u)
  })

  it('refuses an argument of hg or svn either reads as an option, as cocoapods-downloader refuses one of hg\'s', () => {
    const at = '["EXTERNAL SOURCES"].Git'
    for (const [type, option, value] of [['hg', 'branch', '--config=x'], ['hg', 'revision', '-r'], ['hg', 'tag', 'v1 --config=x'], ['svn', 'folder', '-x'], ['svn', 'tag', '--depth=empty']]) {
      refuses(external({ [type]: GIT, [option]: `'${value}'` }, `\`${GIT}\``, { [type]: GIT, [option]: `'${value}'` }), `${JSON.stringify(value)} starts with "-", or has " --" in it, which ${type} would read as an option`, `${at}[":${option}"]`)
    }
    assert.equal(parsePodfileLock(external({ hg: GIT, branch: 'x - y' }, `\`${GIT}\``, { hg: GIT, revision: COMMIT })).roots.Git.external.branch, 'x - y')
  })

  it('refuses a spec repo git reads otherwise than as one', () => {
    refuses(edit(['  https://example.com/specs.git:', '  ssh://-oProxyCommand=x/specs.git:']), '"ssh://-oProxyCommand=x/specs.git" has a "-" where git or ssh would read an option', '["SPEC REPOS"]["ssh://-oProxyCommand=x/specs.git"]')
    refuses(edit(['  https://example.com/specs.git:', '  ext::sh:']), '"ext::sh" names a remote helper of git\'s, which is not supported', '["SPEC REPOS"]["ext::sh"]')
  })

  it('refuses options CocoaPods does not take, or reads as no source', () => {
    const at = '["EXTERNAL SOURCES"].Git'
    refuses(external({ git: GIT, rev: 'x' }, `\`${GIT}\``, { git: GIT, commit: COMMIT }), 'an option cocoapods-downloader does not take of :git', `${at}[":rev"]`)
    refuses(external({ git: GIT, http: GIT }, `\`${GIT}\``), 'both :git and :http, which CocoaPods reads as no source at all', at)
    refuses(external({ url: GIT }, `\`${GIT}\``), 'names no source CocoaPods knows: :podspec, :path, or one of :git, :hg, :http, :scp and :svn', at)
    refuses(external({ path: 'Git', git: GIT }, '`Git`'), 'beside :path, which CocoaPods reads alone', `${at}[":git"]`)
    refuses(edit([':branch: main', 'branch: main']), 'a key that is not a symbol, where CocoaPods reads options by symbol', `${at}.branch`)
  })

  it('refuses a value of a kind or a form CocoaPods would not download by', () => {
    const at = '["EXTERNAL SOURCES"].Git'
    refuses(external({ path: '"/Users/me/Git"' }, '`/Users/me/Git`'), '"/Users/me/Git" is absolute, and only reads on the machine that wrote it', `${at}[":path"]`)
    refuses(external({ path: '"~/Git"' }, '`~/Git`'), '"~/Git" is from a home directory, and only reads on the machine that wrote it', `${at}[":path"]`)
    refuses(external({ podspec: '"/specs/Git.podspec"' }, '`/specs/Git.podspec`'), '"/specs/Git.podspec" is absolute, and only reads on the machine that wrote it', `${at}[":podspec"]`)
    refuses(external({ path: 'a//Git' }, '`a//Git`'), '"a//Git" is not a path from the Podfile\'s directory', `${at}[":path"]`)
    refuses(external({ http: 'ftp://example.com/Git.zip' }, '`ftp://example.com/Git.zip`'), '"ftp://example.com/Git.zip" is not an http(s) URL', `${at}[":http"]`)
    refuses(external({ git: GIT, commit: 'main' }, `\`${GIT}\`, commit \`main\``, { git: GIT, commit: 'main' }), '"main" is not a commit\'s hash, and locks no commit', `${at}[":commit"]`)
    refuses(external({ git: GIT, commit: 'abc' }, `\`${GIT}\`, commit \`abc\``, { git: GIT, commit: 'abc' }), '"abc" is not a commit\'s hash, and locks no commit', `${at}[":commit"]`)
    refuses(external({ hg: GIT, revision: 'tip' }, `\`${GIT}\``, { hg: GIT, revision: 'tip' }), '"tip" is not a changeset\'s hash, and locks no revision', `${at}[":revision"]`)
    refuses(external({ svn: GIT, revision: 'HEAD' }, `\`${GIT}\``, { svn: GIT, revision: 'HEAD' }), '"HEAD" is not a revision\'s number, and locks no revision', `${at}[":revision"]`)
    assert.equal(parsePodfileLock(external({ hg: GIT, revision: 'ABC123def456' }, `\`${GIT}\``, { hg: GIT, revision: 'ABC123def456' })).roots.Git.checkout.revision, 'ABC123def456')
    refuses(external({ git: GIT, branch: 'a..b' }, `\`${GIT}\`, branch \`a..b\``, { git: GIT, commit: COMMIT }), '"a..b" is not a branch or tag name git takes', `${at}[":branch"]`)
    refuses(external({ git: GIT, submodules: "'true'" }, `\`${GIT}\``, { git: GIT, commit: COMMIT }), 'expected a boolean, found the string "true"', `${at}[":submodules"]`)
    refuses(external({ http: 'https://example.com/a.rar', type: 'rar' }, '`x`'), '"rar" is not a type of file CocoaPods extracts', `${at}[":type"]`)
  })
})

describe('checkout options', () => {
  const GIT = 'https://example.com/git.git'
  const at = '["CHECKOUT OPTIONS"].Git'

  it('refuses checkout options of a pod by path or of none from an external source', () => {
    const checkout = (root) => `  ${root}:\n    :commit: ${COMMIT}\n    :git: ${GIT}\n`
    refuses(edit([`\n\nSPEC CHECKSUMS`, `\n${checkout('Local')}\nSPEC CHECKSUMS`]), 'checkout options of a pod by :path, which CocoaPods keeps none of', '["CHECKOUT OPTIONS"].Local')
    refuses(edit(['CHECKOUT OPTIONS:\n', `CHECKOUT OPTIONS:\n${checkout('Core')}`]), '"Core" has no external source, and CocoaPods keeps checkout options of none other', '["CHECKOUT OPTIONS"].Core')
  })

  it('refuses a pod downloaded by git without them', () => {
    refuses(external({ git: GIT, branch: 'main' }, `\`${GIT}\`, branch \`main\``), 'no checkout options, which CocoaPods keeps of a pod by :git', '["EXTERNAL SOURCES"].Git')
  })

  it('refuses ones that are not what the source came to', () => {
    const git = (checkout, options) => {
      const given = options ?? { git: GIT, tag: 'v1' }
      const refs = ['commit', 'branch', 'tag'].filter((ref) => given[ref] !== undefined).map((ref) => `, ${ref} \`${given[ref]}\``).join('')
      return external(given, `\`${GIT}\`${refs}`, checkout)
    }
    refuses(git({ git: 'https://example.com/other.git', tag: 'v1' }), 'not by the :git and URL EXTERNAL SOURCES has', at)
    refuses(git({ git: GIT }), 'no :tag, which CocoaPods keeps of this download', at)
    refuses(git({ git: GIT, tag: 'v2' }), 'another :tag than EXTERNAL SOURCES has', at)
    refuses(git({ git: GIT, commit: COMMIT }), 'a :commit, which CocoaPods does not keep of this download', at)
    refuses(git({ git: GIT, commit: COMMIT, tag: 'v1' }), 'a :commit, which CocoaPods does not keep of this download', at)
    refuses(git({ git: GIT, commit: COMMIT }, { git: GIT, commit: 'abc1234' }), 'another :commit than EXTERNAL SOURCES has', at)
    refuses(git({ git: GIT, commit: COMMIT }, { git: GIT, submodules: 'true' }), 'no :submodules, which CocoaPods keeps of this download', at)
    refuses(git({ git: GIT, branch: 'main' }, { git: GIT, branch: 'main' }), 'no :commit, which CocoaPods keeps of this download', at)
    // What a download came to, CocoaPods keeps as git, hg and svn write it.
    refuses(git({ git: GIT, commit: 'abc1234' }, { git: GIT }), '"abc1234" is not the full commit hash CocoaPods keeps, as git rev-parse writes it', at)
    refuses(git({ git: GIT, commit: COMMIT.toUpperCase() }, { git: GIT }), `"${COMMIT.toUpperCase()}" is not the full commit hash CocoaPods keeps, as git rev-parse writes it`, at)
    assert.equal(parsePodfileLock(git({ git: GIT, commit: 'a'.repeat(64) }, { git: GIT })).roots.Git.checkout.commit, 'a'.repeat(64))
    refuses(external({ hg: GIT }, `\`${GIT}\``, { hg: GIT, revision: 'abc123def456' }), '"abc123def456" is not the full changeset hash CocoaPods keeps, as hg id writes it', at)
    refuses(external({ svn: GIT }, `\`${GIT}\``, { svn: GIT, revision: 'HEAD' }), '"HEAD" is not a revision\'s number, and locks no revision', `${at}[":revision"]`)
    refuses(git({ git: GIT, commit: COMMIT, tag: 'v1' }, { git: GIT, commit: 'abc1234', tag: 'v1' }), 'another :commit than EXTERNAL SOURCES has', at)
    const zip = { http: 'https://example.com/Git.zip' }
    refuses(external(zip, '`{:http=>"https://example.com/Git.zip"}`', { ...zip, type: 'zip' }), 'other than the options EXTERNAL SOURCES has, which CocoaPods keeps as they are of a file', at)
  })

  it('takes what a branch came to, resolved to a commit or kept where git does not find it', () => {
    const branched = (checkout) => parsePodfileLock(external({ git: GIT, branch: 'main', tag: 'v1' }, `\`${GIT}\`, branch \`main\`, tag \`v1\``, checkout)).roots.Git.checkout
    assert.deepEqual([branched({ git: GIT, commit: COMMIT, tag: 'v1' }).commit, branched({ git: GIT, branch: 'main', tag: 'v1' }).branch], [COMMIT, 'main'])
    refuses(external({ git: GIT, branch: 'main', tag: 'v1' }, `\`${GIT}\`, branch \`main\`, tag \`v1\``, { git: GIT, commit: COMMIT }), 'no :tag, which CocoaPods keeps of this download', at)
    const hg = (checkout) => external({ hg: GIT, branch: 'default' }, `\`${GIT}\``, checkout)
    refuses(hg({ hg: GIT, revision: COMMIT, branch: 'default' }), 'a :branch, which CocoaPods does not keep of this download', at)
    const svn = (checkout) => external({ svn: GIT, folder: 'trunk' }, `\`${GIT}\``, checkout)
    assert.equal(parsePodfileLock(svn({ svn: GIT, revision: "'42'" })).roots.Git.checkout.revision, '42')
    refuses(svn({ svn: GIT, revision: "'42'", folder: 'trunk' }), 'a :folder, which CocoaPods does not keep of this download', at)
  })
})

describe('the Podfile', () => {
  const podfile = "platform :ios, '15.0'\n"
  const checksum = createHash('sha1').update(podfile).digest('hex')
  const text = edit([`PODFILE CHECKSUM: ${sha('f')}`, `PODFILE CHECKSUM: ${checksum}`])

  it('is the one the checksum is of, as text or as bytes', () => {
    assert.equal(parsePodfileLock(text, { podfile }).podfileChecksum, checksum)
    assert.equal(parsePodfileLock(text, { podfile: new TextEncoder().encode(podfile) }).podfileChecksum, checksum)
    refuses(text, `not the sha1 of the Podfile given, ${createHash('sha1').update(`\uFEFF${podfile}`).digest('hex')}: the lockfile was written for another Podfile`, '["PODFILE CHECKSUM"]', { podfile: `\uFEFF${podfile}` })
    refuses(edit([`PODFILE CHECKSUM: ${sha('f')}\n\n`, '']), 'no PODFILE CHECKSUM to hold the Podfile to, which CocoaPods writes of a Podfile it reads from a file', undefined, { podfile })
  })

  it('refuses a TypeError for bad arguments', () => {
    assert.throws(() => parsePodfileLock(null), TypeError)
    assert.throws(() => parsePodfileLock(BASE, { other: 1 }), TypeError)
    assert.throws(() => parsePodfileLock(BASE, { podfile: 1 }), TypeError)
    assert.throws(() => parsePodfileLock(BASE, { podfile: '\uD800' }), /expected the Podfile as well-formed text, or its bytes/u)
  })
})

describe('sha1', () => {
  it('is node:crypto\'s, at every length about a block\'s edge and at random', () => {
    const { next } = random(0x5A_1)
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, ...Array.from({ length: 40 }, () => Math.floor(next() * 3000))]
    for (const length of lengths) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256))
      assert.equal(sha1Hex(bytes), createHash('sha1').update(bytes).digest('hex'), `length ${length}`)
    }
  })
})
