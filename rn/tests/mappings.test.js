import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { concatMaps, concatMapsJson, pieceOf } from '../serve/mappings.js'

const esbuild = createRequire(import.meta.url)('esbuild')

// A piece of esbuild's map of `code`, as a file named `file`, its lines.
const pieceOfCode = (code, file) => {
  const { code: out, map } = esbuild.transformSync(code, { sourcefile: file, sourcemap: 'external', minifyIdentifiers: false })
  return { lines: out.split('\n').length - 1, piece: pieceOf(JSON.parse(map)) }
}

describe('concatMapsJson', () => {
  it("is JSON.stringify(concatMaps(pieces)), the same, of each piece's sources once", () => {
    const named = pieceOfCode('function greet(name) {\n  return "hi " + name\n}\ngreet("a \\"quoted\\" one")\n', 'a/greet.js')
    const other = pieceOfCode('export const x = [1, 2]\nconsole.log(x)\n', 'b/x.ts')
    const unmapped = { lines: 3, piece: null }
    const cut = { lines: 1, piece: named.piece }
    // Of names, and of a source's content.
    const withNames = { lines: 2, piece: pieceOf({ version: 3, sources: ['n.js'], sourcesContent: ['let a\nlet b\n'], names: ['a', 'b'], mappings: 'AAAAA;AACAC' }) }
    const pieces = [unmapped, named, withNames, { lines: 1, piece: null }, other, cut, withNames, named, { lines: 2, piece: pieceOf({ version: 3, sources: ['c.js'], names: [], mappings: 'AAAA' }) }]
    assert.ok(concatMaps(pieces).names.length === 4 && concatMaps(pieces).sourcesContent.includes('let a\nlet b\n'))
    assert.equal(concatMapsJson(pieces), JSON.stringify(concatMaps(pieces)))
    // Again, of its fragments made: the same.
    assert.equal(concatMapsJson(pieces), JSON.stringify(concatMaps(pieces)))
    assert.equal(concatMapsJson([unmapped]), JSON.stringify(concatMaps([unmapped])))
  })
})
