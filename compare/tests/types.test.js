import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('proves declaration files of types alone, as tsc writes them and as written by hand', () => {
    assert.deepEqual(proveTypeOnly(EMITTED), { proven: true })
    assert.deepEqual(proveTypeOnly(UMD), { proven: true })
    for (const text of ['', '// nothing\n', '\uFEFFdeclare const x: 1\n', 'export { type A }\n', 'declare const x = 1, y: 2\n',
      'export declare class A extends f() { static { g() } }\n', 'declare namespace N { const x = 1 }\n']) assert.deepEqual(proveTypeOnly(text), { proven: true }, text)
  })

  it('refuses what loads a module, a type imported by name from it too', () => {
    for (const [text, at] of [["import { type A } from 'a'", 0], ["import 'a'", 0], ["import a from 'a'", 0], ["export { type A } from 'a'", 0], ["export * from 'a'", 0],
      ["import a = require('a')", 0], ["export import a = require('a')", 0], ["declare const x: 1\nimport type { A } from 'a'\nimport { B } from 'b'", 46]]) {
      assert.deepEqual(proveTypeOnly(text), refused('imports', at), text)
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
      ['declare namespace N { f() }', 22], ['type A = "\uD800"', 10], ['\uFEFFtype A = "\uDC00"', 11]]) {
      assert.deepEqual(proveTypeOnly(text), refused('unparsed', at), text)
    }
    assert.throws(() => proveTypeOnly(null), TypeError)
  })
})

describe("proveTypeOnly holds oxc's tree and Node's stripping to each other", () => {
  const strip = (code, transformed = '') => (text, { mode }) => (mode === 'strip' ? code : transformed)
  const text = 'declare const x: 1 // c\n'

  it('proves nothing where Node strips nothing, or has no stripping', () => {
    assert.deepEqual(proveWith(text, strip(text.replace(/[^\n]/gu, ' '))), { proven: true }, 'comments blanked too')
    assert.deepEqual(proveWith(text, undefined), refused('unsupported', null))
    const missing = () => {
      throw Object.assign(new Error('no TypeScript'), { code: 'ERR_NO_TYPESCRIPT' })
    }
    assert.deepEqual(proveWith(text, missing), refused('unsupported', null))
    assert.deepEqual(portable(text), refused('unsupported', null), 'nor off Node')
  })

  it('refuses where stripping keeps what oxc finds erased, or blanks otherwise', () => {
    assert.deepEqual(proveWith(text, strip(text)), refused('disagree', 0), 'kept whole')
    assert.deepEqual(proveWith(text, strip('                   f() \n')), refused('disagree', 19), 'a comment written over')
    assert.deepEqual(proveWith(text, strip('                   // c ')), refused('disagree', 23), 'a line break blanked')
    assert.deepEqual(proveWith(text, strip('                   // c')), refused('disagree', null), 'a unit dropped')
    assert.deepEqual(proveWith('declare const x: 1\n/* a */', strip('                  \n/* a */f')), refused('disagree', null), 'a unit added')
    assert.deepEqual(proveWith(text, strip('                  x// c\n')), refused('disagree', 18))
  })

  it('refuses where stripping or its transform mode refuses the text, or leaves code', () => {
    const refusing = () => {
      throw Object.assign(new Error('enum'), { code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' })
    }
    assert.deepEqual(proveWith(text, refusing), refused('disagree', null))
    assert.deepEqual(proveWith(text, () => {
      throw new RangeError('Maximum call stack size exceeded')
    }), refused('unparsed', null), 'and refuses, not for oxc to read, what it does not read whole')
    assert.deepEqual(proveWith(text, strip('                   // c\n', '(function(N) {})(N || (N = {}));\nvar N;\n')), refused('disagree', null))
    assert.deepEqual(proveWith(text, strip('                   // c\n', 'export { };\n')), { proven: true })
  })
})

describe('what Node leaves of a declaration file, read token by token', () => {
  it('may hold blanks, comments, a hashbang first, `export {}` and `export as namespace N`', () => {
    for (const text of ['', ' \t\n\r\v\f\u00A0\uFEFF\u2028\u2029\u3000', '// a\n/* b\n */', '#!/usr/bin/env node\n// x', 'export {};', 'export {        }\n',
      'export /* a */ { // b\n}', 'export as namespace Foo;\nexport as namespace $_1']) assert.equal(leftover(text), -1, text)
  })

  it('holds nothing else', () => {
    for (const [text, at] of [['f()', 0], ['// a\u2028f()', 5], ['// a\u2029f()', 5], ['/* a', 0], ['<!-- a', 0], ['--> a', 0], [';', 0], ["export {} from 'a'", 10],
      ['export * from "a"', 0], ['exports {}', 0], ['export\u200C{}', 0], ['export as namespace \u00E9', 0], ['export as namespace a.b', 21], [' #!/a', 1],
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

  it('a rename where both are declaration files', () => {
    const text = 'export declare const a: 1\nexport declare const b: 2\nexport declare const c: 3\n'
    assert.deepEqual(compareTrees(tree({ 'a.d.ts': text }), tree({ 'b.d.ts': text })).map(({ status, typeOnly }) => [status, typeOnly]), [['renamed', true]])
    assert.deepEqual(compareTrees(tree({ 'a.d.ts': text }), tree({ 'a.js': text })).map(({ status, typeOnly }) => [status, typeOnly]), [['renamed', undefined]])
  })
})
