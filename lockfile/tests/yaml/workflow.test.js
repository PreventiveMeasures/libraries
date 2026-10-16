import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { YamlError, parseYaml, parseYamlStream } from '../../yaml.js'

// As parse.test.js compares: structuredClone gives mappings Object.prototype
// back and changes nothing else.
const parse = (text) => structuredClone(parseYaml(text, { workflow: true }))
const refuses = (text, message, line) => assert.throws(() => parseYaml(text, { workflow: true }), { name: 'YamlError', message, ...(line === undefined ? {} : { line }) })

const FIXTURES = new URL('fixtures/', import.meta.url)
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8')

// Each beside a .json of what js-yaml 4.3.2 makes of it, with its default
// schema: written by hand as workflows and actions are, with every shape
// below in them.
describe('workflow: reads what js-yaml reads', () => {
  for (const name of ['workflow', 'action']) {
    it(name, () => assert.deepEqual(parse(fixture(`${name}.yml`)), JSON.parse(fixture(`${name}.json`))))
  }
})

describe('workflow: what GitHub reads past what pnpm writes', () => {
  it('a value left empty, null', () => {
    assert.deepEqual(parse('on:\n  push:\n  workflow_dispatch:\njobs: {}\n'), { on: { push: null, workflow_dispatch: null }, jobs: {} })
    assert.deepEqual(parse('a: # c\nb:\n'), { a: null, b: null })
    assert.deepEqual(parse('-\n- # c\n- x\n-\n'), [null, null, 'x', null])
    assert.deepEqual(parse('? a\n:\nb: 1\n'), { a: null, b: 1 })
  })

  it('a sequence under a key at the key\'s own column, up to the next key', () => {
    assert.deepEqual(parse('steps:\n- run: a\n- run: b\nnext: 1\n'), { steps: [{ run: 'a' }, { run: 'b' }], next: 1 })
    assert.deepEqual(parse('a:\n  b:\n  - x\n  c: 1\n'), { a: { b: ['x'], c: 1 } })
    assert.deepEqual(parse('- a:\n  - x\n  b: 1\n'), [{ a: ['x'], b: 1 }])
  })

  it('folded block scalars, with their chomping', () => {
    assert.deepEqual(parse('a: >\n  one\n  two\n\n  three\nb: 1\n'), { a: 'one two\nthree\n', b: 1 })
    assert.deepEqual(parse('a: >-\n  x\n  y\n\n\n'), { a: 'x y' })
    assert.deepEqual(parse('a: >+\n  x\n\n\nb: 1\n'), { a: 'x\n\n\n', b: 1 })
    assert.deepEqual(parse('a: >\n\n  x\n\n\n  y\n'), { a: '\nx\n\ny\n' })
    // A line indented past the rest keeps the breaks around it.
    assert.deepEqual(parse('a: >\n  x\n    more\n  y\n  z\n'), { a: 'x\n  more\ny z\n' })
    assert.deepEqual(parse('a: >\n  x\n\n    more\n\n  y\n'), { a: 'x\n\n  more\n\ny\n' })
    assert.deepEqual(parse('a: >\nb: 1\n'), { a: '', b: 1 })
  })

  it('a comment after a block scalar\'s header, and its indicators in either order', () => {
    assert.deepEqual(parse('a: | # c\n  x\nb: >- #c\n  y\n  z\n'), { a: 'x\n', b: 'y z' })
    assert.deepEqual(parse('a: |-2\n    x\n   y\nb: |2-\n    x\n'), { a: '  x\n y', b: '  x' })
    assert.deepEqual(parse('a: >2\n   lead\n  x\n'), { a: ' lead\nx\n' })
    assert.deepEqual(parse('a: |  \n  x\nb: >-   \n  y\n'), { a: 'x\n', b: 'y' })
  })

  it('a tab in a block scalar\'s text, as a Makefile or a heredoc has', () => {
    assert.deepEqual(parse('a: |\n  all:\n  \techo x\n  \t\n'), { a: 'all:\n\techo x\n\t\n' })
    assert.deepEqual(parse('a: >\n  x\n  \ty\n'), { a: 'x\n\ty\n' })
    assert.deepEqual(parse('# a\tcomment\na: 1\n\t\nb: 2\n'), { a: 1, b: 2 })
  })

  it('plain scalars over more than one line, folded', () => {
    assert.deepEqual(parse("if: a == 'b' &&\n  c\nnext: 1\n"), { if: "a == 'b' && c", next: 1 })
    assert.deepEqual(parse('a: one\n  two\n\n  three\n\n\n  four\n'), { a: 'one two\nthree\n\nfour' })
    assert.deepEqual(parse('- one\n  two\n- three\n'), ['one two', 'three'])
    assert.deepEqual(parse('a:\n  one\n  two\n'), { a: 'one two' })
    // Its lines below its first held deeper than its key, not than its first.
    assert.deepEqual(parse('a:\n    one\n  two\n three\nb: 1\n'), { a: 'one two three', b: 1 })
    // Typed as one, as js-yaml types it.
    assert.deepEqual(parse('a: 1\n  2\nb: true\n  false\n'), { a: '1 2', b: 'true false' })
    // A comment ends it.
    assert.deepEqual(parse('a: x # c\nb: y\n  z # c\nc: 1\n'), { a: 'x', b: 'y z', c: 1 })
    // The spaces around each break taken off, the first line's too.
    assert.deepEqual(parse('if: cond   \n  && other  \nb: x  \n\n  y\n'), { if: 'cond && other', b: 'x\ny' })
    assert.deepEqual(parse('- a  \n  b\n- c\n'), ['a b', 'c'])
    assert.deepEqual(parse('k:\n  x   \n  y\n'), { k: 'x y' })
  })

  it('quoted scalars over more than one line, folded', () => {
    assert.deepEqual(parse('a: "one\n  two\n\n  three"\n'), { a: 'one two\nthree' })
    assert.deepEqual(parse("a: 'it''s\n  here'\nb: 1\n"), { a: "it's here", b: 1 })
    // An escaped break joins the lines as they are; an escaped space is kept.
    assert.deepEqual(parse('a: "x \\\n    y"\nb: "x\\ \n  y"\n'), { a: 'x y', b: 'x  y' })
    assert.deepEqual(parse('a: "\\t\\u00e9\n  \\x41" # c\n'), { a: '\té A' })
    assert.deepEqual(parse('- "a\n  b"\n- c\n'), ['a b', 'c'])
  })

  it('flow collections over more than one line, nested, a comma after the last', () => {
    assert.deepEqual(parse('a: [x,\n  y,   # c\n  z]\nb: 1\n'), { a: ['x', 'y', 'z'], b: 1 })
    assert.deepEqual(parse('a: {b: [1, {c: d}], e: {}}\n'), { a: { b: [1, { c: 'd' }], e: {} } })
    assert.deepEqual(parse('a: [x, y,]\nb: {c: 1,}\n'), { a: ['x', 'y'], b: { c: 1 } })
    assert.deepEqual(parse('a:\n  - {\n      b: 1\n    }\n'), { a: [{ b: 1 }] })
    // A plain scalar's lines folded as YAML folds them, an empty line a break;
    // a quote in it part of its text.
    assert.deepEqual(parse('a: [one\n\n  two, three\n  four]\nb: {k: x\n\n\n  y}\n'), { a: ['one\ntwo', 'three four'], b: { k: 'x\n\ny' } })
    assert.deepEqual(parse("a: [one,\n\n  two]\nb: [it's, x\n  'y]\nc: ['q'\n\n  , d]\n"), { a: ['one', 'two'], b: ["it's", "x 'y"], c: ['q', 'd'] })
  })

  it('anchors and aliases, an alias the very value its anchor names', () => {
    const doc = parseYaml('env: &env\n  A: 1\nother: *env\nl:\n  - &s step\n  - *s\n  - &m\n    k: v\n  - *m\n', { workflow: true })
    assert.equal(doc.other, doc.env)
    assert.deepEqual(structuredClone(doc), { env: { A: 1 }, other: { A: 1 }, l: ['step', 'step', { k: 'v' }, { k: 'v' }] })
    // An anchor before a key is the key's, as YAML has it, not its mapping's,
    // which keeps the column after `- ` or `: `.
    assert.deepEqual(parse('- &x a: 1\n  b: 2\n- *x\n'), [{ a: 1, b: 2 }, 'a'])
    assert.deepEqual(parse('? k\n: &x a: 1\n  b: 2\nz: *x\n'), { k: { a: 1, b: 2 }, z: 'a' })
    assert.deepEqual(parse('m:\n  &x a: 1\n  &y b: *x\nn: *y\n'), { m: { a: 1, b: 'a' }, n: 'b' })
    assert.deepEqual(parse('a: &x # c\n  - 1\nb: *x # c\n'), { a: [1], b: [1] })
    assert.deepEqual(parse('a: &x |\n  text\nb: *x\n'), { a: 'text\n', b: 'text\n' })
    // Anchors are a document's own.
    assert.throws(() => parseYamlStream('a: &x 1\n---\nb: *x\n', { workflow: true }), /unknown alias "\*x" at line 3/u)
  })

  it('scalars typed as without it', () => {
    assert.deepEqual(parse('on: push\nb: true\nc: 20\nd: 3.10\ne: null\nf: v4\n'), { on: 'push', b: true, c: 20, d: 3.1, e: null, f: 'v4' })
  })
})

describe('workflow: what it still refuses', () => {
  const REFUSED = [
    // Tags, merge keys (GitHub reads none), directives and end markers.
    ['a: !!str 1', /expected a scalar, found "!!str 1"/u, 0],
    ['a: &x {b: 1}\nc:\n  <<: *x', /merge keys are not supported at line 3/u, 2],
    ['%YAML 1.2\n---\na: 1', /document end markers and directives/u, 0],
    ['a: 1\n...', /document end markers and directives/u, 1],
    // A tab anywhere but a block scalar's text and a comment line.
    ['a:\n\tb: 1', /^U\+0009 is not allowed outside a block scalar at line 2$/u, 1],
    ['a: b\tc', /U\+0009 is not allowed outside a block scalar/u, 0],
    ['a: "b\tc"', /U\+0009 is not allowed outside a block scalar/u, 0],
    ['a: b\n  \tc', /U\+0009 is not allowed outside a block scalar at line 2/u, 1],
    ['a: [b,\n\tc]', /U\+0009 is not allowed outside a block scalar at line 2/u, 1],
    ['a: 1 # \tc', /U\+0009 is not allowed outside a block scalar/u, 0],
    // Aliases: of anchors named before, alone, not as keys, nor in a flow collection.
    ['a: *x', /^unknown alias "\*x" at line 1$/u, 0],
    ['a: &x 1\nb: *x y', /unexpected "\*x y" after an alias at line 2/u, 1],
    ['*x: 1', /an alias as a key is not supported/u, 0],
    ['a: &x 1\nb: [*x]', /expected a scalar, found "\*x\]"/u, 1],
    ['a: &x &y 1', /expected a scalar, found "&y 1"/u, 0],
    ['- &x &y 1', /expected a scalar, found "&y 1"/u, 0],
    ['- &x - a', /an anchor before a block on its own line is not supported/u, 0],
    ['a: & 1', /expected an anchor's name, found "& 1"/u, 0],
    // What doesn't close.
    ['a: "x\n  y', /^a quoted scalar that does not close at line 1$/u, 0],
    ["a: 'x\n---\nb: 1", /a quoted scalar that does not close at line 1/u, 0],
    ['a: [x,\n  y', /^a flow collection that does not close at line 1$/u, 0],
    ['a: [x, "y\n  z"]', /a quoted scalar in a flow collection does not close on its line at line 1/u, 0],
    ['a: [x] y', /unexpected " y" after the value at line 1/u, 0],
    ['a: [x,\n  y] z', /unexpected " z" after the value at line 2/u, 1],
    // A comment ends a plain scalar, as js-yaml has it.
    ['a: [one # c\n  two]', /^a plain scalar in a flow collection goes on past a comment at line 2$/u, 1],
    ['a: [one\n  # c\n  two]', /a plain scalar in a flow collection goes on past a comment at line 3/u, 2],
    ['a: "x\n  y" z', /unexpected " z" after the value at line 2/u, 1],
    // What YAML refuses in a plain scalar, on any of its lines.
    ['run: echo "a: b"', /unexpected ": b\\"" after the value/u, 0],
    ['a: b\n  c: d', /unexpected ": d" after the value/u, 0],
    ['a: b # c\n  d', /bad indentation at line 2/u, 1],
    // Block scalars still past `|` and `>`, and a comment with no space.
    ['a: |#c\n  x', /unsupported block scalar "\|#c"/u, 0],
    ['a: >x\n  y', /unsupported block scalar ">x"/u, 0],
    ['a: |2-2\n  x', /unsupported block scalar/u, 0],
    // Scalars typed as without it.
    ['a: TRUE', /ambiguous scalar "TRUE", quote it/u, 0],
    ['a: ~', /ambiguous scalar "~", quote it/u, 0],
    ['a: [1, 0x1F]', /ambiguous scalar "0x1F"/u, 0],
    // And the rest as without it.
    ['a: 1\na: 2', /duplicate key "a" at line 2/u, 1],
    ['a: {b: 1, b: 2}', /duplicate key "b"/u, 0],
    ['a: [[1], {b}]', /expected ": " after the key/u, 0],
    ['a: {[1]: 2}', /keys must be strings/u, 0],
    ['  a: 1', /column 0/u, 0],
  ]
  for (const [text, message, line] of REFUSED) {
    it(JSON.stringify(text), () => refuses(text, message, line))
  }

  // Each alias read as a copy, as a caller walking the document would, it
  // comes to ten to the eleventh nodes, though it takes a few hundred lines.
  it('aliases that would expand a document past 2^20 nodes, or 128 levels', () => {
    let laughs = 'a0: &a0 x\n'
    for (let i = 1; i < 12; i++) laughs += `a${i}: &a${i}\n${`  - *a${i - 1}\n`.repeat(10)}`
    refuses(laughs, /^aliases expand the document past 1048576 nodes$/u)
    let fine = 'a0: &a0 x\n'
    for (let i = 1; i < 5; i++) fine += `a${i}: &a${i}\n${`  - *a${i - 1}\n`.repeat(10)}`
    assert.equal(parse(fine).a4.flat(3).length, 10 ** 4)
    let deep = 'a0: &a0 x\n'
    for (let i = 1; i < 200; i++) deep += `a${i}: &a${i}\n  - *a${i - 1}\n`
    refuses(deep, /^aliases nest the document past 128 levels$/u)
  })
})

// js-yaml's schemas of old made code of a tag (`!!js/function`) and other
// objects of others (`!!js/regexp`, `!!js/undefined`, `!!set`): here a tag
// is refused, wherever a node can start, whatever it names, and what is read
// is plain data alone.
describe('no tag makes code or any object but plain data', () => {
  const TAGS = ['!!js/function', '!!js/regexp', '!!js/undefined', '!!python/object', '!!set', '!!binary', '!<tag:yaml.org,2002:js/function>', '!function', '!']
  const PLACES = [
    (tag) => `a: ${tag} 'function () { return 1 }'`,
    (tag) => `a: &x ${tag} 'x'`,
    (tag) => `a: ${tag} &x 'x'`,
    (tag) => `- ${tag} x`,
    (tag) => `- &x ${tag} x`,
    (tag) => `${tag} k: v`,
    (tag) => `a:\n  ${tag} >\n    function () {}`,
    (tag) => `a:\n  ${tag}\n  b: 1`,
    (tag) => `a: [x, ${tag} y]`,
    (tag) => `a: {k: ${tag} y}`,
    (tag) => `a: [[${tag} y]]`,
    (tag) => `? ${tag} k\n: v`,
    (tag) => `a: ${tag} |\n  x`,
  ]
  for (const tag of TAGS) {
    it(tag, () => {
      for (const place of PLACES) {
        const text = place(tag)
        for (const options of [undefined, { workflow: true }]) assert.throws(() => parseYaml(text, options), YamlError, `${JSON.stringify(text)} ${JSON.stringify(options)}`)
      }
    })
  }

  // Strings, numbers, booleans, null, arrays, and mappings with a null
  // prototype: nothing else, and no own property but the data's.
  const plain = (value, seen = new Set()) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
    if (typeof value !== 'object' || seen.has(value)) return seen.has(value)
    seen.add(value)
    const proto = Object.getPrototypeOf(value)
    if (!(Array.isArray(value) ? proto === Array.prototype : proto === null)) return false
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && (Array.isArray(value) && key === 'length' || plain(value[key], seen)))
  }

  it('what it reads is plain data, a function\'s text a string', () => {
    for (const name of ['workflow', 'action']) assert.ok(plain(parseYaml(fixture(`${name}.yml`), { workflow: true })), name)
    const doc = parseYaml("a: 'function () { return 1 }'\nb: text\n  !!js/function x\nc: &f\n  __proto__: { toString: x }\nd: *f\n", { workflow: true })
    assert.ok(plain(doc))
    assert.equal(doc.a, 'function () { return 1 }')
    // A tag in a plain scalar's later line is its text, as YAML has it.
    assert.equal(doc.b, 'text !!js/function x')
    assert.equal(Object.getPrototypeOf(doc.c), null)
    assert.equal(({}).toString, Object.prototype.toString)
  })
})

describe('without workflow, each of them refused as before', () => {
  // What pnpm reads must stay as strict as it was: none of these is read.
  const STRICT = [
    ['a:\n', /^missing value at line 1$/u],
    ['a:\n- x\n', /a sequence under a key must be indented at line 2/u],
    ['a: >\n  x\n', /unsupported block scalar ">"/u],
    ['a: | # c\n  x\n', /unsupported block scalar "\| # c"/u],
    ['a: |-2\n    x\n', /unsupported block scalar "\|-2"/u],
    ['a: b\n  c\n', /bad indentation at line 2/u],
    ['a: "b\n  c"\n', /expected a scalar, found "\\"b"/u],
    ['a: [b,\n  c]\n', /expected a scalar, found the end of the line/u],
    ['a: [[b]]\n', /expected a scalar, found "\[b\]\]"/u],
    ['a: [b,]\n', /expected a scalar, found "\]"/u],
    ['a: &x 1\nb: *x\n', /expected a scalar, found "&x 1"/u],
    ['a: |\n  \tx\n', /^U\+0009 is not allowed at line 2$/u],
    ['# a\tcomment\na: 1\n', /^U\+0009 is not allowed at line 1$/u],
  ]
  for (const [text, message] of STRICT) {
    it(JSON.stringify(text), () => {
      assert.throws(() => parseYaml(text), { name: 'YamlError', message })
      assert.throws(() => parseYaml(text, {}), { name: 'YamlError', message })
      assert.throws(() => parseYaml(text, { workflow: false }), { name: 'YamlError', message })
      assert.doesNotThrow(() => parseYaml(text, { workflow: true }))
    })
  }
})

describe('lines', () => {
  it('where each block mapping\'s and sequence\'s values are, counting from zero', () => {
    for (const workflow of [false, true]) {
      const lines = new WeakMap()
      const doc = parseYaml('jobs:\n  a:\n    steps:\n      - uses: x@y # v1\n\n      - run: |\n          echo\n? k\n: v\nf: {a: 1}\n', { workflow, lines })
      assert.deepEqual(lines.get(doc), new Map([['jobs', 0], ['k', 7], ['f', 9]]))
      assert.deepEqual(lines.get(doc.jobs.a), new Map([['steps', 2]]))
      assert.deepEqual(lines.get(doc.jobs.a.steps), [3, 5])
      assert.deepEqual(lines.get(doc.jobs.a.steps[1]), new Map([['run', 5]]))
      assert.equal(lines.get(doc.f), undefined, 'a flow collection is not a block one')
    }
  })

  it('a stream\'s documents each', () => {
    const lines = new WeakMap()
    const [a, b] = parseYamlStream('a: 1\n---\nb: 2\n', { lines })
    assert.deepEqual([lines.get(a), lines.get(b)], [new Map([['a', 0]]), new Map([['b', 2]])])
  })
})

describe('options', () => {
  it('are refused where they aren\'t what they say', () => {
    for (const options of [null, 1, 'workflow', { workflow: 1 }, { workflow: 'true' }, { lines: {} }, { lines: new Map() }, { strict: true }]) {
      assert.throws(() => parseYaml('a: 1', options), TypeError, JSON.stringify(options))
      assert.throws(() => parseYamlStream('a: 1', options), TypeError, JSON.stringify(options))
    }
    assert.deepEqual(structuredClone(parseYaml('a: 1', undefined)), { a: 1 })
  })

  it('is a YamlError with a line in workflow too', () => {
    assert.throws(() => parseYaml('a: 1\nb: *x\n', { workflow: true }), (error) => error instanceof YamlError && error.line === 1 && error.message === 'unknown alias "*x" at line 2')
  })
})

// Runs in a process of its own, where the heap can be held small.
async function parseManyLines(index) {
  const yaml = await import(index)
  const n = 2 ** 21
  const doc = yaml.parseYaml(`a: >+\n${'\n'.repeat(n)}b: x\n${'\n'.repeat(n)}  y\nc:\n${'  # c\n'.repeat(n / 2)}${'\n'.repeat(n)}- |-\n${'    \n'.repeat(n / 4)}d:\n`, { workflow: true })
  if (doc.a !== '\n'.repeat(n) || doc.b !== `x${'\n'.repeat(n)}y` || doc.c[0] !== '' || doc.d !== null) process.exitCode = 1
}

describe('workflow: what it costs', () => {
  // As without it: lines read as the parser gets to them, a run of blank ones
  // inside a block or a plain scalar counted rather than kept.
  it('millions of blank and comment lines, in a heap of 64 MiB', () => {
    const index = JSON.stringify(new URL('../../yaml.js', import.meta.url).href)
    const { status, stderr } = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `(${parseManyLines})(${index})`], { encoding: 'utf8' })
    assert.equal(status, 0, stderr)
  })
})
