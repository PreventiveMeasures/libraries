import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeptreeError } from '../pnpm.js'
import { applyPatch, parsePatch } from '../src/patch.js'

// Patches as `pnpm patch-commit` writes them: git's headers with full
// hashes, a/ and b/ in front of each path, and three lines of context.

const FILE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'

const MODIFY = `diff --git a/lib/x.js b/lib/x.js
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/lib/x.js
+++ b/lib/x.js
@@ -2,5 +2,5 @@ one
 two
 three
-four
+FOUR
 five
 six
`

const CREATE = `diff --git a/new.js b/new.js
new file mode 100755
index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333
--- /dev/null
+++ b/new.js
@@ -0,0 +1,2 @@
+#!/usr/bin/env node
+x
\\ No newline at end of file
`

const DELETE = `diff --git a/gone.js b/gone.js
deleted file mode 100644
index 4444444444444444444444444444444444444444..0000000000000000000000000000000000000000
`

const DELETE_FULL = `diff --git a/gone.js b/gone.js
deleted file mode 100644
index 4444444444444444444444444444444444444444..0000000000000000000000000000000000000000
--- a/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const pkg = () => new Map(Object.entries({ 'lib/x.js': FILE, 'gone.js': 'a\nb\n', 'package.json': '{}' }).map(([path, text]) => [path, { data: encoder.encode(text), mode: 0o644 }]))
const apply = (files, text) => applyPatch(files, parsePatch(text, 'x.patch'))
const text = (files, path) => decoder.decode(files.get(path).data)

describe('applyPatch', () => {
  it('changes, creates and deletes files, and leaves what it is given', () => {
    const before = pkg()
    const files = apply(before, `${MODIFY}${CREATE}${DELETE}`)
    assert.equal(text(files, 'lib/x.js'), FILE.replace('four', 'FOUR'))
    assert.equal(text(files, 'new.js'), '#!/usr/bin/env node\nx')
    assert.equal(files.get('new.js').mode, 0o755)
    assert.equal(files.has('gone.js'), false)
    assert.equal(text(before, 'lib/x.js'), FILE)
    assert.equal(before.has('gone.js'), true)
  })

  it('deletes a file whose whole content it names, and leaves its directory', () => {
    const files = apply(pkg(), DELETE_FULL.replaceAll('gone.js', 'lib/x.js').replace('@@ -1,2 +0,0 @@\n-a\n-b\n', `@@ -1,7 +0,0 @@\n${FILE.replace(/^/gmu, '-').slice(0, -1)}`))
    assert.equal(files.has('lib/x.js'), false)
    assert.deepEqual(files.get('lib'), { directory: true })
  })

  it('keeps a changed file\'s mode', () => {
    const files = pkg()
    files.set('lib/x.js', { ...files.get('lib/x.js'), mode: 0o755 })
    assert.equal(apply(files, MODIFY).get('lib/x.js').mode, 0o755)
  })

  const refused = [
    ['context that differs', MODIFY.replace(' three\n', ' THREE\n'), /"lib\/x\.js": the hunk at line 2 does not apply/u],
    ['context that differs only in trailing space', MODIFY.replace(' three\n', ' three \n'), /the hunk at line 2 does not apply/u],
    ['a hunk that would need to move', MODIFY.replace('@@ -2,5 +2,5 @@', '@@ -3,5 +3,5 @@'), /the hunk at line 3 does not apply/u],
    ['a rename', MODIFY.replace('diff --git a/lib/x.js b/lib/x.js', 'diff --git a/lib/x.js b/lib/y.js'), /expected a header naming one relative path/u],
    ['a mode change', MODIFY.replace('index 1111', 'old mode 100644\nnew mode 100755\nindex 1111'), /"old mode 100644" is not supported/u],
    ['a binary patch', `diff --git a/b.bin b/b.bin\nindex 1..2 100644\nGIT binary patch\nliteral 1\n`, /"GIT binary patch" is not supported/u],
    ['a path that climbs', MODIFY.replaceAll('lib/x.js', '../x.js'), /expected a header naming one relative path/u],
    ...[['a backslash', '..\\x.js'], ['a bidirectional control', 'a\u202Egnp.js'], ['a control', 'a\u0007b'], ['a line separator', 'a\u2028b']].map(([what, path]) => [`a path with ${what}`, CREATE.replaceAll('new.js', path), /expected a header naming one relative path/u]),
    ['a line between hunks', `${MODIFY}garbage\n`, /expected only hunks after the header/u],
    ['a line past a hunk\'s count', `${MODIFY} extra\n`, /expected unified hunks and nothing between them/u],
    ['a preamble', `From: someone\n${MODIFY}`, /expected "diff --git a\/" first/u],
    ['a carriage return', MODIFY.replaceAll('\n', '\r\n'), /a carriage return is not supported/u],
    ['a file created over one', CREATE.replaceAll('new.js', 'package.json'), /creates a file that is there/u],
    ['a file created over a directory', CREATE.replaceAll('new.js', 'lib'), /creates a file that is there/u],
    ['a file created inside a file', CREATE.replaceAll('new.js', 'package.json/x'), /creates a file that is there/u],
    ['a change to a file that is not there', MODIFY.replaceAll('lib/x.js', 'lib/z.js'), /changes a file that is not there/u],
    ['a deletion that leaves some of the file', DELETE_FULL.replace('@@ -1,2 +0,0 @@\n-a\n-b\n', '@@ -1 +0,0 @@\n-a\n'), /deletes a file it does not remove all of/u],
    ['an insertion with no context past the start', MODIFY.replace(/@@[^]*$/u, '@@ -3,0 +4 @@\n+x\n'), /one with no context/u],
  ]
  for (const [what, patch, pattern] of refused) {
    it(`refuses ${what}`, () => {
      assert.throws(() => apply(pkg(), patch), (error) => error instanceof DeptreeError && pattern.test(error.message))
    })
  }
})
