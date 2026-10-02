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

  it('runs a dangling fence to the end', () => {
    assert.deepEqual(fencedLines(['## A', '````', '```', '## In code']), [false, true, true, true])
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
