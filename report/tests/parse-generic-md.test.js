import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOURCE_LABELS, analyzeReport, detectFormat, isAppFinding, isSecurityFinding, loadFindings, parseGenericMarkdownToReports, readReport, writeMarkdown } from '../index.js'

const summary = `| # | ID | Product | Priority | Vulnerability |
|---:|---|---|---|---|
| 1 | AAA-02 | Product A | P0 | Title A. |
| 8 | BBB-05 | Product B | P1 | Title B. |`

function block(number, id, product, repo, extra = '') {
  return `## ${number}. ${id}

### Title

[${product}] Long title ${id}.

### Description

Description ${id}.

### Root Cause

Something.

Code references:

https://github.com/${repo}/blob/abcdef012345/c/d/e.js#L100-L110
${extra}
### Attack Scenario

Text

### Steps to Reproduce in the test environment

1. Step 1
2. Step 2 text
   continuation of step 2.
3. Step 3

### Impact

Text

### Patch

Text`
}

const first = block(1, 'AAA-02', 'Product A', 'a/a')
const second = block(2, 'BBB-05', 'Product B', 'a/b', 'https://github.com/a/b/blob/abcdef012345/f/g/h.js#L10-L20\n')
const document = `${summary}\n\n${first}\n\n${second}`

test('splits the generic Markdown example by product and matches IDs, not ordinal numbers', async () => {
  const reports = parseGenericMarkdownToReports(document)
  assert.deepEqual(reports.map((report) => report.displayName), ['Product A', 'Product B'])
  assert.deepEqual(reports.map((report) => report.data.repo), [{ github: 'a/a' }, { github: 'a/b' }])
  const [a, b] = reports.map((report) => report.data.findings[0])
  assert.equal(a.sourceId, 'AAA-02')
  assert.equal(a.severity, 'critical')
  assert.equal(b.sourceId, 'BBB-05')
  assert.equal(b.severity, 'high')
  assert.equal(a.file, 'c/d/e.js')
  assert.equal(a.line, '100-110')
  assert.equal(a.commitHash, 'abcdef012345')
  assert.equal(a.repo.github, 'a/a')
  assert.equal(b.repo.github, 'a/b')
  assert.equal(b.evidence.length, 2)
  assert.deepEqual(b.evidence[1], { file: 'f/g/h.js', line: '10-20', url: 'https://github.com/a/b/blob/abcdef012345/f/g/h.js#L10-L20' })
  assert.ok(a.description.startsWith('[Product A] Long title AAA-02.\n\nDescription AAA-02.'))
  for (const heading of ['Root Cause', 'Attack Scenario', 'Impact']) assert.ok(a.description.includes(`**${heading}:**`))
  assert.equal(a.reproduction, '1. Step 1\n2. Step 2 text\n   continuation of step 2.\n3. Step 3')
  assert.equal(a.recommendation, 'Text')
  assert.equal(detectFormat(document, 'anything.md'), 'markdown-generic')
  assert.equal(SOURCE_LABELS['markdown-generic'], 'Markdown (generic)')
  assert.equal(isAppFinding(a, reports[0].data.source), true)
  assert.deepEqual(analyzeReport(document), { count: 2, source: 'markdown-generic', recognized: true })
  const loaded = await loadFindings(document)
  assert.deepEqual(loaded.findings.map((f) => f.sourceId), ['AAA-02', 'BBB-05'])
  assert.equal(loaded.data.repo, undefined, 'a multi-product document has no single report-level repo')
})

test('groups repeated product rows in summary order and accepts CRLF, BOM and a document title', () => {
  const extra = block(99, 'AAA-03', 'Product A', 'a/a')
  const text = document.replace('| 8 |', '| 7 | AAA-03 | Product A | P2 | Another. |\n| 8 |') + '\n\n' + extra
  const reports = parseGenericMarkdownToReports('\uFEFF# Security Audit Report\r\n\r\n' + text.replaceAll('\n', '\r\n'))
  assert.deepEqual(reports[0].data.findings.map((f) => f.sourceId), ['AAA-02', 'AAA-03'])
  assert.equal(reports[0].data.findings[1].severity, 'medium')
})

test('infers a product repo across findings even when one has no links', () => {
  const text = `${summary.split('\n').slice(0, 3).join('\n')}\n| 2 | AAA-03 | Product A | P3 | Other. |\n\n${first}\n\n${block(2, 'AAA-03', 'Product A', 'a/a').replace(/https:\/\/[^\n]+/u, '')}`
  const [report] = parseGenericMarkdownToReports(text)
  assert.equal(report.data.findings[1].repo.github, 'a/a')
  assert.equal(report.data.findings[1].file, 'unknown')
  assert.equal(report.data.findings[1].severity, 'low')
  assert.equal(readReport(text).data.repo.github, 'a/a')
})

test('generic findings survive a Markdown export with IDs, repositories and narratives', async () => {
  const loaded = await loadFindings(document)
  const findings = loaded.findings.map((f) => ({ ...f, source: loaded.data.source }))
  const result = await loadFindings(writeMarkdown({ title: 'Audit', groups: findings.map((f) => [f]) }))
  assert.deepEqual(result.findings.map((f) => f.id), findings.map((f) => f.id))
  assert.deepEqual(result.findings.map((f) => f.repo), findings.map((f) => f.repo))
  assert.equal(result.findings[0].reproduction, findings[0].reproduction)
  assert.equal(result.findings[0].recommendation, 'Text')
})

test('a generic-looking preamble table does not shadow a Claude finding', () => {
  const text = `# Claude finding\n\n${summary}\n\n## Details\n\nDescription.\n\n---\n**Severity:** high\n**Repository:** a/a`
  assert.equal(parseGenericMarkdownToReports(text), null)
  const result = readReport(text)
  assert.equal(result.format, 'claude-security')
  assert.equal(result.data.findings.length, 1)
  assert.equal(result.data.findings[0].severity, 'high')
})

test('sectionless Claude findings retain their parser despite generic-looking tables', () => {
  for (const preamble of [summary, summary.replace('|---:|---|---|---|---|', '| invalid separator |')]) {
    const text = `# Claude finding\n\n${preamble}\n\n---\n**Severity:** high\n**Repository:** a/a`
    assert.equal(parseGenericMarkdownToReports(text), null)
    const result = readReport(text)
    assert.equal(result.format, 'claude-security')
    assert.equal(result.data.findings.length, 1)
    assert.equal(result.data.findings[0].severity, 'high')
  }
})

test('bare and partially populated generic tables still diagnose missing finding bodies', () => {
  for (const text of [summary, `# Security audit\n\n${summary}\n\n${first}`]) {
    assert.throws(() => parseGenericMarkdownToReports(text), /missing finding sections/u)
    assert.equal(readReport(text).data, null)
    assert.equal(readReport(text).format, 'markdown-generic')
  }
})


for (const label of ['Code references:', '### Code references', '#### Code references:', '##### CODE REFERENCES:', '**Code references:**', '### Code References: ###']) {
  test(`reads all repository evidence beneath ${label}`, () => {
    const reports = parseGenericMarkdownToReports(document.replaceAll('Code references:', label))
    assert.equal(reports[0].data.findings[0].file, 'c/d/e.js')
    assert.equal(reports[1].data.findings[0].evidence.length, 2)
    assert.deepEqual(reports.map(({ data }) => data.repo.github), ['a/a', 'a/b'])
  })
}

test('Vulnerability is required and explicitly marks findings as security at every severity', () => {
  assert.equal(parseGenericMarkdownToReports(document.replace('| Vulnerability |', '| Finding |')), null)
  const reports = parseGenericMarkdownToReports(document.replaceAll('| P0 |', '| P4 |').replaceAll('| P1 |', '| P4 |').replace('| Title A. |', '| |'))
  for (const { data } of reports) {
    for (const finding of data.findings) {
      assert.equal(finding.severity, 'informational')
      assert.equal(finding.security, true, 'the header alone declares security, even with an empty summary cell')
      assert.equal(isSecurityFinding(finding, data.source), true)
    }
  }
})

const invalid = [
  ['multiple repositories', document.replace('https://github.com/a/b/blob/abcdef012345/f/g/h.js', 'https://github.com/a/other/blob/abcdef012345/f/g/h.js')],
  ['same prefix across products', document.replaceAll('BBB-05', 'AAA-05')],
  ['multiple prefixes within a product', document.replaceAll('Product B', 'Product A')],
  ['no repository', document.replaceAll(/https:\/\/[^\n]+/gu, '')],
  ['missing body', `${summary}\n\n${first}`],
  ['unlisted body', `${document}\n\n${block(3, 'CCC-01', 'C', 'c/c')}`],
  ['duplicate body', `${document}\n\n${first}`],
  ['duplicate summary ID', document.replace('| 8 |', '| 2 | AAA-02 | Product A | P0 | Duplicate. |\n| 8 |')],
  ['invalid priority', document.replace('| P0 |', '| P7 |')],
  ['missing title', document.replace('### Title', '### Other')],
  ['duplicate field', document.replace('### Description', '### Title')],
  ['external repository link', document.replace('https://github.com/a/a/', 'https://example.com/a/a/')],
  ['invalid separator', document.replace('|---:|---|---|---|---|', '| invalid |')],
  ['invalid row', document.replace('| Title A. |', '| Title | A |')],
]
for (const [label, text] of invalid) {
  test(`rejects ${label} without returning partial reports`, async () => {
    assert.throws(() => parseGenericMarkdownToReports(text), /unsupported/u)
    assert.equal(readReport(text).data, null)
    assert.match(readReport(text).reason, /unsupported/u)
    assert.equal(detectFormat(text), 'markdown-generic')
    assert.equal(await loadFindings(text), null)
  })
}

test('rejects unsupported Markdown instead of interpreting it', () => {
  for (const snippet of [
    '`code`', '```md\n## 30. FAKE-01\n```', '~~~\nexample\n~~~',
    '<pre>example</pre>', '<!-- hidden -->', '> quoted text', '    indented code',
    '[link](https://github.com/a/a)', '![image](https://github.com/a/a)',
    '[ref]: https://github.com/a/a', '\\![escaped image](https://github.com/a/a)',
    'Text with https://github.com/a/a embedded.',
  ]) {
    assert.throws(() => parseGenericMarkdownToReports(document.replace('Something.', snippet)), /unsupported/u, snippet)
  }
  for (const cell of ['<pre>', '~~~', '<!--', '`', '\\![repo](https://github.com/other/repo)']) {
    assert.throws(() => parseGenericMarkdownToReports(document.replace('| Title A. |', `| ${cell} |`)), /unsupported/u)
  }
})

test('rejects hidden summary metadata and section headings', async () => {
  for (const text of [
    `<!--\n${summary}\n-->\n\n${first}\n\n${second}`,
    document.replace('Something.', '<!--\n## 3. AAA-03\n-->'),
  ]) {
    assert.throws(() => parseGenericMarkdownToReports(text), /unsupported/u)
    assert.equal(readReport(text).data, null)
    assert.equal(await loadFindings(text), null)
  }
})

test('leaves other formats alone', () => {
  for (const text of ['ordinary prose', '# Claude finding\n\n## Details\n\nText']) {
    assert.equal(parseGenericMarkdownToReports(text), null)
  }
})
