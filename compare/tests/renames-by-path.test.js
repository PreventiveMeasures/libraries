import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareTrees, formatPatch } from '../compare.js'

// Renames told by path, which git does not look for: `lib` for `src` and a
// TypeScript extension for its JavaScript one, however little the content
// says, unless a candidate is far better. Lines of 20 bytes make each kept
// line 5% of a 20-line file; they differ at their ends, as git's span hash
// keeps only a span's last few bytes.

const lines = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${'-'.repeat(16)}${prefix}${String(from + i).padStart(2, '0')}\n`).join('')
const L = (from, to) => lines('L', from, to)
const M = (from, to) => lines('M', from, to)
const N = (from, to) => lines('N', from, to)

const tree = (files) => Object.entries(files).map(([name, data]) => (typeof data === 'string' ? { name, data } : { name, ...data }))
const renames = (old, fresh, options) => compareTrees(tree(old), tree(fresh), options)
  .map(({ status, old: from, new: to, similarity }) => (status === 'renamed' ? `${from.path} -> ${to.path} ${similarity}%` : `${status} ${(to ?? from).path}`))

// 20% alike: four lines of twenty kept.
const FIFTH = L(1, 4) + N(1, 16), SOURCE = L(1, 20)

describe('renames by path', () => {
  it('pairs lib with src, and a TypeScript extension with its JavaScript one, however little alike', () => {
    for (const [from, to] of [
      ['lib/a.js', 'src/a.ts'], ['src/a.ts', 'lib/a.js'], ['src/a.js', 'src/a.ts'], ['lib/a.js', 'src/a.js'],
      ['pkg/lib/x.cjs', 'pkg/src/x.cts'], ['a.mjs', 'a.mts'], ['ui/c.jsx', 'ui/c.tsx'], ['lib/deep/d.ts', 'src/deep/d.ts'],
    ]) assert.deepEqual(renames({ [from]: SOURCE }, { [to]: FIFTH }), [`${from} -> ${to} 20%`], `${from} -> ${to}`)
  })

  it('pairs nothing else by path', () => {
    for (const [from, to] of [['lib/a.js', 'src/b.ts'], ['lib/a.js', 'dist/a.js'], ['a.ts', 'a.json'], ['a.ts', 'a.tsx'], ['lib/a.js', 'src/x/a.js'], ['library/a.js', 'src/a.js']]) {
      assert.deepEqual(renames({ [from]: SOURCE }, { [to]: FIFTH }).toSorted(), [`added ${to}`, `deleted ${from}`], `${from} -> ${to}`)
    }
    assert.deepEqual(renames({ 'lib/a.js': { type: 'symlink', linkname: 'x' } }, { 'src/a.js': { type: 'symlink', linkname: 'y' } }), ['deleted lib/a.js', 'added src/a.js'])
  })

  it('gives way to a candidate halfway closer to 100% than the pair, on either side', () => {
    // 20% by path, against 95% for another added file: 95 is past 60.
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, { 'src/a.ts': FIFTH, 'src/b.ts': L(1, 19) + N(17, 17) }), ['added src/a.ts', 'lib/a.js -> src/b.ts 95%'])
    // 0% by path, against 95% for another deleted file: 95 is past 50.
    assert.deepEqual(renames({ 'lib/a.js': M(1, 20), 'lib/x.js': SOURCE }, { 'src/a.ts': L(1, 19) + N(1, 1) }), ['deleted lib/a.js', 'lib/x.js -> src/a.ts 95%'])
  })

  it('holds against a candidate only somewhat better, which git alone would take', () => {
    // 40% by path, against 60%: short of 70.
    const fresh = { 'src/a.ts': L(1, 8) + N(1, 12), 'src/b.ts': L(1, 12) + N(13, 20) }, old = { 'lib/a.js': SOURCE }
    assert.deepEqual(renames(old, fresh), ['lib/a.js -> src/a.ts 40%', 'added src/b.ts'])
    assert.deepEqual(renames(old, fresh, { renamesByPath: false }), ['added src/a.ts', 'lib/a.js -> src/b.ts 60%'])
  })

  it('takes the best of several partners', () => {
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, { 'src/a.js': L(1, 8) + N(1, 12), 'src/a.ts': FIFTH }), ['lib/a.js -> src/a.js 40%', 'added src/a.ts'])
  })

  it('comes after identical content, which is a better candidate than any', () => {
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, { 'src/a.ts': FIFTH, 'moved.js': SOURCE }), ['lib/a.js -> moved.js 100%', 'added src/a.ts'])
  })

  it('holds under -M100%, and past the rename limit, where nothing else is scored', () => {
    const fresh = { 'src/a.ts': FIFTH, 'src/b.ts': L(1, 19) + N(17, 17) }
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, fresh, { renames: 100 }), ['lib/a.js -> src/a.ts 20%', 'added src/b.ts'])
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, fresh, { renameLimit: 0 }), ['lib/a.js -> src/a.ts 20%', 'added src/b.ts'])
  })

  it('looks for none with renames off, or renamesByPath false, as git does', () => {
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, { 'src/a.ts': FIFTH }, { renames: false }), ['deleted lib/a.js', 'added src/a.ts'])
    assert.deepEqual(renames({ 'lib/a.js': SOURCE }, { 'src/a.ts': FIFTH }, { renamesByPath: false }), ['deleted lib/a.js', 'added src/a.ts'])
    assert.throws(() => compareTrees([], [], { renamesByPath: 'yes' }), TypeError)
  })

  it('writes a rename by path as any other', () => {
    const patch = formatPatch(compareTrees(tree({ 'lib/a.js': SOURCE }), tree({ 'src/a.ts': FIFTH })))
    assert.match(patch, /^diff --git a\/lib\/a\.js b\/src\/a\.ts\nsimilarity index 20%\nrename from lib\/a\.js\nrename to src\/a\.ts\n--- a\/lib\/a\.js\n\+\+\+ b\/src\/a\.ts\n/u)
  })
})
