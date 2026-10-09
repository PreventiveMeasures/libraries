import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceMapError, readSourceMap } from '@preventive/sourcemap'
import { segmentsOf } from '../src/map.js'
import { fileAt, lineStarts } from '../src/positions.js'
import { vlq } from './helpers.js'

// Reading a map: the mappings decoded as the format writes them, the
// sources turned into files, and an index map's sections laid over one
// another. Edges are read off all three, so each is pinned here alone.

// Decoded segments as each line's [column, source] pairs, -1 for none.
const lines = ({ starts, columns, sources }) => Array.from({ length: starts.length - 1 }, (_, l) => {
  const pairs = []
  for (let k = starts[l]; k < starts[l + 1]; k++) pairs.push([columns[k], sources[k]])
  return pairs
})
const decode = (mappings, sourceCount) => lines(segmentsOf(readSourceMap({ version: 3, sources: Array.from({ length: sourceCount }, (_, i) => `${i}.js`), mappings })))

describe('mappings decode as the format writes them', () => {
  it('reads 1-, 4- and 5-field segments, the first field restarting each line', () => {
    assert.deepEqual(decode('AAAA,IAAI;AACA', 1), [[[0, 0], [4, 0]], [[0, 0]]])
    assert.deepEqual(decode('A,EAAAC', 1), [[[0, -1], [2, 0]]])
    assert.deepEqual(decode(';;AAAA', 1), [[], [], [[0, 0]]])
    assert.deepEqual(decode('', 0), [[]])
  })

  it('reads signs and continuation digits', () => {
    for (const n of [0, 1, 15, 16, 1000, 123_456, 2 ** 31 - 1]) assert.deepEqual(decode(vlq(n), 0), [[[n, -1]]], String(n))
    // A column back by 16 from 1000, and a source back by one.
    assert.deepEqual(decode(`${vlq(1000)}CAA,${vlq(-16)}DAA`, 2), [[[984, 0], [1000, 1]]])
  })

  it('carries the source on across lines and segments, and reads past where in it', () => {
    // Second source, two lines down, three columns left, then back.
    assert.deepEqual(decode('AAAG;ACEF,ADAA', 2), [[[0, 0]], [[0, 1], [0, 0]]])
  })

  it('sorts a line its generator left out of order', () => {
    assert.deepEqual(decode('IAAA,DCAC;CAAA,DAAA', 2), [[[3, 1], [4, 0]], [[0, 1], [1, 1]]])
  })

  it('refuses what is not a mapping', () => {
    for (const [mappings, why] of [['AA', '2 fields'], ['AAA', '3 fields'], ['AAAAAA', '6 fields'], ['AA!A', 'not base64'], ['g', 'cut off'], ['ACAA', 'past sources'], ['D', 'negative column'], ['gggggggB', 'past 32 bits']]) {
      assert.throws(() => decode(mappings, 1), SourceMapError, why)
    }
    assert.throws(() => decode(null, 1), SourceMapError)
  })
})

describe('a map is read whole or not at all', () => {
  const plain = { version: 3, sources: ['a.js'], sourcesContent: ['export {}'], mappings: 'AAAA' }

  it('takes JSON text, its bytes, or the parsed object', () => {
    const text = JSON.stringify(plain)
    for (const input of [text, new TextEncoder().encode(text), plain, `)]}'\n${text}`]) {
      assert.deepEqual(readSourceMap(input).files, [{ source: 'a.js', path: 'a.js', package: null, content: 'export {}', ignored: false }])
    }
  })

  it('refuses a map it cannot read, saying why', () => {
    for (const [input, why] of [
      ['{', /not JSON/u], ['[]', /not a JSON object/u], [{ ...plain, version: 2 }, /version 2/u],
      [{ ...plain, sources: 'a.js' }, /sources is not an array/u], [{ ...plain, sources: [1] }, /sources holds 1/u],
      [{ ...plain, sourcesContent: [1] }, /sourcesContent holds/u], [{ ...plain, sourceRoot: 1 }, /sourceRoot/u],
      [{ ...plain, ignoreList: [1] }, /ignoreList/u], [{ ...plain, mappings: 'ACAA' }, /not in sources/u],
      [new Uint8Array([0xff]), /not JSON/u],
    ]) assert.throws(() => readSourceMap(input), (error) => error instanceof SourceMapError && why.test(error.message), String(why))
    assert.throws(() => readSourceMap(plain, { path: 1 }), TypeError)
  })

  it('applies sourceRoot, then the map\'s own path', () => {
    const map = { version: 3, sourceRoot: '../lib', sources: ['a.js', 'x/b.js'], mappings: '' }
    assert.deepEqual(readSourceMap(map).files.map((f) => f.path), ['../lib/a.js', '../lib/x/b.js'])
    assert.deepEqual(readSourceMap(map, { path: 'dist/esm/index.js.map' }).files.map((f) => [f.source, f.path]), [['../lib/a.js', 'dist/lib/a.js'], ['../lib/x/b.js', 'dist/lib/x/b.js']])
    assert.equal(readSourceMap({ ...map, sourceRoot: 'src/' }).files[0].path, 'src/a.js')
  })

  it('makes one file of a source listed twice, and keeps a null one apart', () => {
    const { files } = readSourceMap({ version: 3, sources: ['a.js', null, 'a.js', null], sourcesContent: [null, null, 'x', null], mappings: 'AAAA,CEAA,CCAA' })
    assert.deepEqual(files.map((f) => [f.path, f.content]), [['a.js', 'x'], [null, null], [null, null]])
  })

  it('marks what ignoreList names, or x_google_ignoreList', () => {
    const map = { version: 3, sources: ['a.js', 'node_modules/b/i.js'], mappings: '' }
    assert.deepEqual(readSourceMap({ ...map, ignoreList: [1] }).files.map((f) => f.ignored), [false, true])
    assert.deepEqual(readSourceMap({ ...map, x_google_ignoreList: [1] }).files.map((f) => f.ignored), [false, true])
  })
})

describe('an index map is its sections laid over one another', () => {
  // Section a: two lines; section b from column 5 of the second.
  const a = { version: 3, sources: ['a.js'], mappings: 'AAAA;AACA' }
  const b = { version: 3, sources: ['b.js', 'a.js'], mappings: 'AAAA,ICAA' }
  const indexed = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: a }, { offset: { line: 1, column: 5 }, map: b }] }

  it('keeps each section where it starts, with its own files', () => {
    const map = readSourceMap(indexed)
    assert.deepEqual(map.files.map((f) => f.path), ['a.js', 'b.js'])
    assert.deepEqual(map.sections.map((s) => [s.line, s.column, s.files.map((f) => f.path)]), [[0, 0, ['a.js']], [1, 5, ['b.js', 'a.js']]])
    assert.equal(readSourceMap(a).sections, null)
  })

  it('shifts only a section\'s first line by its column', () => {
    assert.deepEqual(lines(segmentsOf(readSourceMap(indexed))), [[[0, 0]], [[0, 0], [5, 1], [9, 0]]])
    const map = readSourceMap({ version: 3, sections: [{ offset: { line: 2, column: 3 }, map: { version: 3, sources: ['c.js'], mappings: 'AAAA;CAAA' } }] })
    assert.deepEqual(lines(segmentsOf(map)), [[], [], [[3, 0]], [[1, 0]]])
  })

  it('finds the file a position came from across the seam', () => {
    const map = readSourceMap(indexed)
    const code = 'aaaa\naaaa bbbb aaaa'
    const starts = lineStarts(code)
    assert.deepEqual([0, 5, 9, 10, 14, 15].map((offset) => fileAt(map, starts, offset)?.path), ['a.js', 'a.js', 'a.js', 'b.js', 'a.js', 'a.js'])
  })

  it('refuses sections out of order, nested, or without an offset', () => {
    const section = (line, column, map = a) => ({ offset: { line, column }, map })
    for (const sections of [[section(1, 0), section(0, 0)], [section(1, 4), section(1, 3)], [section(0, 0, indexed)], [{ map: a }], [section(-1, 0)], [{ offset: { line: 0, column: 0 } }]]) {
      assert.throws(() => readSourceMap({ version: 3, sections }), SourceMapError)
    }
    assert.throws(() => readSourceMap({ version: 3, sections: {} }), SourceMapError)
  })
})

describe('positions count lines as JavaScript does', () => {
  it('breaks at \\n, \\r\\n, \\r, U+2028 and U+2029', () => {
    assert.deepEqual(lineStarts('a\nb\r\nc\rd\u2028e\u2029f'), [0, 2, 5, 7, 9, 11])
  })
})
