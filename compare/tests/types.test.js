import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { compareTrees, proveTypeOnly } from '../compare.js'
import { leftover } from '../src/erasure.js'
import { proveTypeOnly as portable } from '../src/types.js'
import { proveWith } from '../src/types.node.js'

// A declaration file is left out of a diff only where it is proven to run nothing: Node reads
// one as the `.ts` it is named, and nothing keeps code out of it.

const tree = (files) => Object.entries(files).map(([name, data]) => ({ name, data }))
const refused = (reason, at) => ({ proven: false, reason, at })

// As tsc writes one, and as @types packages are written by hand.
const EMITTED = `/// <reference types="node" />
import type { Readable } from 'node:stream';
export interface Entry {
    name: string;
    data?: string | Uint8Array; // text or bytes
}
export type Status = 'added' | 'deleted' | 'modified';
export declare function compareTrees(a: Iterable<Entry>, b: Iterable<Entry>): Status[];
export declare class CompareError extends Error {
    path: string | undefined;
    constructor(detail: string, path?: string);
}
export declare const enum Kind { File = 0 }
export declare namespace compareTrees {
    var limit: number;
}
export type { Options } from './options.js';
export type * as streams from './streams.js';
export {};
`
const UMD = `#!/usr/bin/env node
/* Type definitions for lib 1.0 -- \u00E9, \u{1F600} */
export as namespace lib;
declare global {
    interface Window { lib: typeof import('lib') }
}
declare module 'lib' {
    const value: number;
    export default value;
}
namespace Lib { export interface Options {} namespace Inner { type T = 1 } }
import type Value = require('lib');
export default interface Shape { value: Value }
`

describe('Node runs a .d.ts as the .ts it is named', () => {
  it('loads what it imports a type from by name, and runs its code', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-types-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'side.mjs'), 'globalThis.compareTypesRan = (globalThis.compareTypesRan ?? 0) + 1\n')
    writeFileSync(join(dir, 'a.d.mts'), "import { type A } from './side.mjs'\nexport declare const x: A\n")
    writeFileSync(join(dir, 'b.d.mts'), 'export declare const x: number\nglobalThis.compareTypesRan += 10\n')
    await import(pathToFileURL(join(dir, 'a.d.mts')).href)
    await import(pathToFileURL(join(dir, 'b.d.mts')).href)
    assert.equal(globalThis.compareTypesRan, 11)
    delete globalThis.compareTypesRan
  })
})

describe('proveTypeOnly', () => {
  it('proves a file that erases whole: its runtime is empty', () => {
    for (const text of ['', '// nothing\n', '\uFEFFdeclare const x: 1\n', 'export type { A }\nexport type * from "m"\n',
      'import type { A } from "m"\nexport declare const x: A\n', 'declare const x = 1, y: 2\n',
      'export declare class A extends f() { static { g() } }\n', 'declare namespace N { const x = 1 }\n']) {
      assert.deepEqual(proveTypeOnly(text), { proven: true, runtime: '' }, text)
    }
  })

  // The run statements stripping leaves -- module loads and `export {}` -- are the file's `runtime`, which a
  // change must leave untouched to be types only. Imports load their module inline `type` or not.
  it("proves a file's module loads and `export {}` as its runtime", () => {
    assert.deepEqual(proveTypeOnly('export {};\n'), { proven: true, runtime: 'export {};' })
    assert.deepEqual(proveTypeOnly('declare const x: 1\nexport {}\n'), { proven: true, runtime: 'export {}' })
    assert.deepEqual(proveTypeOnly("import { X } from 'a'\nexport declare const y: X\n"), { proven: true, runtime: "import { X } from 'a'" })
    assert.deepEqual(proveTypeOnly("export { X } from 'a'\n"), { proven: true, runtime: "export { X } from 'a'" })
    assert.deepEqual(proveTypeOnly("export * from 'a'\n"), { proven: true, runtime: "export * from 'a'" })
    assert.deepEqual(proveTypeOnly('#!/usr/bin/env node\ndeclare const x: 1\n'), { proven: true, runtime: '#!/usr/bin/env node\n' })
    assert.deepEqual(proveTypeOnly(EMITTED), { proven: true, runtime: 'export {};' })
    // A type-only specifier within a kept import blanks; the module still loads, so it is runtime.
    const r = proveTypeOnly("import { type A, B } from 'b'\nexport declare const x: A\n")
    assert.equal(r.proven, true)
    assert.match(r.runtime, /^import \{ *B \} from 'b'$/u)
  })

  // An import or re-export whose only specifier is an inline type still loads its module, so it is runtime,
  // not a side-effect load. Transform mode elides the specifier, emitting a bindingless load; the
  // transformed-output check reads that as the elision, not code, so these prove rather than disagreeing.
  it('proves an inline-type-only import or re-export, which transform elides to a bindingless load', () => {
    const imp = proveTypeOnly("import { type A } from 'a'\nexport declare const x: A\n")
    assert.equal(imp.proven, true, 'inline-type import')
    assert.match(imp.runtime, /^import \{\s*\} from 'a'$/u)
    const exp = proveTypeOnly("export { type A } from 'a'\nexport declare const y: 1\n")
    assert.equal(exp.proven, true, 'inline-type re-export')
    assert.match(exp.runtime, /^export \{\s*\} from 'a'$/u)
  })

  // `export { type A }` is `export {}` only after stripping removes its specifiers; the source is a value
  // export declaration. `export as namespace N` is left verbatim, invalid as JavaScript, so importing throws.
  it('refuses code: an inline-type export, a namespace export, and arbitrary statements', () => {
    for (const text of ['export { type A }', 'export { type A as B }', 'export { type A, type B }', 'declare const A: 1\nexport { type A }',
      'export as namespace Foo', 'export as namespace Foo;\nexport {}']) {
      assert.equal(proveTypeOnly(text).proven, false, text)
      assert.equal(proveTypeOnly(text).reason, 'code', text)
    }
    assert.deepEqual(proveTypeOnly('declare const x: 1\nexport as namespace N'), refused('code', 19))
    const umd = proveTypeOnly(UMD)
    assert.equal(umd.proven, false)
    assert.equal(umd.reason, 'code')
    assert.ok(UMD.slice(umd.at).startsWith('export as namespace'), 'at the namespace export')
  })

  it('refuses `import = require`, which Node does not strip', () => {
    for (const text of ["import a = require('a')", "export import a = require('a')"]) assert.equal(proveTypeOnly(text).proven, false, text)
  })

  // A declaration file imports to name a type; an import or re-export binding nothing loads a module for
  // its side effects alone -- code a `.d.ts` has no reason to hold, so it is raised, not stamped.
  it('refuses a side-effect import or a bindingless module load, which name no type', () => {
    for (const [text, at] of [["import 'a'", 0], ["import {} from 'a'", 0], ["export {} from 'a'", 0],
      ["import 'a'\nexport {}\n", 0], ["declare const x: 1\nimport 'a'\n", 19]]) {
      assert.deepEqual(proveTypeOnly(text), refused('code', at), text)
    }
  })

  it('refuses code, and anything else stripping leaves but comments', () => {
    for (const [text, at] of [['console.log(1)', 0], ['declare const x: 1; f()', 20], ['export class A { m(): void }', 0], ['abstract class A {}', 0],
      ['enum E { A }', 0], ['namespace N { export const x = 1 }', 0], ['namespace N { declare const x: 1 }', 0], ['namespace N { declare namespace M { const x = 1 } }', 0],
      ['@d declare class A {}', 0], ['declare const x: 1\nexport default x', 19], ['export { x }', 0], ['export = x', 0], ['"use strict"', 0], ['type A = 1;;', 11],
      ['declare const x: 1 // c\u2028f()', 24], ['let x: number', 0], ['import A = B.C', 0]]) {
      assert.deepEqual(proveTypeOnly(text), refused('code', at), text)
    }
  })

  it('refuses what Node or oxc finds an error in, what only a declaration file may write among it', () => {
    for (const [text, at] of [['export const x: number', null], ['type A = 1 /* unclosed', null], ['declare const x: 1\n<!-- a comment to a script', null],
      ['declare namespace N { f() }', 22]]) {
      assert.deepEqual(proveTypeOnly(text), refused('unparsed', at), text)
    }
  })

  it('throws where the input is not a well-formed string', () => {
    for (const bad of [null, undefined, 42, {}, Buffer.from('type A = 1'), 'type A = "\uD800"', '\uFEFFtype A = "\uDC00"', 'declare const x: 1 // \uDBFF']) {
      assert.throws(() => proveTypeOnly(bad), TypeError, String(bad))
    }
  })
})

describe("proveTypeOnly holds oxc's tree and Node's stripping to each other", () => {
  const text = 'declare const x: 1 // c\n'
  // Node's stripping, but for `text`, which it strips as given; or throws, where given a function.
  const strip = (code, transformed = '', of = text) => (t, { mode }) => {
    if (t !== of) return stripTypeScriptTypes(t, { mode })
    if (typeof code === 'function') return code()
    return mode === 'strip' ? code : transformed
  }
  const throwing = (code, Kind = Error) => () => {
    throw Object.assign(new Kind('stripping failed'), { code })
  }

  it('proves nothing where Node strips nothing, or has no stripping', () => {
    assert.deepEqual(proveWith(text, strip(text.replace(/[^\n]/gu, ' '))), { proven: true, runtime: '' }, 'comments blanked too')
    assert.deepEqual(proveWith(text, undefined), refused('unsupported', null))
    assert.deepEqual(proveWith(text, throwing('ERR_NO_TYPESCRIPT')), refused('unsupported', null))
    assert.deepEqual(portable(text), refused('unsupported', null), 'nor off Node')
    // A fresh result each call, never a shared object a caller could mutate into another's.
    assert.notStrictEqual(proveWith(text, undefined), proveWith(text, undefined))
  })

  it('takes any blank but a line break for one stripping writes, as it writes one of as many UTF-8 bytes', () => {
    const wide = 'type A = "\u00E9\u4E00\u{1F600}" /* \u4E00 */\ninterface B { /** \u4E00\u{1F600} */ b: "\u3000" }\n'
    assert.deepEqual(proveTypeOnly(wide), { proven: true, runtime: '' })
    assert.deepEqual(proveWith(text, strip('\u3000\u2002\t\v\f\u00A0\uFEFF            // c\n')), { proven: true, runtime: '' })
  })

  it('refuses where stripping keeps what oxc finds erased, or blanks otherwise', () => {
    assert.deepEqual(proveWith(text, strip(text)), refused('disagree', 0), 'kept whole')
    assert.deepEqual(proveWith(text, strip('                   f() \n')), refused('disagree', 19), 'a comment written over')
    assert.deepEqual(proveWith(text, strip('                   // c ')), refused('disagree', 23), 'a line break blanked')
    assert.deepEqual(proveWith(text, strip('                   // c')), refused('disagree', null), 'a unit dropped')
    assert.deepEqual(proveWith(text, strip('\n                  // c\n')), refused('disagree', 0), 'a line break written')
    const added = 'declare const x: 1\n/* a */'
    assert.deepEqual(proveWith(added, strip('                  \n/* a */f', '', added)), refused('disagree', null), 'a unit added')
    assert.deepEqual(proveWith(text, strip('                  x// c\n')), refused('disagree', 18))
  })

  it('refuses where stripping or its transform mode refuses the text, or leaves code', () => {
    assert.deepEqual(proveWith(text, strip(throwing('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'))), refused('disagree', null))
    assert.deepEqual(proveWith(text, strip('                   // c\n', '(function(N) {})(N || (N = {}));\nvar N;\n')), refused('disagree', null))
    assert.deepEqual(proveWith(text, strip('                   // c\n', 'export { };\n')), { proven: true, runtime: '' })
  })

  // Stopped partway, Node's stripping may throw on every text from then on: one that failed so once is
  // trusted no more, whatever it does after.
  it('asks nothing more of a stripping that threw anything but its refusal, or strips the canary wrong', () => {
    const overflowing = strip(throwing(undefined, RangeError))
    assert.deepEqual(proveWith(text, overflowing), refused('unparsed', null), 'not read whole, so not for oxc to read')
    assert.deepEqual(proveWith('type A = 1', overflowing), refused('unsupported', null), 'nor anything after')
    const stopped = strip(throwing('ERR_INTERNAL_ASSERTION'), '', 'type A = 1')
    assert.deepEqual(proveWith(text, stopped), { proven: true, runtime: '' })
    assert.deepEqual(proveWith('type A = 1', stopped), refused('unparsed', null))
    assert.deepEqual(proveWith(text, stopped), refused('unsupported', null))
    const wrong = (t, options) => (t.startsWith('let a') ? t : stripTypeScriptTypes(t, options))
    assert.deepEqual(proveWith(text, wrong), refused('unsupported', null), 'the canary kept whole')
    assert.deepEqual(proveTypeOnly(text), { proven: true, runtime: '' }, "and Node's own stripping still trusted")
  })
})

describe('what Node leaves of a declaration file, read token by token', () => {
  it('may hold blanks, comments, a hashbang first, and `export {}` with any trailing `;`', () => {
    for (const text of ['', ' \t\n\r\v\f\u00A0\uFEFF\u2028\u2029\u3000', '// a\n/* b\n */', '#!/usr/bin/env node\n// x', 'export {};', 'export {        }\n',
      'export /* a */ { // b\n}', 'export {}\nexport {}']) assert.equal(leftover(text), -1, text)
  })

  it('holds nothing else, a bare `;` and `export as namespace N` among it', () => {
    for (const [text, at] of [['f()', 0], ['// a\u2028f()', 5], ['// a\u2029f()', 5], ['/* a', 0], ['<!-- a', 0], ['--> a', 0], [';', 0], ["export {} from 'a'", 10],
      ['export * from "a"', 0], ['exports {}', 0], ['export\u200C{}', 0], ['export as namespace Foo', 0], ['export as namespace a.b', 0], [' #!/a', 1],
      ['export default {}', 0], ['"use strict"', 0], ['export {}\nx', 10]]) assert.equal(leftover(text), at, text)
  })
})

describe('compareTrees stamps a declaration file holding types alone on each side', () => {
  const stamps = (a, b, options) => compareTrees(tree(a), tree(b), options).map(({ status, old, new: fresh, typeOnly }) => [`${status} ${(fresh ?? old).path}`, typeOnly])

  it('modified, added and deleted, statuses alone too', () => {
    const a = { 'a.d.ts': 'export declare const a: 1\n', 'b.d.mts': 'export interface B {}\n', 'c.d.cts': 'declare const c: 1\n', 'd.d.css.ts': 'declare const d: 1\n' }
    const b = { 'a.d.ts': 'export declare const a: 2\n', 'b.d.mts': 'export interface B { b: 1 }\n', 'e.d.ts': '// nothing\n' }
    const expected = [['modified a.d.ts', true], ['modified b.d.mts', true], ['deleted c.d.cts', true], ['deleted d.d.css.ts', true], ['added e.d.ts', true]]
    assert.deepEqual(stamps(a, b, { renames: false }), expected)
    assert.deepEqual(stamps(a, b, { renames: false, lines: false }), expected)
  })

  it('none where either side holds anything else, or is no declaration file', () => {
    const changes = stamps(
      { 'a.d.ts': 'export declare const a: 1\n', 'b.d.ts': 'export declare const b: 1\n', 'c.ts': 'export type C = 1\n', 'd.d.ts': 'export interface D {}\n',
        'e.d.ts': 'export interface E {}\n', 'f.d.ts': new Uint8Array([0xFF]) },
      { 'a.d.ts': 'export declare const a: 1\nglobalThis.a = 1\n', 'b.d.ts': "import { type B } from './b.js'\n", 'c.ts': 'export type C = 2\n',
        'd.js': 'export interface D {}\n', 'e.d.ts': 'export interface E { e: 1 }\0\n', 'f.d.ts': 'declare const f: 1\n' }, { renames: false })
    assert.deepEqual(changes, [['modified a.d.ts', undefined], ['modified b.d.ts', undefined], ['modified c.ts', undefined], ['deleted d.d.ts', true],
      ['added d.js', undefined], ['modified e.d.ts', undefined], ['modified f.d.ts', undefined]])
    const link = compareTrees(tree({ 'a.d.ts': 'declare const a: 1\n' }), [{ name: 'a.d.ts', type: 'symlink', linkname: 'a.js' }])
    assert.equal(link[0].typeOnly, undefined, 'a link, which may lead anywhere')
  })

  // A mode changing, an executable bit set, is a change even where the content is types alone: a `.d.ts`
  // with a Node hashbang goes from denied to running once executable, which a consumer must not miss.
  it('none where the mode changed, stamped where it held and only types did', () => {
    const entry = (mode) => [{ name: 'a.d.ts', data: '#!/usr/bin/env node\nexport declare const a: 1\n', mode }]
    assert.equal(compareTrees(entry(0o644), entry(0o755))[0].typeOnly, undefined, 'the mode changed')
    const typed = (c) => [{ name: 'a.d.ts', data: `#!/usr/bin/env node\nexport declare const a: ${c}\n`, mode: 0o644 }]
    assert.equal(compareTrees(typed(1), typed(2))[0].typeOnly, true, 'the mode held, only types changed')
  })

  it('a rename where both are declaration files', () => {
    const text = 'export declare const a: 1\nexport declare const b: 2\nexport declare const c: 3\n'
    assert.deepEqual(compareTrees(tree({ 'a.d.ts': text }), tree({ 'b.d.ts': text })).map(({ status, typeOnly }) => [status, typeOnly]), [['renamed', true]])
    assert.deepEqual(compareTrees(tree({ 'a.d.ts': text }), tree({ 'a.js': text })).map(({ status, typeOnly }) => [status, typeOnly]), [['renamed', undefined]])
  })

  // A change to or from `export as namespace N` flips the file between importable and throwing on import,
  // so it is not type-only however little of the rest is code.
  it('none where a side gains a namespace export, left as invalid JavaScript', () => {
    for (const ext of ['d.ts', 'd.mts']) {
      assert.deepEqual(stamps({ [`a.${ext}`]: 'declare const a: 1\n' }, { [`a.${ext}`]: 'export as namespace A\n' }, { renames: false }), [[`modified a.${ext}`, undefined]])
    }
    assert.deepEqual(stamps({}, { 'a.d.ts': 'export as namespace A\n' }, { renames: false }), [['added a.d.ts', undefined]])
  })

  // The same runtime -- a bare `export {}`, or a module load -- on both sides cancels: the change between
  // them touches only erased types. A modification keeps its path and so its module format; a one-sided add
  // or removal changes the runtime and never stamps.
  it('cancels a runtime unchanged on both sides of a modification, whatever the extension', () => {
    for (const ext of ['d.ts', 'd.mts', 'd.cts', 'd.css.ts']) {
      for (const run of ['export {}', "import { X } from './x.js'"]) {
        assert.deepEqual(stamps({ [`a.${ext}`]: `${run}\nexport declare const x: 1\n` }, { [`a.${ext}`]: `${run}\nexport declare const x: 2\n` }, { renames: false }), [[`modified a.${ext}`, true]], `${ext} ${run}`)
        // Added or removed on one side alone: the runtimes differ.
        assert.deepEqual(stamps({ [`a.${ext}`]: 'declare const x: 1\n' }, { [`a.${ext}`]: `${run}\ndeclare const x: 1\n` }, { renames: false }), [[`modified a.${ext}`, undefined]], `${ext} ${run}`)
      }
    }
    // An import changing -- a different module loaded -- is a runtime change, not types only.
    assert.deepEqual(stamps({ 'a.d.ts': "import { X } from './x.js'\nexport declare const y: X\n" }, { 'a.d.ts': "import { X } from './y.js'\nexport declare const y: X\n" }, { renames: false }), [['modified a.d.ts', undefined]])
    // An added or deleted file with a runtime: the side not there is empty, so not stamped; one that erases whole is.
    assert.deepEqual(stamps({}, { 'a.d.mts': 'export {}\n' }, { renames: false }), [['added a.d.mts', undefined]])
    assert.deepEqual(stamps({ 'a.d.mts': 'export {}\n' }, {}, { renames: false }), [['deleted a.d.mts', undefined]])
    assert.deepEqual(stamps({}, { 'a.d.ts': 'export declare const x: 1\n' }, { renames: false }), [['added a.d.ts', true]])
  })

  // A runtime cancels across a rename only where both extensions fix the same module format: a module load
  // or `export {}` runs as a module on one side and throws as CommonJS on the other, and a `.d.ts`, whose
  // format its package resolves (two trees' may differ), is never taken to share one.
  it('cancels a runtime on a rename only within one fixed module format', () => {
    for (const run of ['export {}', "import { X } from './x.js'"]) {
      const text = `${run}\nexport declare const a: X\n`
      const stamp = (from, to) => compareTrees(tree({ [from]: text }), tree({ [to]: text }))[0].typeOnly
      assert.equal(stamp('a.d.mts', 'b.d.cts'), undefined, `module to commonjs: ${run}`)
      assert.equal(stamp('a.d.ts', 'b.d.mts'), undefined, `the package to a module: ${run}`)
      assert.equal(stamp('a.d.mts', 'b.d.mts'), true, `module to module: ${run}`)
      assert.equal(stamp('a.d.cts', 'b.d.cts'), true, `commonjs to commonjs: ${run}`)
      assert.equal(stamp('a.d.ts', 'b.d.ts'), undefined, `the package both ways: ${run}`)
      assert.equal(stamp('esm/a.d.ts', 'cjs/a.d.ts'), undefined, `across packages: ${run}`)
      // Same format, another directory: a relative load in the runtime would resolve elsewhere, so a
      // rename that moves the file is not types only, whatever its runtime holds.
      assert.equal(stamp('one/a.d.mts', 'two/a.d.mts'), undefined, `another directory: ${run}`)
      assert.equal(stamp('dir/a.d.mts', 'dir/b.d.mts'), true, `same directory, new name: ${run}`)
    }
    // Erasing whole, with no runtime, a rename across formats is still type-only.
    const erased = 'export declare const a: 1\nexport declare const b: 2\n'
    assert.equal(compareTrees(tree({ 'a.d.mts': erased }), tree({ 'b.d.cts': erased }))[0].typeOnly, true)
  })

  // Real lit-html directive .d.ts files: value imports of their base classes, unchanged across the version
  // bump, with only an interface modifier and a comment touched -- a types-only modification.
  it('stamps a directive declaration whose value imports are unchanged', () => {
    const litHtml = (readonly, falsy) => `import { AttributePart, noChange } from '../lit-html.js';\n` +
      `import { Directive, DirectiveParameters, PartInfo } from '../directive.js';\n` +
      `export interface ClassInfo {\n    ${readonly}[name: string]: string | boolean | number;\n}\n` +
      `declare class ClassMapDirective extends Directive {\n    render(classInfo: ClassInfo): string;\n}\n` +
      `// a directive; a ${falsy} value removes the class\nexport declare const classMap: (classInfo: ClassInfo) => unknown;\nexport type { ClassMapDirective };\n`
    assert.deepEqual(stamps({ 'class-map.d.ts': litHtml('readonly ', 'falsey') }, { 'class-map.d.ts': litHtml('', 'falsy') }, { renames: false }), [['modified class-map.d.ts', true]])
  })
})
