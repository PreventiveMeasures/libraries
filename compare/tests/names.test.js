// What keeps names.js's names safe, and how much they hide: oxc's minifier as
// the check apart from its own scope analysis, programs made at random given
// the names that minifier gave them, edited or not, and real files minified
// twice. The old side with the new side's names must compile, run as it did,
// and, where the new side is the old one minified, read as it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { changeSet } from '@preventive/diff'
import { minifySync } from 'oxc-minify'
import { bindsAlike, markedBlocks, renameMap } from '../names.js'
import { compiles, program, run } from './programs.js'
import { random } from './random.js'

// A text as oxc prints it, a statement to a line: the pretty-printed sides
// names.js is given.
function pretty(text, extension) {
  const { code, errors } = minifySync(`file.${extension}`, text, { compress: false, mangle: false, codegen: { removeWhitespace: false } })
  assert.deepEqual(errors, [])
  return code
}
// A text minified as a release is, its names oxc's mangler's, then printed so.
function minified(text, extension) {
  const { code, errors } = minifySync(`file.${extension}`, text, { compress: false, mangle: { toplevel: true }, codegen: { removeWhitespace: true } })
  assert.deepEqual(errors, [])
  return pretty(code, extension)
}
// The lines a diff shows, added and removed.
const shown = (before, after) => changeSet(before, after, { horizon: 0 }).reduce((n, block) => n + block.a1 - block.a0 + block.b1 - block.b0, 0)
const median = (list) => list.toSorted((x, y) => x - y)[Math.floor(list.length / 2)]
const lines = (list) => list.map((line) => `${line}\n`).join('')
const cjs = { extension: 'cjs' }

describe('bindsAlike', () => {
  it('tells a rename that binds otherwise from one that does not, by oxc\'s minifier', () => {
    const commonjs = { commonjs: true }
    assert.equal(bindsAlike('function f(a, b) { var c = a + b; return c }\nmodule.exports = f', 'function f(x, y) { var z = x + y; return z }\nmodule.exports = f', commonjs), true)
    assert.equal(bindsAlike('const a = 1;\nexport function g(b) { return b + a }', 'const c = 1;\nexport function g(d) { return d + c }', { module: true }), true, 'a module\'s top level its own')
    for (const [label, before, after, how = commonjs] of [
      ['a parameter and its body\'s var split', 'module.exports = function (a) { var a; return a }', 'module.exports = function (b) { var c; return c }'],
      ['a catch\'s parameter and its var split', 'module.exports = function () { try { throw 1 } catch (a) { var a = 2; out(a) } return a }',
        'module.exports = function () { try { throw 1 } catch (b) { var c = 2; out(b) } return c }'],
      ['a switch read as its case\'s variable', 'module.exports = function () { let a = 1; switch (a) { case 1: let a = 2; return a } }',
        'module.exports = function () { let b = 1; switch (c) { case 1: let c = 2; return c } }'],
      ['a global captured', 'module.exports = function (a) { return a + b }', 'module.exports = function (b) { return b + b }'],
      ['a shorthand property renamed', 'module.exports = function (x) { const { a } = x; return { a } }', 'module.exports = function (x) { const { b } = x; return { b } }'],
      ['a property renamed', 'module.exports = function (x) { return x.a }', 'module.exports = function (x) { return x.b }'],
      ['an export renamed', 'export const a = 1', 'export const b = 1', { module: true }],
      ['a script\'s top level renamed, a global another script reads', 'var a = 1; f(a)', 'var b = 1; f(b)', {}],
      ['a name eval reads by its spelling', 'module.exports = function (eval, a) { return eval("a") }', 'module.exports = function (eval, b) { return eval("a") }'],
      ['text that does not parse', 'module.exports = 1', 'module.exports = ('],
    ]) assert.equal(bindsAlike(before, after, how), false, label)
    // What it can't be relied on for, renameMap refuses itself: outside strict code a function declared
    // in a block sets its function's variable of that name too, which oxc reads as the block's alone.
    const sloppy = (name) => `module.exports = function (x) { var b = 1; if (x) { function ${name}() {} } return b }`
    assert.equal(renameMap(sloppy('a'), sloppy('b'), cjs).reason, 'block-function')
  })
})

describe('renameMap', () => {
  it('names a var as no declaration of a block it passes through, nor a body\'s variable as a parameter', () => {
    // A new side that does not compile, as oxc's minifier writes some: a `var` named as the `const` of a
    // block it hoists past. It gives no names, whether oxc's semantic check finds the redeclaration or,
    // beside a `catch` parameter of the name, misses it and analysis finds it, as it does in a renamed text.
    const found = (constant, variable) => `"use strict";\nfunction f() {\n  {\n    const ${constant} = 5;\n    log(${constant});\n    {\n      var ${variable} = 1;\n    }\n  }\n}\n`
    assert.equal(renameMap(found('a', 'c'), found('e', 'e'), cjs).reason, 'unparsed')
    const missed = (parameter, constant, caught) => lines(['"use strict";', `function f(${parameter}) {`, '  {', `    const ${constant} = 5;`, `    log(${constant} + ${parameter});`,
      '    try {', '      g();', `    } catch (${caught}) {`, `      var ${caught} = ${parameter};`, '    }', '  }', '}', 'module.exports = f;'])
    assert.ok(!compiles(missed('t', 'e', 'e')), 'the new side does not compile')
    assert.equal(renameMap(missed('x', 'a', 'c'), missed('t', 'e', 'e'), cjs).reason, 'unparsed')
    assert.equal(renameMap(missed('x', 'a', 'c'), missed('t', 'a', 'c'), cjs).text, missed('t', 'a', 'c'), 'one that compiles gives its names')
    // Past a default, a body's `var` named as a parameter starts as its value: `typeof c` reads
    // undefined, `typeof b` would read 1.
    const defaults = (name) => `function f(a, b = 1) {\n  log(typeof ${name});\n  var ${name} = 2;\n  return ${name} + a;\n}\nmodule.exports = f;\n`
    const renamed = renameMap(defaults('c'), defaults('b'), cjs)
    assert.deepEqual(run(`${renamed.text}module.exports(1);`), run(`${defaults('c')}module.exports(1);`), renamed.text)
  })

  it('renames a name only from and to an ASCII one, as a minifier gives: none a reader can\'t tell from another', () => {
    const text = (name) => `var ${name} = 1;\nf(${name});\nexport {}\n`
    assert.equal(renameMap(text('a'), text('b')).text, text('b'))
    for (const [from, to] of [['a', '\u0430'], ['\u0430', 'b'], ['a', 'a\u200D']]) assert.equal(renameMap(text(from), text(to)).text, text(from), `${JSON.stringify(from)} -> ${JSON.stringify(to)} kept`)
  })

  it('pairs a declaration others now follow, though the lines around it changed in number', () => {
    // `let t = ...;` -> `let t = ...,`, two lines then: the change grew from two lines to five, so no
    // line's place in it pairs; its declaration pairs as it reads alike but for its end.
    const before = (name) => lines(['"use strict";', 'function f(e) {', `  let ${name} = g(e);`, `  return h(${name});`, '}', 'module.exports = f;'])
    const after = lines(['"use strict";', 'function f(e) {', '  let t = g(e),', '    i = 2,', '    s = 3;', '  return k(t, i, s);', '}', 'module.exports = f;'])
    for (const name of ['a', 't', 'i']) assert.equal(renameMap(before(name), after, cjs).text, before('t'), `${name}: none apart as t_old or i_old`)
  })

  it('tells the properties through which either side reads names, as a rename may change what it then does', () => {
    const text = (name, read) => `function ${name}() {}\nmodule.exports = ${read};\n`
    assert.deepEqual(renameMap(text('a', 'a'), text('b', 'b'), cjs).reads, [])
    assert.deepEqual(renameMap(text('a', 'a.name'), text('b', 'b.name'), cjs).reads, ['name'])
    assert.deepEqual(renameMap(text('a', 'a["toString"]()'), text('b', 'b.stack'), cjs).reads, ['stack', 'toString'], 'either side, by a string too')
    for (const read of ['(({ name: n }) => n)(a)', '(({ name }) => name)(a)', '(({ "name": n }) => n)(a)', '(({ [`name`]: n }) => n)(a)', 'a[`name`]', '(() => { let n; ({ name: n } = a); return n })()',
      'Reflect.get(a, "name")', 'Object.getOwnPropertyDescriptor(a, `name`).value', '(() => { const k = "name"; return a[k] })()']) {
      assert.deepEqual(renameMap(text('a', read), text('b', read.replaceAll('a)', 'b)').replace('a[', 'b[').replace('= a)', '= b)')), cjs).reads, ['name'], read)
    }
    assert.deepEqual(renameMap(text('a', '{ name: a }'), text('b', '{ name: b }'), cjs).reads, [], 'a key written, not read')
  })

  it('shows the file with its names where a check that should never fail fails, and tells what failed', () => {
    // A name written with an escape is no span renaming may replace as written.
    const mapped = renameMap('var \\u0061 = 1;\nf(\\u0061);\nmodule.exports = 1;\n', 'var b = 1;\nf(b);\nmodule.exports = 1;\n', cjs)
    assert.equal(mapped.reason, 'unverified')
    assert.equal(mapped.text, undefined)
    assert.match(mapped.invariant, /a at 4 written otherwise/u)
    // So does anything else that goes wrong.
    const throwing = { get extension() { throw new TypeError('no extension') } }
    assert.deepEqual(renameMap('var a = 1;\n', 'var b = 1;\n', throwing), { reason: 'unverified', invariant: 'TypeError: no extension' })
  })

  it('gives programs made at random the names oxc\'s minifier gave them, mostly whole, and they run as they did', () => {
    let compiled = 0, total = 0, whole = 0
    for (let seed = 1; seed <= 200; seed++) {
      const source = program(seed)
      if (!compiles(source)) continue
      compiled++
      const after = minified(source, 'cjs'), before = pretty(source, 'cjs')
      // Mangling, oxc now and then writes what does not compile: none to take names from.
      if (!compiles(after)) continue
      total++
      const mapped = renameMap(before, after, cjs)
      assert.equal(mapped.invariant, undefined, `seed ${seed}: no check that should never fail does`)
      assert.equal(renameMap(before, before, cjs).text, before, `seed ${seed} renamed as itself reads as it is`)
      if (mapped.reason) {
        assert.equal(mapped.reason, 'unverified', `seed ${seed}`)
        continue
      }
      assert.ok(compiles(mapped.text), `seed ${seed} compiles`)
      assert.deepEqual(run(mapped.text), run(before), `seed ${seed} runs as it did`)
      if (mapped.text === after) whole++
    }
    assert.ok(compiled >= 195, `${compiled} of 200 programs compile`)
    assert.ok(whole >= total * 0.9, `${whole} of ${total} take the minifier's names whole`)
  })

  // Edits made to a program's lines before it is minified anew: a number changed, a
  // statement added (every name after it moving), and one removed.
  const EDITS = {
    number: (list, next) => {
      const at = list.findIndex((line, i) => i > list.length * next() && /\b\d\b/u.test(line))
      return at < 0 ? null : list.with(at, list[at].replace(/\b(\d)\b/u, (digit) => String((Number(digit) + 1) % 10)))
    },
    added: (list, next) => list.toSpliced(1 + Math.floor(next() * (list.length - 2)), 0, 'log(7);'),
    removed: (list, next) => {
      const at = list.findIndex((line, i) => i > list.length * next() && /^\s*log\(/u.test(line))
      return at < 0 ? null : list.toSpliced(at, 1)
    },
  }

  for (const [kind, edit] of Object.entries(EDITS)) {
    it(`shows a program's edit (${kind}), mostly alone, however its names moved`, () => {
      const hidden = [], raw = []
      for (let seed = 1; seed <= 120; seed++) {
        const source = program(seed)
        const edited = compiles(source) ? edit(source.split('\n'), random(seed * 7).next)?.join('\n') : null
        if (!edited || !compiles(edited)) continue
        const after = minified(edited, 'cjs'), before = pretty(source, 'cjs')
        if (!compiles(after)) continue
        const mapped = renameMap(before, after, cjs)
        assert.equal(mapped.invariant, undefined, `${kind} seed ${seed}: no check that should never fail does`)
        if (mapped.reason) continue
        assert.ok(compiles(mapped.text), `${kind} seed ${seed} compiles`)
        assert.deepEqual(run(mapped.text), run(before), `${kind} seed ${seed} runs as it did`)
        if (kind === 'number') assert.ok(shown(mapped.text, after) > 0, `${kind} seed ${seed}: the edit shown`)
        hidden.push(shown(mapped.text, after))
        raw.push(shown(before, after))
      }
      assert.ok(hidden.length >= 100, `${kind}: ${hidden.length} diffed`)
      assert.ok(median(hidden) <= 2, `${kind}: the edit shown, ${median(hidden)} lines at the median`)
      // Two in three at least, as oxc prints them: a line to each statement, where a formatter
      // that breaks long lines (triage's oxfmt) gives three in four.
      assert.ok(hidden.filter((n) => n <= 2).length >= hidden.length * 0.65, `${kind}: mostly the edit alone`)
      assert.ok(median(raw) >= 50, `${kind}: ${median(raw)} lines raw at the median`)
    })
  }

  it('shows a function added to real files minified before and after, and little else', () => {
    const helper = 'function addedHelper(value, other) {\n  const sum = value + other\n  return sum * 2\n}\n'
    for (const file of ['src/names/analyze.js', 'src/names/pairing.js', 'src/changes.js', 'src/renames.js']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      const at = source.search(/^(?:export )?(?:async )?function /mu)
      const after = minified(source.slice(0, at) + helper + source.slice(at), 'mjs'), before = minified(source, 'mjs')
      const mapped = renameMap(before, after, { extension: 'mjs' })
      assert.equal(mapped.reason, undefined, file)
      assert.ok(mapped.renamed > 0, `${file}: the names it moved renamed`)
      // A function the helper is added before may read like it, names set aside, and show too.
      const [hidden, raw] = [shown(mapped.text, after), shown(before, after)]
      assert.ok(hidden >= 4 && hidden <= 10 && hidden < raw, `${file}: its 4 lines shown, ${hidden} in all, of ${raw} raw`)
    }
  })
})

describe('markedBlocks', () => {
  it('marks the blocks whose lines differ in renamed names alone, as the given text has them', () => {
    const after = 'f(b);\nh();\ng(2);\n', before = 'f(a);\nh();\ng(1);\n'
    assert.deepEqual(markedBlocks(before, 'f(b);\nh();\ng(1);\n', after, { horizon: 0 }), [{ a0: 0, a1: 1, b0: 0, b1: 1 }])
    assert.deepEqual(markedBlocks('f(a);\ng(a);\n', 'f(b);\ng(b);\n', 'f(b);\ng(b);'), [], 'none where a newline was dropped after the last line')
    assert.deepEqual(markedBlocks('f(a);\ng(a);\n', 'f(b);\ng(b);\n', 'f(b);\ng(b);', { whitespace: 'all' }), [{ a0: 0, a1: 2, b0: 0, b1: 2 }], 'but under -w, which takes the newline for whitespace')
    assert.deepEqual(markedBlocks('f(a ,x);\n', 'f(b ,x);\n', 'f(b, x);\n', { whitespace: 'all' }), [{ a0: 0, a1: 1, b0: 0, b1: 1 }], 'under -w, spacing changed besides')
    assert.deepEqual(markedBlocks('f(a ,x);\nq;\n', 'f(b ,x);\nq;\n', 'f(b, x);\nr;\n', { whitespace: 'all', horizon: 0 }), [], 'one alike under -w in a block with a change')
    assert.deepEqual(markedBlocks('f(a ,x);\nq;\n', 'f(b ,x);\nq;\n', 'f(b, x);\nq;\n', { horizon: 0 }), [], 'and no whitespace ignored unasked')
    assert.equal(markedBlocks('f(a);\n', 'f(b);\ng();\n', 'f(b);\n'), null, 'a renamed text of other lines')
  })
})
