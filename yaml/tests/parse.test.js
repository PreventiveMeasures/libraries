import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { YamlError, parseYaml } from '../index.js'

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
    assert.deepEqual(parse('a: 0\nb: -1\nc: 1.5\nd: 1e3\ne: 1E-2\nf: -0.5\ng: 5.4\nh: 12345678901234567890\n'), { a: 0, b: -1, c: 1.5, d: 1000, e: 0.01, f: -0.5, g: 5.4, h: 12345678901234567000 })
    assert.deepEqual(parse("a: 'true'\nb: \"1\"\nc: 18.2.0\nd: 1.0.1\ne: 1e5x\nf: Infinity\ng: NaN\nh: yes\ni: no\nj: on\nk: off\n"), { a: 'true', b: '1', c: '18.2.0', d: '1.0.1', e: '1e5x', f: 'Infinity', g: 'NaN', h: 'yes', i: 'no', j: 'on', k: 'off' })
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
  })

  it("js-yaml's explicit key, for a key longer than 1024 characters", () => {
    const key = `@storybook/builder@7.6.17${'(peer@1.0.0)'.repeat(90)}`
    assert.ok(key.length > 1024)
    const doc = `packages:\n  ? '${key}'\n  : resolution: {integrity: x}\n    engines: {node: '>=1'}\n  short@1.0.0:\n    resolution: {integrity: y}\nsnapshots:\n  ? '${key}'\n  : {}\n  ? s\n  : scalar\n  ? t\n  : - a\n    - b\n  ? u\n  : |-\n    text\n`
    assert.deepEqual(parse(doc), {
      packages: { [key]: { resolution: { integrity: 'x' }, engines: { node: '>=1' } }, 'short@1.0.0': { resolution: { integrity: 'y' } } },
      snapshots: { [key]: {}, s: 'scalar', t: ['a', 'b'], u: 'text' },
    })
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
    ['just text', /lone scalar/u],
    ['42', /lone scalar/u],
    ['a\nb', /lone scalar/u],
    ['  a: 1', /column 0/u, 0],
    // Directives and document markers.
    ['---\na: 1', /document markers and directives/u, 0],
    ['%YAML 1.2\n---\na: 1', /document markers and directives/u, 0],
    ['a: 1\n...', /expected a mapping key, found "\.\.\."/u, 1],
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
    // Plain scalars the core schema would type by a rule this parser does not have.
    ...['~', 'Null', 'NULL', 'True', 'TRUE', 'False', '0x1F', '0o17', '0b101', '1_000', '.5', '1.', '+1', '01', '00', '.inf', '-.Inf', '+.INF', '.nan', '.NaN', '1_0.5', '-0x1'].map((v) => [`a: ${v}`, new RegExp(`^ambiguous scalar ${v.replace(/[.+]/gu, '\\$&')}, quote it at line 1$`, 'u'), 0]),
    ['- 0x1F', /ambiguous scalar 0x1F/u, 0],
    ['a: [~]', /ambiguous scalar ~/u, 0],
    ['a: 1e999', /number out of range 1e999/u, 0],
    ['a: -1e999', /number out of range -1e999/u, 0],
    // Control characters, tabs and byte order marks, wherever they are.
    ['a:\n\tb: 1', /control character/u, 1],
    ['a: b\tc', /control character/u, 0],
    ['a: "b\tc"', /control character/u, 0],
    ['a: |\n  x\ty', /control character/u, 1],
    ['a: b\u0000c', /control character/u, 0],
    ['a: b\rc', /control character/u, 0],
    ['a: b\u0085c', /control character/u, 0],
    ['\uFEFFa: 1', /byte order mark/u, 0],
    // Quoting.
    ["a: 'unterminated", /expected a scalar, found "'unterminated"/u, 0],
    ['a: "unterminated', /expected a scalar, found "\\"unterminated"/u, 0],
    ["a: 'x'y", /unexpected "y" after the value/u, 0],
    ['a: "x" y', /unexpected " y" after the value/u, 0],
    ['a: "bad \\q"', /unknown escape \\q/u, 0],
    ['a: "\\U00110000"', /\\U00110000 is beyond Unicode/u, 0],
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
