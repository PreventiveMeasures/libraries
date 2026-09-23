import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { YamlError, parseYaml, parseYamlStream } from '../index.js'

// Mappings come back with a null prototype, which strict deepEqual holds
// against a literal; structuredClone gives them Object.prototype back and
// changes nothing else, so every comparison goes through it.
const parse = (text) => structuredClone(parseYaml(text))

// A refusal is a YamlError with a message that says why, and the line it
// happened on when there is one — the two things a caller holding a broken
// file needs. `line` counts from zero here, as the property does.
const refuses = (text, message, line) => assert.throws(() => parseYaml(text), { name: 'YamlError', message, ...(line === undefined ? {} : { line }) })

describe('the shapes pnpm writes', () => {
  it('block mappings, nested by indentation, blank lines between', () => {
    assert.deepEqual(parse('a: 1\n\nb:\n  c: x\n\n\n  d:\n    e: y\nf: z\n'), { a: 1, b: { c: 'x', d: { e: 'y' } }, f: 'z' })
    assert.deepEqual(parse('a: 1'), { a: 1 })
  })

  it('sequences, at the top and under a key', () => {
    assert.deepEqual(parse('- a\n- b\n'), ['a', 'b'])
    assert.deepEqual(parse('k:\n  - a\n  - b\nl: 1\n'), { k: ['a', 'b'], l: 1 })
  })

  it('compact nodes inside a sequence entry', () => {
    assert.deepEqual(parse('- a: 1\n  b: 2\n- c: 3\n'), [{ a: 1, b: 2 }, { c: 3 }])
    assert.deepEqual(parse('- - a\n  - b\n- c\n'), [['a', 'b'], 'c'])
    assert.deepEqual(parse('-\n  a: 1\n- \n  - x\n'), [{ a: 1 }, ['x']])
    assert.deepEqual(parse('-   a: 1\n    b: 2\n'), [{ a: 1, b: 2 }])
  })

  it('flow collections of scalars', () => {
    assert.deepEqual(parse('a: {}\nb: []\nc: { }\nd: [ ]\n'), { a: {}, b: [], c: {}, d: [] })
    assert.deepEqual(parse('r: {integrity: sha512-a+b/c==, tarball: https://x.y/z.tgz}\n'), { r: { integrity: 'sha512-a+b/c==', tarball: 'https://x.y/z.tgz' } })
    assert.deepEqual(parse('cpu: [x64, arm64]\nos: [linux]\n'), { cpu: ['x64', 'arm64'], os: ['linux'] })
    assert.deepEqual(parse("e: {'0': node >=0.6.0, node: ^20.19.0 || >=22.12.0}\n"), { e: { 0: 'node >=0.6.0', node: '^20.19.0 || >=22.12.0' } })
    assert.deepEqual(parse("o: ['!win32', \"x\"]\nn: [1, true, null]\n"), { o: ['!win32', 'x'], n: [1, true, null] })
    assert.deepEqual(parse('a: [x,y]\nb: [1 2]\n'), { a: ['x', 'y'], b: ['1 2'] })
  })

  it('quoted scalars', () => {
    assert.deepEqual(parse("a: 'it''s'\nb: ''\nc: '9.0'\nd: 'a: b # c'\n"), { a: "it's", b: '', c: '9.0', d: 'a: b # c' })
    assert.deepEqual(parse('a: "x\\ty\\n\\"z\\" \\\\ \\/ \\0 \\a \\b \\e \\f \\r \\v \\N \\_ \\L \\P \\ "\n'), { a: 'x\ty\n"z" \\ / \u0000 \u0007 \b \u001B \f \r \v \u0085 \u00A0 \u2028 \u2029  ' })
    assert.deepEqual(parse('a: "\\x41\\u00e9\\U0001F600"\nb: ""\n'), { a: 'Aé😀', b: '' })
    assert.deepEqual(parse("'@scope/name': 1\n\"quoted key\": 2\n'': 3\n"), { '@scope/name': 1, 'quoted key': 2, '': 3 })
  })

  it('plain scalars keep their punctuation', () => {
    const doc = [
      'repo: git@github.com:juliangruber/isarray.git',
      'sum: sha512-kV/CThkXo6xyFEZUugw/+pIO==',
      'range: ^20.19.0 || >=22.12.0',
      'hash: a#b',
      'colon: a:b',
      'ws: workspace:*',
      'link: link:../x',
      'flag: --flag',
      'dash: -x',
      'q: ?x',
      'c: :x',
      'ver: 1.0.1',
      'pre: 2.0.0-beta.1',
      'flow: a, b [c] {d}',
      'spaced: a  b   c',
      'digits: 1 2',
      'colons: a :b',
      'unicode: 名前 😀',
      'nbsp: a\u00A0b',
      'trailing: x   ',
      'slash: /foo@1.0.0(bar@2.0.0)',
      'peer: 1.0.0_react@18.2.0',
    ].join('\n')
    assert.deepEqual(parse(doc), {
      repo: 'git@github.com:juliangruber/isarray.git',
      sum: 'sha512-kV/CThkXo6xyFEZUugw/+pIO==',
      range: '^20.19.0 || >=22.12.0',
      hash: 'a#b',
      colon: 'a:b',
      ws: 'workspace:*',
      link: 'link:../x',
      flag: '--flag',
      dash: '-x',
      q: '?x',
      c: ':x',
      ver: '1.0.1',
      pre: '2.0.0-beta.1',
      flow: 'a, b [c] {d}',
      spaced: 'a  b   c',
      digits: '1 2',
      colons: 'a :b',
      unicode: '名前 😀',
      nbsp: 'a\u00A0b',
      trailing: 'x',
      slash: '/foo@1.0.0(bar@2.0.0)',
      peer: '1.0.0_react@18.2.0',
    })
    assert.deepEqual(parse('/foo@1.0.0(bar@2.0.0): {}\nfoo@1.0.0_bar@2.0.0: {}\n.: 1\n'), { '/foo@1.0.0(bar@2.0.0)': {}, 'foo@1.0.0_bar@2.0.0': {}, '.': 1 })
  })

  it('the types the core schema gives a plain scalar, in the spellings JS prints', () => {
    assert.deepEqual(parse('a: true\nb: false\nc: null\n'), { a: true, b: false, c: null })
    assert.deepEqual(parse('a: 0\nb: -1\nc: 1.5\nd: 1e3\ne: 1E-2\nf: -0.5\ng: 5.4\nh: 9007199254740991\n'), { a: 0, b: -1, c: 1.5, d: 1000, e: 0.01, f: -0.5, g: 5.4, h: 9007199254740991 })
    assert.deepEqual(parse("a: 'true'\nb: \"1\"\nc: 18.2.0\nd: 1.0.1\ne: 1e5x\nf: Infinity\ng: NaN\nh: yes\ni: no\nj: on\nk: off\n"), { a: 'true', b: '1', c: '18.2.0', d: '1.0.1', e: '1e5x', f: 'Infinity', g: 'NaN', h: 'yes', i: 'no', j: 'on', k: 'off' })
    assert.ok(Object.is(parseYaml('a: -0.0').a, -0))
    // Close to a date, but not one to js-yaml either.
    assert.deepEqual(parse("a: 2001-1-1\nb: 2001-12-14x\nc: 20011-12-14\nd: 2001-12-14T21:59\ne: '2001-12-14'\n"), { a: '2001-1-1', b: '2001-12-14x', c: '20011-12-14', d: '2001-12-14T21:59', e: '2001-12-14' })
  })

  it('comments and blank lines, wherever they fall', () => {
    const doc = '# leading\n\na: 1 # after plain\nb: "x" # after quoted\nc: [1, 2] #after flow\n  # indented comment\nd:\n# comment at column 0 inside a block\n  e: 2\n- ignored? no: this is content\n'
    assert.deepEqual(parse(doc.slice(0, doc.lastIndexOf('- '))), { a: 1, b: 'x', c: [1, 2], d: { e: 2 } })
    assert.deepEqual(parse('- a # c\n- b #c\n'), ['a', 'b'])
    assert.deepEqual(parse('a: 1#c\nb: a#b#c\n'), { a: '1#c', b: 'a#b#c' })
    assert.deepEqual(parse('a: 1\n# trailing comment\n\n'), { a: 1 })
    assert.deepEqual(parse('a: # c\n  b: 1\nd: # e\n  - x\n'), { a: { b: 1 }, d: ['x'] })
    assert.deepEqual(parse('- # c\n  a: 1\n- #c\n  - b\n- c\n'), [{ a: 1 }, ['b'], 'c'])
    assert.deepEqual(parse('? k\n: # c\n  a: 1\n'), { k: { a: 1 } })
  })

  it('CRLF line endings', () => {
    assert.deepEqual(parse('a: 1\r\nb:\r\n  - x\r\n  - |-\r\n    l1\r\n    l2\r\n'), { a: 1, b: ['x', 'l1\nl2'] })
    assert.deepEqual(parse('a: |+\r\n  x\r\n\r\n  \r\nb: 1\r'), { a: 'x\n\n\n', b: 1 })
  })

  it("js-yaml's explicit key, for a key longer than 1024 characters", () => {
    const key = `@storybook/builder@7.6.17${'(peer@1.0.0)'.repeat(90)}`
    assert.ok(key.length > 1024)
    const doc = `packages:\n  ? '${key}'\n  : resolution: {integrity: x}\n    engines: {node: '>=1'}\n  short@1.0.0:\n    resolution: {integrity: y}\nsnapshots:\n  ? '${key}'\n  : {}\n  ? s\n  : scalar\n  ? t\n  : - a\n    - b\n  ? u\n  : |-\n    text\n`
    assert.deepEqual(parse(doc), {
      packages: { [key]: { resolution: { integrity: 'x' }, engines: { node: '>=1' } }, 'short@1.0.0': { resolution: { integrity: 'y' } } },
      snapshots: { [key]: {}, s: 'scalar', t: ['a', 'b'], u: 'text' },
    })
    // Up to 1024 characters, quotes included, a key needs no `? `; in a flow
    // mapping it never does.
    // Counted in UTF-16 units, as js-yaml's writer counts: 512 emoji it
    // writes without `? `.
    const edge = 'k'.repeat(1024)
    const emoji = String.fromCodePoint(0x1F600).repeat(512)
    assert.deepEqual(parse(`${edge}: 1\n'${edge.slice(2)}': 2\nl:\n  - a: {'${key}': 3}\n${emoji}: 4\n`), { [edge]: 1, [edge.slice(2)]: 2, l: [{ a: { [key]: 3 } }], [emoji]: 4 })
  })

  it('literal block scalars, with each chomping indicator', () => {
    assert.deepEqual(parse('a: |\n  x\n  y\nb: 1\n'), { a: 'x\ny\n', b: 1 })
    assert.deepEqual(parse('a: |-\n  x\n  y\n\nb: 1\n'), { a: 'x\ny', b: 1 })
    assert.deepEqual(parse('a: |+\n  x\n\n\nb: 1\n'), { a: 'x\n\n\n', b: 1 })
    assert.deepEqual(parse('a: |\n  x\n\n\n'), { a: 'x\n' })
    assert.deepEqual(parse('a: |-\nb: 1\n'), { a: '', b: 1 })
    assert.deepEqual(parse('a: |\nb: 1\n'), { a: '', b: 1 })
    assert.deepEqual(parse('a: |+\nb: 1\n'), { a: '', b: 1 })
  })

  it('literal block scalars keep every line as it is', () => {
    assert.deepEqual(parse('a: |\n  x\n\n  y\n'), { a: 'x\n\ny\n' })
    assert.deepEqual(parse('a: |\n  # not a comment\n  - not an entry\n  k: not a key\n  ? not a key either\n'), { a: '# not a comment\n- not an entry\nk: not a key\n? not a key either\n' })
    assert.deepEqual(parse('a: |\n  x\n    y\n  z\n'), { a: 'x\n  y\nz\n' })
    assert.deepEqual(parse('a: |\n  x  \n   \n  y\n'), { a: 'x  \n \ny\n' })
    assert.deepEqual(parse('a: |\n\n  x\n'), { a: '\nx\n' })
    assert.deepEqual(parse('a: |2-\n   x\n  y\n'), { a: ' x\ny' })
    assert.deepEqual(parse('- |-\n  x\n- y\n'), ['x', 'y'])
    assert.deepEqual(parse('- a: |\n    x\n  b: 1\n'), [{ a: 'x\n', b: 1 }])
    assert.deepEqual(parse('a:\n  b: |-\n    x\n  c: 1\nd: 2\n'), { a: { b: 'x', c: 1 }, d: 2 })
  })

  it('literal block scalars take their indentation from blank lines too, as js-yaml does', () => {
    assert.deepEqual(parse('a: |\n    \n  \nb: |+\n    \n\nc: |-\n   \n'), { a: '', b: '\n\n', c: '' })
    assert.deepEqual(parse('a: |\n\n  \n  x\n'), { a: '\n\nx\n' })
    assert.deepEqual(parse('a: |1\n   \n x\n'), { a: '  \nx\n' })
  })

  it('a stream of documents, each after a `---` line', () => {
    assert.deepEqual(parse('---\na: 1\n'), { a: 1 })
    assert.deepEqual(structuredClone(parseYamlStream('a: 1\n')), [{ a: 1 }])
    assert.deepEqual(structuredClone(parseYamlStream('---\na: 1\n---\n- x\n')), [{ a: 1 }, ['x']])
    assert.deepEqual(structuredClone(parseYamlStream('# c\n\na: 1\n\n# c\n---   \n\nb:\n  c: 2\n---\n{}\n')), [{ a: 1 }, { b: { c: 2 } }, {}])
    assert.deepEqual(parse('a: |\n  ---\n  x\nb: ---x\n'), { a: '---\nx\n', b: '---x' })
    assert.deepEqual(parse('a:\n  - ---\n'), { a: ['---'] })
    assert.deepEqual(parse('a:\n  - ...\n  - ... x\nb: ...\n...x: 1\n'), { a: ['...', '... x'], b: '...', '...x': 1 })
  })

  it('mappings have a null prototype, so special names are keys like any other', () => {
    const map = parseYaml('__proto__:\n  polluted: 1\nconstructor: 2\ntoString: 3\nhasOwnProperty: 4\n')
    assert.equal(Object.getPrototypeOf(map), null)
    assert.equal(Object.getPrototypeOf(map.__proto__), null)
    assert.deepEqual(Object.keys(map), ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    assert.deepEqual(structuredClone(map.__proto__), { polluted: 1 })
    assert.equal(map.constructor, 2)
    assert.equal(({}).polluted, undefined)
    assert.equal(Object.getPrototypeOf(parseYaml('a: {__proto__: 1}').a), null)
    assert.equal(parseYaml('a: {__proto__: 1}').a.__proto__, 1)
    assert.equal(parseYaml('- {}')[0].valueOf, undefined)
  })
})

describe('what it refuses', () => {
  const REFUSED = [
    // Nothing, or nothing but comments and blank lines.
    ['', /^empty document$/u],
    ['\n\n', /^empty document$/u],
    ['# only a comment\n', /^empty document$/u],
    // A document that is not a mapping or a sequence, or does not start at the margin.
    ['just text', /lone scalar/u, 0],
    ['# c\n\n42', /lone scalar, not a mapping or a sequence at line 3$/u, 2],
    ['a\nb', /unexpected content after the document at line 2/u, 1],
    ['[a]\nb: 1', /unexpected content after the document at line 2/u, 1],
    ['{a: 1}\n\n# c\n- b', /unexpected content after the document at line 4/u, 3],
    ['a: 1\n[b]', /expected a mapping key, found "\[b\]"/u, 1],
    ['  a: 1', /column 0/u, 0],
    // Directives, end markers, and streams where a single document is wanted.
    ['%YAML 1.2\n---\na: 1', /document end markers and directives/u, 0],
    ['...\n', /document end markers and directives/u, 0],
    ['a: 1\n...', /document end markers and directives are not supported at line 2/u, 1],
    // At column 0 `...` ends the document to js-yaml even where a key could
    // be read, and js-yaml writes such keys unquoted.
    ['a: 1\n... k: 2', /document end markers and directives are not supported at line 2/u, 1],
    ['- a\n...', /document end markers and directives/u, 1],
    ['a:\n  b: 1\n...  { k: 2', /document end markers and directives/u, 2],
    ['a: 1\n%x: 2', /document end markers and directives/u, 1],
    ['a: 1\n---\nb: 2\n', /^expected a single document, found 2$/u],
    ['---\n', /^empty document$/u],
    ['---\n---\na: 1\n', /^empty document at line 2$/u, 1],
    ['a: 1\n---\n', /^empty document$/u],
    ['a: 1\n---\n# only a comment\n', /^empty document$/u],
    ['--- a: 1\n', /content on the document marker line/u, 0],
    ['--- # c\na: 1\n', /content on the document marker line/u, 0],
    // At the start of a document js-yaml reads `---x: 1` as `---` then `x: 1`.
    ['---x: 1\n', /content on the document marker line at line 1/u, 0],
    ['a: 1\n---x: 2\n', /content on the document marker line at line 2/u, 1],
    ['---\n---x: 1\n', /content on the document marker line at line 2/u, 1],
    ['---|\n  x\n', /content on the document marker line/u, 0],
    ['---\n  a: 1\n', /column 0/u, 1],
    ['a:\n---\n', /missing value at line 1/u, 0],
    ['? a\n---\n', /expected ": " below the explicit key/u, 0],
    // Anchors, aliases, tags and merges: nothing beyond plain data.
    ['a: &x 1', /expected a scalar, found "&x 1"/u, 0],
    ['a: *x', /expected a scalar, found "\*x"/u, 0],
    ['a: !!str 1', /expected a scalar, found "!!str 1"/u, 0],
    ['a: !custom 1', /expected a scalar, found "!custom 1"/u, 0],
    ['a: !!js/function "x"', /expected a scalar/u, 0],
    ['<<: *base', /expected a scalar, found "\*base"/u, 0],
    ['a: @b', /expected a scalar, found "@b"/u, 0],
    ['a: `b', /expected a scalar, found "`b"/u, 0],
    ['a: %b', /expected a scalar, found "%b"/u, 0],
    // Block scalars other than `|`, and `|` with anything else in its header.
    ['a: >-\n  text', /unsupported block scalar ">-"/u, 0],
    ['a: |x\n  text', /unsupported block scalar "\|x"/u, 0],
    ['a: | # c\n  text', /unsupported block scalar/u, 0],
    ['a: |0\n  text', /unsupported block scalar/u, 0],
    ['a: |\n  x\n y', /bad indentation in the block scalar at line 3/u, 2],
    ['a: |2\n x', /bad indentation in the block scalar/u, 1],
    ['a: |\n    \n  x', /bad indentation in the block scalar at line 3/u, 2],
    // Flow collections: one line, one level, scalars only, no trailing comma.
    ['a: {b: 1,\n  c: 2}', /expected a scalar, found the end of the line/u, 0],
    ['a: {b: {c: 1}}', /expected a scalar, found "\{c: 1\}\}"/u, 0],
    ['a: [[1]]', /expected a scalar, found "\[1\]\]"/u, 0],
    ['a: [1, 2,]', /expected a scalar, found "\]"/u, 0],
    ['a: {b: 1} c', /unexpected " c" after the value/u, 0],
    ['a: {b: 1}}', /unexpected "\}" after the value/u, 0],
    ['a: {b:1}', /expected ": " after the key/u, 0],
    ['a: {b}', /expected ": " after the key/u, 0],
    ['a: {1: x}', /keys must be strings/u, 0],
    ['a: {b: 1, b: 2}', /duplicate key "b"/u, 0],
    ['a: {? b: 1}', /expected a scalar, found "\? b: 1\}"/u, 0],
    ['a: {b: 1 c: 2}', /expected "," or "\}", found ": 2\}"/u, 0],
    ['a: [1', /expected "," or "\]", found the end of the line/u, 0],
    // Mapping structure.
    ['a: 1\na: 2', /duplicate key "a" at line 2/u, 1],
    ['"\\u001B": 1\n"\\u001B": 2', /^duplicate key "\\u001b" at line 2$/u, 1],
    ['a:', /missing value at line 1/u, 0],
    ['a:\nb: 1', /missing value at line 1/u, 0],
    ['a: # a comment is not a value', /missing value at line 1/u, 0],
    ['- # nor here', /missing value at line 1/u, 0],
    ['? a\n: # nor here', /missing value at line 2/u, 1],
    ['a:\n- 1', /a sequence under a key must be indented/u, 1],
    ['? a\n:\n- 1', /a sequence under a key must be indented at line 3/u, 2],
    ['-\n- 1', /^missing value at line 1$/u, 0],
    ['- -\n  - 1', /^missing value at line 1$/u, 0],
    ['a: b: c', /unexpected ": c" after the value/u, 0],
    ['a : 1', /unexpected " : 1" after the value/u, 0],
    ['a: 1\n  b: 2', /bad indentation at line 2/u, 1],
    ['a:\n    b: 1\n  c: 2', /bad indentation at line 3/u, 2],
    ['a: 1\nb: 2\n c: 3', /bad indentation at line 3/u, 2],
    ['a: 1\n- b', /expected a mapping key, found "- b"/u, 1],
    ['- a\nb: 1', /expected "- ", found "b: 1"/u, 1],
    ['a:\n  - b\n  c: 1', /expected "- ", found "c: 1"/u, 2],
    ['- a: 1\n b: 2', /bad indentation at line 2/u, 1],
    ['a: - b', /expected a scalar, found "- b"/u, 0],
    ['a: ? b', /expected a scalar, found "\? b"/u, 0],
    ['a: : b', /expected a scalar, found ": b"/u, 0],
    // Past 1024 characters, quotes included, a key needs `? `: js-yaml reads
    // one without, but a reader true to the spec does not.
    [`${'k'.repeat(1025)}: 1`, /^a key longer than 1024 characters is written after "\? " at line 1$/u, 0],
    [`a:\n  '${'k'.repeat(1023)}': 1`, /a key longer than 1024 characters/u, 1],
    [`- ${'k'.repeat(1025)}: 1`, /a key longer than 1024 characters/u, 0],
    // In UTF-16 units, as the yaml package counts: 514 characters, 1026 units.
    [`'${String.fromCodePoint(0x1F600).repeat(512)}': 1`, /a key longer than 1024 characters/u, 0],
    // Explicit keys need their `: ` line, and keys of any kind must be strings.
    ['? a', /expected ": " below the explicit key at line 1/u, 0],
    ['? a\nb: 1', /expected ": " below the explicit key at line 2/u, 1],
    ['? a\n:b', /expected ": " below the explicit key at line 2/u, 1],
    ['? [a]\n: 1', /keys must be strings/u, 0],
    ['? {}\n: 1', /keys must be strings/u, 0],
    ['1: a', /keys must be strings/u, 0],
    ['true: a', /keys must be strings/u, 0],
    ['null: a', /keys must be strings/u, 0],
    ['1.5: a', /keys must be strings/u, 0],
    // Plain scalars the core schema would type by a rule this parser does not
    // have, `-0`, which is 0 to js-yaml and -0 to JSON.parse, and the dates
    // and timestamps js-yaml reads as a Date.
    ...['~', 'Null', 'NULL', 'True', 'TRUE', 'False', '0x1F', '0o17', '0b101', '1_000', '.5', '1.', '+1', '01', '00', '.inf', '-.Inf', '+.INF', '.nan', '.NaN', '1_0.5', '-0x1', '-0', '2001-12-14', '2001-12-14t21:59:43.10-05:00', '2001-12-14 21:59:43.10 -5', '2001-1-1T1:00:00Z', '2001-12-14T21:59:43Z'].map((v) => [`a: ${v}`, new RegExp(`^ambiguous scalar "${v.replace(/[.+]/gu, '\\$&')}", quote it at line 1$`, 'u'), 0]),
    ['- 0x1F', /ambiguous scalar "0x1F"/u, 0],
    ['a: [~]', /ambiguous scalar "~"/u, 0],
    ['a: [-0]', /ambiguous scalar "-0"/u, 0],
    ['2001-12-14: a', /ambiguous scalar "2001-12-14"/u, 0],
    ['a: 1e999', /number out of range "1e999"/u, 0],
    ['a: -1e999', /number out of range "-1e999"/u, 0],
    ['a: 12345678901234567890', /number out of range "12345678901234567890"/u, 0],
    ['a: -9007199254740992', /number out of range/u, 0],
    // The merge key means a merge to js-yaml and a key to YAML 1.2: neither is read.
    ['<<: {a: 1}', /merge keys are not supported/u, 0],
    ['a: {<<: b}', /merge keys are not supported/u, 0],
    ["'<<': 1", /merge keys are not supported/u, 0],
    // Control characters, tabs, byte order marks, lone surrogates, the two
    // non-characters js-yaml refuses and YAML 1.1's other line breaks,
    // wherever they are.
    ['a:\n\tb: 1', /^U\+0009 is not allowed at line 2$/u, 1],
    ['a: b\tc', /U\+0009/u, 0],
    ['a: "b\tc"', /U\+0009/u, 0],
    ['a: |\n  x\ty', /U\+0009/u, 1],
    ['a: b\u0000c', /U\+0000/u, 0],
    ['a: b\rc', /U\+000D/u, 0],
    ['a: b\u0085c', /U\+0085/u, 0],
    ['\uFEFFa: 1', /U\+FEFF/u, 0],
    ['a: b\uD800c', /U\+D800/u, 0],
    ['a: "b\uDE00"', /U\+DE00/u, 0],
    ['a: \uFFFE', /U\+FFFE/u, 0],
    ['a:\n  - |\n    \uFFFF', /U\+FFFF/u, 2],
    ['a: b\u2028c', /U\+2028/u, 0],
    ["a: 'b\u2029'", /U\+2029/u, 0],
    // Quoting.
    ["a: 'unterminated", /expected a scalar, found "'unterminated"/u, 0],
    ['a: "unterminated', /expected a scalar, found "\\"unterminated"/u, 0],
    ["a: 'x'y", /unexpected "y" after the value/u, 0],
    ['a: "x" y', /unexpected " y" after the value/u, 0],
    ['a: "bad \\q"', /unknown escape \\q/u, 0],
    ['a: "\\U00110000"', /\\U00110000 is not a Unicode scalar value/u, 0],
    ['a: "\\uD83D\\uDE00"', /\\uD83D is not a Unicode scalar value/u, 0],
    ['a: "\\x4"', /unknown escape \\x/u, 0],
    ['a: "x\\"', /expected a scalar/u, 0],
  ]

  for (const [text, message, line] of REFUSED) {
    it(JSON.stringify(text), () => refuses(text, message, line))
  }

  it('with no line when no line is to blame', () => {
    assert.throws(() => parseYaml(''), (error) => error instanceof YamlError && error.line === undefined && error.message === 'empty document')
  })

  it('nesting past the bound, by indentation and in one line of compact entries', () => {
    let deep = ''
    for (let i = 0; i < 70; i++) deep += `${' '.repeat(2 * i)}k${i}:\n`
    refuses(`${deep}${' '.repeat(140)}v: 1\n`, /nested too deep/u)
    refuses(`${'- '.repeat(70)}x\n`, /nested too deep at line 1/u, 0)
    let fine = ''
    for (let i = 0; i < 60; i++) fine += `${' '.repeat(2 * i)}k${i}:\n`
    assert.equal(typeof parseYaml(`${fine}${' '.repeat(120)}v: 1\n`), 'object')
  })

  // Some 2^23 characters into a scalar V8's regex engine runs out of stack,
  // and what it throws then is a RangeError.
  it('a line past 2^20 characters, well short of where the regex engine gives out', () => {
    assert.equal(parseYaml(`a: ${'x'.repeat(2 ** 20 - 3)}`).a.length, 2 ** 20 - 3)
    refuses(`a: 1\nb: ${'x'.repeat(2 ** 20)}`, /^line longer than 1048576 characters at line 2$/u, 1)
    refuses(`a: '${'x'.repeat(2 ** 23)}'`, /^line longer than 1048576 characters at line 1$/u, 0)
  })

  it('quoting at most 64 characters of the input into its message', () => {
    refuses(`a: 0x${'1'.repeat(100)}`, /^ambiguous scalar "0x1{62}"\.\.\., quote it at line 1$/u, 0)
    refuses(`a: 1\n'${'k'.repeat(100)}': 1\n'${'k'.repeat(100)}': 2`, /^duplicate key "k{64}"\.\.\. at line 3$/u, 2)
    refuses(`a: |${'x'.repeat(100)}\n  y`, /^unsupported block scalar "\|x{63}"\.\.\. at line 1$/u, 0)
    refuses(`a: 'x' ${'y'.repeat(100)}`, /^unexpected " y{63}"\.\.\. after the value at line 1$/u, 0)
  })

  it('anything but a string', () => {
    assert.throws(() => parseYaml(Buffer.from('a: 1')), TypeError)
    assert.throws(() => parseYaml(), TypeError)
  })

  it('is a YamlError with a line, exported from the package', () => {
    try {
      parseYaml('a: 1\nb: *x\n')
      assert.fail('should have thrown')
    } catch (error) {
      assert.ok(error instanceof YamlError)
      assert.equal(error.name, 'YamlError')
      assert.equal(error.line, 1)
      assert.equal(error.message, 'expected a scalar, found "*x" at line 2')
    }
  })
})

// Runs in a process of its own, where the heap can be held small.
async function parseManyLines(index) {
  const yaml = await import(index)
  const n = 2 ** 21
  const doc = yaml.parseYaml(`a: |+\n${'\n'.repeat(n)}b:\n${'  # c\n'.repeat(n / 2)}${'\n'.repeat(n)}  - |-\n${'    \n'.repeat(n / 4)}c: 1\n`)
  if (doc.a !== '\n'.repeat(n) || doc.b[0] !== '' || doc.c !== 1) process.exitCode = 1
}

describe('what it costs', () => {
  // Lines are read as the parser gets to them, and a run of blank ones inside
  // a block scalar is counted rather than kept, so millions of lines that
  // come to nothing cost next to nothing. An object for every line took
  // hundreds of megabytes of this, where js-yaml takes none.
  it('millions of blank and comment lines, in a heap of 64 MiB', () => {
    const index = JSON.stringify(new URL('../index.js', import.meta.url).href)
    const { status, stderr } = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `(${parseManyLines})(${index})`], { encoding: 'utf8' })
    assert.equal(status, 0, stderr)
  })
})
