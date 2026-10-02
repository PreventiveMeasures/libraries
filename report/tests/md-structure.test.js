// `report/src/md-structure.js` — where fenced code is. Every structural
// splitter asks fenceRanges whether a `## ` or `| ` line is the
// document's or a snippet's, so a fence read wrongly is a heading
// invented or one swallowed. Each expectation below is the reading of
// the CommonMark reference implementation (commonmark.js 0.31).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { closesFence, fenceRanges, inFence } from '../src/md-structure.js'

// Which lines fall inside a fence, fence lines included.
function fencedLines(lines) {
  const text = lines.join('\n')
  const ranges = fenceRanges(text)
  let pos = 0
  return lines.map((line) => {
    const start = pos
    pos += line.length + 1
    return inFence(ranges, start)
  })
}

describe('fenceRanges — a fence is its whole run', () => {
  it('holds a ``` example whole inside a ```` block', () => {
    const lines = ['## Real', '````markdown', '```js', '## In the example', '```', '````', '## Second']
    assert.deepEqual(fencedLines(lines), [false, true, true, true, true, true, false])
  })

  it('holds a ~~~ example whole inside a ~~~~ block', () => {
    const lines = ['## A', '~~~~', '~~~', '## In code', '~~~', '~~~~', '## B']
    assert.deepEqual(fencedLines(lines), [false, true, true, true, true, true, false])
  })

  // Within three columns of the margin, as an opener — not of the
  // opener's own indent.
  it('closes only on a fence within three columns of the margin', () => {
    assert.deepEqual(fencedLines(['  ```', '     ```', '## in code']), [true, true, true])
  })

  it('closes on a longer run of the same character', () => {
    assert.deepEqual(fencedLines(['```', '## In code', '````', '## B']), [true, true, true, false])
  })

  it('does not close on the other character', () => {
    assert.deepEqual(fencedLines(['~~~', '```', '## In code', '~~~', '## B']), [true, true, true, true, false])
  })

  it('takes a ```js line inside a ``` block as code, not as its close', () => {
    const lines = ['## A', '```', '```js', '## In code', '```', '## B']
    assert.deepEqual(fencedLines(lines), [false, true, true, true, true, false])
  })

  // ```x``` opening a line is an inline code span, and ```js` is text:
  // a backtick fence's info string holds no backtick. Read as fences,
  // either ran to the end and took every heading after it.
  it('takes a backtick opener whose info string holds a backtick as text', () => {
    assert.deepEqual(fencedLines(['```x``` is inline code', '## h']), [false, false])
    assert.deepEqual(fencedLines(['```js`', '## h']), [false, false])
    // A tilde fence's info string may hold one.
    assert.deepEqual(fencedLines(['~~~js`', '## h', '~~~']), [true, true, true])
  })

  it('runs a dangling fence to the end', () => {
    assert.deepEqual(fencedLines(['## A', '````', '```', '## In code']), [false, true, true, true])
  })
})

// A fence inside a list item belongs to the item, and ends with it —
// closed or not. Read as running on, one numbered step whose snippet
// lost its closing fence took every heading after it.
describe('fenceRanges — a fence in a list item', () => {
  it('ends with the item, at the first line left of the item\'s text', () => {
    assert.deepEqual(fencedLines(['1. Run:', '   ```sh', '   curl', '## Impact', 'RCE.']), [false, true, true, false, false])
  })

  it('takes a fence line left of the item\'s text as the item\'s end, and a fence of its own', () => {
    assert.deepEqual(fencedLines(['1. item', '   ```', '  ```', '## in code']), [false, true, true, true])
  })

  it('keeps the item through a lazy line of its paragraph', () => {
    const lines = ['1. step', 'lazy text', '   ```', '   code', 'Next para', '## after']
    assert.deepEqual(fencedLines(lines), [false, false, true, true, false, false])
  })

  // Only paragraph text continues lazily. An indented code block is not
  // one: unindented prose after it has left the list, and a fence after
  // that is the document's, running to the end.
  it('continues no indented code block lazily', () => {
    const lines = ['- item', '', '      indented code', 'prose', '   ```', '## heading']
    assert.deepEqual(fencedLines(lines), [false, false, false, false, true, true])
  })

  // A line short of a nested item's text can still be in the outer item;
  // a fence there ends with the OUTER item, not with the document.
  it('ends a fence with the item it falls back to, when it leaves a nested one', () => {
    const lines = ['- item', 'Some prose.', '  - nested', '   ```', '   code', '## Details']
    assert.deepEqual(fencedLines(lines), [false, false, false, true, true, false])
  })

  it('reads a fence left of the list\'s text as having left the list', () => {
    const lines = ['- item', '', '```sh', 'code', '```', '   ```', '', '---', '## in code']
    assert.deepEqual(fencedLines(lines), [false, false, true, true, true, true, true, true, true])
  })
})

// Nothing in an HTML block is markdown, so a ``` there opens no fence;
// and a block HTML tag interrupts a paragraph, where a lone tag of any
// other kind continues it. List markers too are read as CommonMark
// reads them: a fence may open on the marker's own line, five spaces
// after a marker are one and indented code, and only a `1.` starts a
// list in the middle of a paragraph.
describe('fenceRanges — HTML blocks and list markers', () => {
  it('opens no fence inside an HTML comment or a <pre>', () => {
    assert.deepEqual(fencedLines(['<!--', '```', '-->', '# heading']), [false, false, false, false])
    assert.deepEqual(fencedLines(['<pre>', '```', '</pre>', '# heading']), [false, false, false, false])
    assert.deepEqual(fencedLines(['<!-- note -->', '```', '# in code']), [false, true, true])
  })

  it('ends a list item\'s paragraph at a block tag, so a fence after it is the document\'s', () => {
    const lines = ['1. Run the server', '<div>', '', '   ```sh', '# start it', 'curl', '   ```', '# after']
    assert.deepEqual(fencedLines(lines), [false, false, false, true, true, true, true, false])
  })

  it('continues a list item\'s paragraph with a lone tag, so its fence stays the item\'s', () => {
    const lines = ['1. step', '<span>x</span>', '   ```', '# after', 'x']
    assert.deepEqual(fencedLines(lines), [false, false, true, false, false])
  })

  it('continues a quote\'s paragraph lazily, keeping the item it sits in', () => {
    assert.deepEqual(fencedLines(['- a', '  > quote', 'lazy', '  ```', '# after']), [false, false, false, true, false])
  })

  it('opens a fence on a list marker\'s own line, in the item', () => {
    assert.deepEqual(fencedLines(['1. ```sh', '   # in code', '# after']), [true, true, false])
  })

  it('takes five spaces after a marker as one, and the rest as code', () => {
    assert.deepEqual(fencedLines(['-     wide', '   ```', '- next']), [false, true, false])
  })

  it('starts no list mid-paragraph but at 1', () => {
    assert.deepEqual(fencedLines(['text', '2. not an item', '   ```', '# heading']), [false, false, true, true])
  })
})

describe('closesFence', () => {
  it('takes the same character, at least as long, and nothing after it', () => {
    assert.ok(closesFence('```', '```'))
    assert.ok(closesFence('```', '`````'))
    assert.ok(closesFence('~~~', '~~~  '))
    assert.ok(!closesFence('````', '```'))
    assert.ok(!closesFence('```', '~~~'))
    assert.ok(!closesFence('```', '```js'))
    assert.ok(!closesFence('```', 'text'))
  })
})
