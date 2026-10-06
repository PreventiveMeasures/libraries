import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveFindingId, loadFindings, readReport } from '../index.js'

const document = `| # | ID | Product | Priority | Vulnerability |
|---:|---|---|---|---|
| 1 | AAA-02 | Product A | P0 | Title A. |

## 1. AAA-02

### Title

[Product A] Long title A.

### Root Cause

Code references:

https://github.com/a/a/blob/abcdef0/src/a.js#L10-L20
`
const ID = 'e558bcf0-cffe-4412-8182-3fbbe9590490'

test('generic finding IDs hash the original summary row and complete raw partition', async () => {
  const { findings } = await loadFindings(document)
  assert.equal(findings[0].id, ID)
  assert.equal(findings[0].sourceId, 'AAA-02')
  assert.deepEqual(findings[0]._idBasis, {
    source: 'markdown-generic',
    row: '| 1 | AAA-02 | Product A | P0 | Title A. |',
    section: document.slice(document.indexOf('## 1.')).trim(),
  })
  assert.equal((await loadFindings(document.replaceAll('\n', '\r\n'))).findings[0].id, ID)
})

test('severity mapping, field parsing and repository inference cannot re-key imported findings', async () => {
  const finding = readReport(document).data.findings[0]
  Object.assign(finding, {
    severity: 'medium', priority: 'other', description: 'Different parsed narrative',
    reproduction: 'New interpretation', recommendation: 'Different patch',
    file: 'new/path.js', line: '42', repo: { github: 'different/inference' },
    evidence: [], sourceId: 'different parsed label',
    security: false,
  })
  assert.equal(await deriveFindingId(finding), ID)
  assert.equal((await loadFindings(JSON.stringify({ findings: [finding] }))).findings[0].id, ID)
})

test('source row and any partition content participate in the hash', async () => {
  for (const text of [
    document.replace('| Title A. |', '| Changed summary. |'),
    document + '\n### Future section\n\nNew raw text\n',
    document.replace('Long title A.', 'Changed title.'),
  ]) {
    assert.notEqual((await loadFindings(text)).findings[0].id, ID)
  }
  assert.equal((await loadFindings('# A different document title\n\n' + document)).findings[0].id, ID)
})
