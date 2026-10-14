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
import { blocksHold } from '../src/blocks.js'
import { format } from '../pretty.js'
import { renamedDiff, renamedDiffs } from '../names.js'
import { bindsAlike } from '../src/names/binds.js'
import { renameMap } from '../src/names/rename.js'
import { shortestChangeSet } from '../src/text.js'
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

  it('renames a script\'s top level where its file\'s other version is a module, as a chunk is that exports in one alone', () => {
    // playwright-core's dashboard chunk, 1.62.1 to 1.63.0: a declaration put in front, every top-level
    // name shifted along, and an export added, which makes the new version a module by its syntax and
    // left the old a script, whose top level is globals, so that no name there was renamed.
    const before = lines(['var a = `system`,', '  b = window.matchMedia(`x`);', 'function c() {', '  return b.matches ? a : `light`;', '}', 'c();'])
    const after = lines(['var a = RegExp(`y`),', '  b = `system`,', '  c = window.matchMedia(`x`);', 'function d() {', '  return c.matches ? b : `light`;', '}', 'd();', 'export { a as n };'])
    const renamed = lines(['var b = `system`,', '  c = window.matchMedia(`x`);', 'function d() {', '  return c.matches ? b : `light`;', '}', 'd();'])
    assert.equal(renameMap(before, after).text, renamed)
    // The other way, the module given the script's names, its own `a` none of them: apart, as `a_old`.
    assert.equal(renameMap(after, before).text, lines(['var a_old = RegExp(`y`),', '  a = `system`,', '  b = window.matchMedia(`x`);', 'function c() {', '  return b.matches ? a : `light`;', '}', 'c();', 'export { a_old as n };']))
    // Neither a module: a script's top level is globals another script may read, and keeps its names.
    assert.equal(renameMap(before, after.replace('export { a as n };\n', '')).text, before)
  })

  it('renames a script\'s top level that a minifier renamed throughout: many names there, every one short', () => {
    // playwright-core's htmlReport, 1.62.1 to 1.63.0: a module by how its page loads it, with no `import`
    // or `export` to say so, its 465 top-level names shifted along by those put in front.
    const names = 'abcdefghijklmnopq'
    const script = (count, shift, extra = []) => lines([...(shift ? ['var a = RegExp(`y`);'] : []), ...Array.from({ length: count }, (_, i) => `var ${names[i + shift]} = fn(${i}, ${i ? names[i + shift - 1] : 0});`), `use(${names[count - 1 + shift]});`, ...extra])
    assert.equal(renameMap(script(16, 0), script(16, 1)).text, script(16, 1).replace('var a = RegExp(`y`);\n', ''))
    // Fewer, or a long one among them: globals another script may read, which keep their names.
    assert.equal(renameMap(script(14, 0), script(14, 1)).text, script(14, 0))
    const long = ['var config = 1;']
    assert.equal(renameMap(script(16, 0, long), script(16, 1, long)).text, script(16, 0, long))
  })

  it('pairs the names of code moved out of order with the rest, as a run of lines alike', () => {
    // `b` moved after `c`: the diff keeps `c` in place, so `b`'s lines are taken out and put in again.
    const before = lines(['export function main(q) {', '  function b(t, n) {', '    let r = t + n;', '    return r * q;', '  }', '  function c(e) {', '    let y = e.map((x) => x + q);', '    return y.length;', '  }', '  return [b, c];', '}'])
    const after = lines(['export function main(q) {', '  function d(e) {', '    let o = e.map((x) => x + q);', '    return o.length;', '  }', '  function f(i, s) {', '    let a = i + s;', '    return a * q;', '  }', '  return [f, d];', '}'])
    const renamed = lines(['export function main(q) {', '  function f(i, s) {', '    let a = i + s;', '    return a * q;', '  }', '  function d(e) {', '    let o = e.map((x) => x + q);', '    return o.length;', '  }', '  return [f, d];', '}'])
    assert.equal(renameMap(before, after).text, renamed)
  })

  it('pairs a function\'s variables as its own lines say, where its loop moved into a helper reads one as the helper\'s', () => {
    // playwright-core's htmlReport, 1.62.1 to 1.63.0: the loop's one line kept alike paired `i` with the
    // helper's `t`, and `t` then read as two, so that neither, nor the callback's `t`, kept a name.
    const head = ['  let o = g(t);', '  if (i) {', '    let e = !!i && rs(t, i),', '      n = !!i && is(t, i);', '    if (!e && !n) return null;']
    const loop = (e, n, r) => [`      let ${e} = t.title.split(i),`, `        ${n} = [],`, `        ${r} = 0;`, `      for (let a = 0; a < ${e}.length; a++)`,
      `        (a && (${n}.push(t.title.substring(${r}, ${r} + i.length)), (${r} += i.length)),`, `          ${n}.push(${e}[a]),`, `          (${r} += ${e}[a].length));`, `      o = ${n};`]
    const before = (e, n, r) => lines(['export var f = ({ step: t, filterText: i }) => {', ...head, '    if (e) {', ...loop(e, n, r), '    }', '  }',
      '  return t.steps.map((t, a) => f({ step: t, filterText: i }, a));', '};'])
    const after = lines(['function h(e, t) {', '  let n = e.split(t),', '    r = [],', '    i = 0;', '  for (let a = 0; a < n.length; a++)',
      '    (a && (r.push(e.substring(i, i + t.length)), (i += t.length)),', '      r.push(e.substring(i, i + n[a].length)),', '      (i += n[a].length));', '  return r;', '}',
      'export var f = ({ step: t, filterText: i, waterfall: w }) => {', ...head, '    e && (o = h(t.title, i));', '  }',
      '  return t.steps.map((t, a) => f({ step: t, filterText: i, waterfall: w }, a));', '};'])
    // The loop's counter, the helper's `i`, apart: the function's `i` is read beside it.
    assert.equal(renameMap(before('e', 'n', 'r'), after).text, before('n', 'r', 'r_old'))
    // A moved line reading `i` often counts it once, as its lines in place each do.
    const calls = ['  b(t);', '  if (i) {', '    a1(i);', '    a2(i);', '    a3(i);', '    a4(i);', '    a5(i);', '  }']
    const dense = (n) => lines(['export var f = (t, i) => {', '  let o = g(t);', ...calls, '  if (t) {', `    let ${n} = t.split(i);`, '    q(i, i, i, i, i, i, i, i);', `    r(${n});`, `    o = ${n};`, '  }', '  return o;', '};'])
    const helped = lines(['function h(e, s) {', '  let n = e.split(s);', '  q(s, s, s, s, s, s, s, s);', '  r(n);', '  return n;', '}',
      'export var f = (t, i, w) => {', '  let o = g(t);', ...calls, '  t && (o = h(t, i));', '  return o;', '};'])
    assert.equal(renameMap(dense('m'), helped).text, dense('n'))
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

  it('tells `.name` read only where a name renamed is a function\'s or class\'s, the one name `.name` reads', () => {
    const reads = (declare, other = declare.replaceAll(/\ba\b/gu, 'b')) => renameMap(`${declare}\nmodule.exports = (x) => [x.name, a];\n`, `${other}\nmodule.exports = (x) => [x.name, b];\n`, cjs).reads
    assert.deepEqual(reads('var a = 1;'), [], 'a value\'s')
    assert.deepEqual(reads('var a = {};'), [])
    for (const declare of ['function a() {}', 'class a {}', 'var a = () => {};', 'var a = (function () {});', 'let a; a = function () {};', 'var a; a ||= class {};',
      'var [a = () => {}] = [];', 'var { k: a = class {} } = {};']) assert.deepEqual(reads(declare), ['name'], declare)
    assert.deepEqual(reads('var a = function c() {};', 'var b = function c() {};'), [], 'a function named its own name, kept')
    assert.deepEqual(reads('var a = 1, f = function e() {};', 'var b = 1, f = function g() {};'), ['name'], 'a function expression\'s own name renamed')
    assert.deepEqual(renameMap('var a = 1;\nmodule.exports = (x) => [x.toString(), a];\n', 'var b = 1;\nmodule.exports = (x) => [x.toString(), b];\n', cjs).reads, ['toString'],
      'a function\'s source read, which any name in it is part of')
    assert.deepEqual(renameMap('function a() {}\nmodule.exports = (x) => [x.toString(), x.name, a];\n', 'function a() {}\nmodule.exports = (x) => [x.toString(), x.name, a, 1];\n', cjs).reads, [],
      'nothing renamed, nothing a read may act otherwise for')
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

describe('renamedDiff', () => {
  const formatted = async (text) => (await format(text, 'mjs')).code
  const minify = (text) => minifySync('file.mjs', text, { compress: false, mangle: { toplevel: true }, codegen: { removeWhitespace: true } }).code

  it('diffs two minified files with their renamed names set aside, and checks the diff', async () => {
    const source = readFileSync(new URL('../src/layout.js', import.meta.url), 'utf8')
    const helper = 'function addedHelper(value, other) {\n  const sum = value + other\n  return sum * 2\n}\n'
    const at = source.search(/^(?:export )?function /mu)
    const after = await formatted(minify(source.slice(0, at) + helper + source.slice(at))), before = await formatted(minify(source))
    const diff = await renamedDiff(before, after, { extension: 'mjs' })
    assert.equal(diff.reason, null)
    assert.deepEqual(diff.warnings, [])
    assert.ok(blocksHold(diff.before, after, diff.blocks), 'the blocks take the old side, renamed, to the new')
    const shownLines = diff.blocks.reduce((n, block) => n + block.a1 - block.a0 + block.b1 - block.b0, 0)
    assert.ok(shownLines >= 4 && shownLines <= 12, `the helper shown, ${shownLines} lines`)
    assert.ok(diff.marks.length > 0, 'the plain diff\'s renamed lines marked')
    const plain = changeSet(before, after, { horizon: 0 })
    for (const mark of diff.marks) assert.ok(plain.some((block) => ['a0', 'a1', 'b0', 'b1'].every((end) => block[end] === mark[end])), 'each mark a block of the plain diff')
  })

  it('keeps the old side as it is where names can not be given, and says why', async () => {
    const diff = await renamedDiff('var a = 1;\nwith (o) f(a);\n', 'var b = 1;\nwith (o) f(b);\n')
    assert.deepEqual([diff.reason, diff.before, diff.marks], ['dynamic', 'var a = 1;\nwith (o) f(a);\n', []])
    assert.deepEqual(diff.blocks, [{ a0: 0, a1: 2, b0: 0, b1: 2 }])
    assert.deepEqual((await renamedDiff('f(a ,b);\n', 'f(a, b);\n', { whitespace: 'all' })).blocks, [], 'whitespace ignored as asked')
  })

  it('gives the shortest diff where it costs little, which the search past its cutoff may not', async () => {
    // Long texts sharing little: the search gives up on the shortest.
    const next = random(7).next
    const statements = () => lines(Array.from({ length: 3000 }, () => `f(${Math.floor(next() * 100000)});`))
    const [before, after] = [statements(), statements()]
    const edits = (blocks) => blocks.reduce((n, block) => n + block.a1 - block.a0 + block.b1 - block.b0, 0)
    const { blocks } = await renamedDiff(before, after)
    assert.deepEqual(blocks, changeSet(before, after, { horizon: 0, minimal: true }).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })))
    assert.ok(edits(blocks) < edits(changeSet(before, after, { horizon: 0 })), 'shorter than past the cutoff')
    // As many lines again alike before them: the search's work, as the square of the lines changed, is no more.
    const alike = lines(Array.from({ length: 14000 }, (_, i) => `g(${i});`))
    const [longer, later] = [alike + before, alike + after]
    const shortest = shortestChangeSet(longer, later, { horizon: 0 })
    assert.equal(edits(shortest), edits(blocks))
    assert.ok(edits(shortest) < edits(changeSet(longer, later, { horizon: 0 })), 'shorter than past the cutoff')
    // Ignoring blanks shows two lines here, as minding them does: the blocks minding them.
    assert.deepEqual(shortestChangeSet(' q\nq\n', 'q\nr\n', { horizon: 0, whitespace: 'all' }), shortestChangeSet(' q\nq\n', 'q\nr\n', { horizon: 0 }))
  })

  it('diffs once for each whitespace setting, from names found once, each as renamedDiff has it', async () => {
    const after = 'function g(b) {\n  return b + 1;\n}\nconsole.log(g(2), `x y`);\n', before = 'function f(a) {\n  return a + 1;\n}\nconsole.log(f(2), `x  y`);\n'
    const options = { extension: 'mjs' }
    const [one, spaced, both] = await Promise.all([renamedDiff(before, after, options), renamedDiff(before, after, { ...options, whitespace: 'change' }),
      renamedDiffs(before, after, { ...options, whitespace: ['none', 'change'] })])
    assert.deepEqual(both.diffs.map(({ whitespace }) => whitespace), ['none', 'change'])
    for (const [diff, { blocks, marks }] of [[one, both.diffs[0]], [spaced, both.diffs[1]]]) {
      assert.deepEqual([diff.before, diff.reason, diff.reads, diff.warnings], [both.before, both.reason, both.reads, both.warnings])
      assert.deepEqual([diff.blocks, diff.marks], [blocks, marks])
    }
    assert.deepEqual(both.diffs.map(({ blocks }) => blocks), [[{ a0: 3, a1: 4, b0: 3, b1: 4 }], []], 'the template literal\'s spaces a change unless ignored')
    assert.deepEqual(both.diffs[1].marks, [{ a0: 0, a1: 2, b0: 0, b1: 2 }, { a0: 3, a1: 4, b0: 3, b1: 4 }], 'and its line then renamed alone')
    assert.deepEqual((await renamedDiffs(before, after)).diffs.map(({ whitespace }) => whitespace), ['none'], 'whitespace as it is unless asked')
    await assert.rejects(renamedDiffs(before, after, { whitespace: 'none' }), TypeError)
    await assert.rejects(renamedDiffs(before, after, { whitespace: ['none', 'some'] }), RangeError)
  })
})
