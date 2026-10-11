import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DiffError } from '@preventive/diff'
import { compareTrees, formatPatch } from '../compare.js'

// The patch, where git.test.js cannot say it: where git writes what a string
// cannot hold, where compare holds more than git does, and the options.

const patchOf = (old, fresh, options) => formatPatch(compareTrees(old, fresh), options)

describe('the patch', () => {
  it('quotes a name as git does: letters where C has them, octal for the rest', () => {
    const patch = patchOf([], [{ name: 'a\u{7}\b\v\f\r\u{1}\u{7F}\u{E9}\u{1F600}"\\ b' }])
    assert.equal(patch.split('\n')[0], 'diff --git "a/a\\a\\b\\v\\f\\r\\001\\177\\303\\251\\360\\237\\230\\200\\"\\\\ b" "b/a\\a\\b\\v\\f\\r\\001\\177\\303\\251\\360\\237\\230\\200\\"\\\\ b"')
  })

  it('names a hunk by the line above it cut to 80 bytes, at the last whole character', () => {
    // 79 bytes of name, then a two-byte character git would cut in half.
    const name = `${'f'.repeat(79)}\u{E9}()`
    const before = `${name}\n{\n${'\tx;\n'.repeat(6)}}\n`
    const patch = patchOf([{ name: 'c', data: before }], [{ name: 'c', data: before.replace('\tx;\n}', '\ty;\n}') }])
    assert.match(patch, new RegExp(`^@@ -5,5 \\+5,5 @@ ${'f'.repeat(79)}$`, 'mu'))
  })

  it('names a hunk by what it found for the one before, when nothing lies between them', () => {
    const lines = ['top', ...Array.from({ length: 20 }, (_, i) => ` ${i}`)]
    const after = lines.map((line, i) => (i === 5 || i === 18 ? `${line}!` : line))
    const patch = patchOf([{ name: 'f', data: `${lines.join('\n')}\n` }], [{ name: 'f', data: `${after.join('\n')}\n` }])
    assert.deepEqual(patch.split('\n').filter((line) => line.startsWith('@@')), ['@@ -3,7 +3,7 @@ top', '@@ -16,6 +16,6 @@ top'])
  })

  it('takes the context it is given', () => {
    // Lines of digits, which no hunk is named by.
    const after = '1\n2\n3!\n4\n5\n', before = '1\n2\n3\n4\n5\n'
    const hunks = (context) => patchOf([{ name: 'f', data: before }], [{ name: 'f', data: after }], { context }).split('\n').slice(3).join('\n')
    assert.equal(hunks(0), '@@ -3 +3 @@\n-3\n+3!\n')
    assert.equal(hunks(1), '@@ -2,3 +2,3 @@\n 2\n-3\n+3!\n 4\n')
    assert.equal(hunks(3), '@@ -1,5 +1,5 @@\n 1\n 2\n-3\n+3!\n 4\n 5\n')
  })

  it('writes a binary file added, or renamed and unchanged, as git does', () => {
    assert.equal(patchOf([], [{ name: 'x.bin', data: '\0' }]), 'diff --git a/x.bin b/x.bin\nnew file mode 100644\nBinary files /dev/null and b/x.bin differ\n')
    assert.equal(patchOf([{ name: 'x.bin', data: '\0' }], [{ name: 'y.bin', data: '\0' }]), 'diff --git a/x.bin b/y.bin\nsimilarity index 100%\nrename from x.bin\nrename to y.bin\n')
  })

  it("prints each change's own blocks, and refuses blocks that do not carry old to new", () => {
    const [change] = compareTrees([{ name: 'f', data: 'a\nb\n' }], [{ name: 'f', data: 'a\nB\n' }])
    assert.match(formatPatch([change]), /^-b\n\+B\n$/mu)
    assert.throws(() => formatPatch([{ ...change, blocks: [] }]), DiffError)
    assert.throws(() => formatPatch([{ ...change, blocks: [{ a0: 0, a1: 1, b0: 0, b1: 1 }] }]), DiffError)
  })

  it('writes nothing for no changes', () => {
    assert.equal(formatPatch([]), '')
  })

  it('takes a whole number of lines of context, and changes it knows', () => {
    for (const context of [-1, 1.5, '3', Number.NaN]) assert.throws(() => formatPatch([], { context }), RangeError, String(context))
    assert.throws(() => formatPatch([{ status: 'copied', old: null, new: null }]), TypeError)
  })
})
