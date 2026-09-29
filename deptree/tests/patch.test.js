import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
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

const pkg = () => createVfs({ '/p/lib/x.js': FILE, '/p/gone.js': 'a\nb\n', '/p/package.json': '{}' })
const apply = (vfs, text) => applyPatch(vfs, '/p', parsePatch(text, 'x.patch'))

describe('applyPatch', () => {
  it('changes, creates and deletes files', () => {
    const vfs = pkg()
    apply(vfs, `${MODIFY}${CREATE}${DELETE}`)
    assert.equal(vfs.readText('/p/lib/x.js'), FILE.replace('four', 'FOUR'))
    assert.equal(vfs.readText('/p/new.js'), '#!/usr/bin/env node\nx')
    assert.equal(vfs.stat('/p/new.js').mode, 0o755)
    assert.equal(vfs.isFile('/p/gone.js'), false)
  })

  it('deletes a file whose whole content it names', () => {
    const vfs = pkg()
    apply(vfs, DELETE_FULL)
    assert.equal(vfs.isFile('/p/gone.js'), false)
  })

  it('keeps a changed file\'s mode', () => {
    const vfs = pkg()
    vfs.chmod('/p/lib/x.js', 0o755)
    apply(vfs, MODIFY)
    assert.equal(vfs.stat('/p/lib/x.js').mode, 0o755)
  })

  const refused = [
    ['context that differs', MODIFY.replace(' three\n', ' THREE\n'), /"lib\/x\.js": the hunk at line 2 does not apply/u],
    ['context that differs only in trailing space', MODIFY.replace(' three\n', ' three \n'), /the hunk at line 2 does not apply/u],
    ['a hunk that would need to move', MODIFY.replace('@@ -2,5 +2,5 @@', '@@ -3,5 +3,5 @@'), /the hunk at line 3 does not apply/u],
    ['a rename', MODIFY.replace('diff --git a/lib/x.js b/lib/x.js', 'diff --git a/lib/x.js b/lib/y.js'), /expected a header naming one relative path/u],
    ['a mode change', MODIFY.replace('index 1111', 'old mode 100644\nnew mode 100755\nindex 1111'), /"old mode 100644" is not supported/u],
    ['a binary patch', `diff --git a/b.bin b/b.bin\nindex 1..2 100644\nGIT binary patch\nliteral 1\n`, /"GIT binary patch" is not supported/u],
    ['a path that climbs', MODIFY.replaceAll('lib/x.js', '../x.js'), /expected a header naming one relative path/u],
    ['a line between hunks', `${MODIFY}garbage\n`, /expected only hunks after the header/u],
    ['a line past a hunk\'s count', `${MODIFY} extra\n`, /expected unified hunks and nothing between them/u],
    ['a preamble', `From: someone\n${MODIFY}`, /expected "diff --git a\/" first/u],
    ['a carriage return', MODIFY.replaceAll('\n', '\r\n'), /a carriage return is not supported/u],
    ['a file created over one', CREATE.replaceAll('new.js', 'package.json'), /creates a file that is there/u],
    ['a change to a file that is not there', MODIFY.replaceAll('lib/x.js', 'lib/z.js'), /changes a file that is not there/u],
    ['a deletion that leaves some of the file', DELETE_FULL.replace('@@ -1,2 +0,0 @@\n-a\n-b\n', '@@ -1 +0,0 @@\n-a\n'), /deletes a file it does not remove all of/u],
    ['an insertion with no context past the start', MODIFY.replace(/@@[^]*$/u, '@@ -3,0 +4 @@\n+x\n'), /one with no context/u],
  ]
  for (const [what, text, pattern] of refused) {
    it(`refuses ${what}`, () => {
      assert.throws(() => apply(pkg(), text), (error) => error instanceof DeptreeError && pattern.test(error.message))
    })
  }
})
