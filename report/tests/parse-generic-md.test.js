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

test('products sharing an ID prefix still import as separate reports', async () => {
  const text = document.replaceAll('BBB-05', 'AAA-05')
  const reports = parseGenericMarkdownToReports(text)
  assert.deepEqual(reports.map((report) => report.displayName), ['Product A', 'Product B'])
  assert.deepEqual(reports.map(({ data }) => data.repo.github), ['a/a', 'a/b'])
  assert.deepEqual(reports.map(({ data }) => data.findings.map((finding) => finding.sourceId)), [['AAA-02'], ['AAA-05']])
  assert.equal(reports[1].data.findings[0].evidence.length, 2)
  assert.equal((await loadFindings(text)).findings[0].id, (await loadFindings(document)).findings[0].id)
  assert.throws(() => parseGenericMarkdownToReports(text.replaceAll('AAA-05', 'AAA-02')), /unsupported summary values for AAA-02/u)
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

test('keeps inline code and arrows inside Attack Scenario and stops at the next section', async () => {
  const scenario = 'Foo `code` --> something happens --> something else happens'
  const text = document.replace('### Attack Scenario\n\nText', `### Attack Scenario\n\n${scenario}`)
  const reports = parseGenericMarkdownToReports(text)
  const finding = reports[0].data.findings[0]
  assert.ok(finding.description.includes(`**Attack Scenario:**\n${scenario}`))
  assert.equal(finding.reproduction, '1. Step 1\n2. Step 2 text\n   continuation of step 2.\n3. Step 3')
  assert.equal(finding.recommendation, 'Text')
  assert.equal(reports[1].data.findings[0].sourceId, 'BBB-05')
  assert.equal(finding._idBasis.section, text.slice(text.indexOf('## 1.'), text.indexOf('## 2.')).trim())
  const loaded = await loadFindings(text)
  const exported = await loadFindings(writeMarkdown({ title: 'Audit', groups: loaded.findings.map(f => [{ ...f, source: loaded.data.source }]) }))
  assert.deepEqual(exported.findings.map(f => f.id), loaded.findings.map(f => f.id))
  assert.ok(exported.findings[0].description.includes(scenario))
})

test('fenced code remains raw section text, including tables and URLs', () => {
  for (const fence of ['```', '~~~']) {
    const code = `${fence}perl\n${summary}\nFoo \`code\` --> bar\nhttps://github.com/other/repo\ncurl https://api.example.com\n${fence}`
    const text = document.replace('### Attack Scenario\n\nText', `### Attack Scenario\n\n${code}`)
    const reports = parseGenericMarkdownToReports(text)
    const finding = reports[0].data.findings[0]
    assert.deepEqual(reports.map(({ data }) => data.repo.github), ['a/a', 'a/b'])
    assert.ok(finding.description.includes(`**Attack Scenario:**\n${code}`))
    assert.equal(finding.evidence.length, 1)
    assert.equal(finding.recommendation, 'Text')
    assert.equal(finding._idBasis.section, text.slice(text.indexOf('## 1.'), text.indexOf('## 2.')).trim())
    assert.match(finding.reproduction, /^1\. Step 1/u)
  }
})

test('preserves free-form section prose, inline examples and indented code', () => {
  const prose = '> Quoted prose --> followed by `curl https://api.example.com`.\n\n    https://github.com/other/repo\n    print("<code>")\n\nBackslash: \\ and entity: &amp;'
  const [report] = parseGenericMarkdownToReports(document.replace('Something.', prose))
  assert.ok(report.data.findings[0].description.includes(prose))
  assert.equal(report.data.repo.github, 'a/a')
})

test('keeps URLs inside multi-backtick and multiline code spans out of repository evidence', () => {
  for (const code of [
    '``https://api.example.com``',
    '``literal `backticks` and https://api.example.com``',
    '`curl\nhttps://api.example.com`',
    '``curl\nhttps://github.com/other/repo``',
  ]) {
    const scenario = `Run ${code} --> continue.`
    const text = document.replace('### Attack Scenario\n\nText', `### Attack Scenario\n\n${scenario}`)
    const [report] = parseGenericMarkdownToReports(text)
    const finding = report.data.findings[0]
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(finding.evidence.length, 1)
    assert.ok(finding.description.includes(scenario))
    assert.ok(finding._idBasis.section.includes(scenario))
    assert.match(finding.reproduction, /^1\. Step 1/u)
  }
})

const opaqueExamples = [
  '[x`]: /relative\nhttps://github.com/other/repo\nmatching ` closer',
  'Unmatched ` opener\n01. https://github.com/other/repo\n01. matching ` closer',
  '<!foo\nhttps://github.com/other/repo\n>',
  'Unmatched ` opener\n> https://github.com/other/repo\n> matching ` closer',
  '- item\n\n    https://github.com/other/repo',
  '-\titem\n\n\thttps://github.com/other/repo',
  '| ` opener | https://github.com/other/repo | ` closer |\n|---|---|---|',
]

test('body text is opaque and only Code references determines repository evidence', () => {
  for (const prose of opaqueExamples) {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', prose))
    const finding = report.data.findings[0]
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(finding.evidence.length, 1)
    assert.ok(finding.description.includes(prose))
    assert.ok(finding._idBasis.section.includes(prose))
  }
  const [report] = parseGenericMarkdownToReports(document.replace('| Title A. |', '| https://github.com/other/repo |'))
  assert.equal(report.data.repo.github, 'a/a', 'summary text also cannot supply repository evidence')
})

test('Code references rejects Markdown and other non-URL text without guessing', () => {
  for (const text of [...opaqueExamples, '`https://github.com/other/repo`', '[code](https://github.com/other/repo)', '```\nhttps://github.com/other/repo\n```', 'Explanation.']) {
    const input = document.replace('Code references:\n', `Code references:\n${text}\n`)
    assert.throws(() => parseGenericMarkdownToReports(input), /unsupported.*link syntax/u)
  }
})

const requiredHeaders = ['Title', 'Description', 'Root Cause', 'Code references:', 'Attack Scenario', 'Steps to Reproduce in the test environment', 'Impact', 'Patch']
for (const header of requiredHeaders) {
  test(`requires exactly one ${header} header in every finding`, () => {
    const line = header === 'Code references:' ? header : `### ${header}`
    for (const replacement of ['', `${line}\n\n${line}`]) {
      assert.throws(() => parseGenericMarkdownToReports(document.replace(`\n${line}\n`, `\n${replacement}\n`)), /unsupported.*(?:missing|required|duplicate)/u)
    }
  })
}

test('accepts plain, bold and heading forms of required headers and reproduction suffixes', () => {
  for (const style of [label => `${label}:`, label => `**${label}:**`, label => `###### ${label.toUpperCase()}: ######`]) {
    let input = document
    for (const header of requiredHeaders) {
      const line = header === 'Code references:' ? header : `### ${header}`
      input = input.replaceAll(`\n${line}\n`, `\n${style(header.replace(/:$/u, ''))}\n`)
    }
    const [report] = parseGenericMarkdownToReports(input)
    assert.equal(report.data.findings[0].recommendation, 'Text')
    assert.match(report.data.findings[0].reproduction, /^1\. Step 1/u)
    assert.equal(report.data.repo.github, 'a/a')
  }
})

test('rejects header-looking body content that duplicates or invents report structure', () => {
  for (const text of ['## 99. FAKE-01', '### Patch', 'Code references:']) {
    for (const [open, close] of [['```md', '```'], ['<!--', '-->']]) {
      const input = document.replace('Something.', `${open}\n${text}\n${close}`)
      assert.throws(() => parseGenericMarkdownToReports(input), /unsupported/u)
    }
  }
  assert.throws(() => parseGenericMarkdownToReports(document.replace('### Title', 'Unexpected preamble\n\n### Title')), /text before field headers/u)
})

test('hidden summary metadata cannot supply a report', async () => {
  const text = `<!--\n${summary}\n-->\n\n${first}\n\n${second}`
  assert.throws(() => parseGenericMarkdownToReports(text), /unsupported/u)
  assert.equal(readReport(text).data, null)
  assert.equal(await loadFindings(text), null)
})

test('leaves other formats alone', () => {
  for (const text of ['ordinary prose', '# Claude finding\n\n## Details\n\nText']) {
    assert.equal(parseGenericMarkdownToReports(text), null)
  }
})
