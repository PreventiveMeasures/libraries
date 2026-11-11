import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeReport, detectFormat, isSecurityFinding, loadFindings, parseGenericMarkdownToReports, readReport, writeMarkdown } from '../index.js'

const blob = (repo, path, anchor = '') => `https://github.com/${repo}/blob/abcdef012345/${path}${anchor}`

function finding(title, affected = `- [\`src/a.ts#L10-L20\`](${blob('a/a', 'src/a.ts', '#L10-L20')}) - Explanation of ${title}.`, description = `Description of ${title}.`) {
  return `# ${title}

### Description

${description}

### Affected Code

${affected}

### Fix

1. Recommended remediation.
2. Additional controls.

### Tests

1. Security regression test.
2. Negative test.
`
}

const second = finding('Second', [
  `- [\`src/b/c.ts#L5\`](${blob('a/a', 'src/b/c.ts', '#L5')}) - One.`,
  `- [\`src/b/d.ts\`](${blob('A/A', 'src/b/d.ts').replace('abcdef012345', 'ABCDEF012345')}) — Two,`,
  '  continued.',
].join('\n'))
const document = `${finding('First')}\n${second}`

test('reads concatenated findings, each repository named by its Affected Code alone', () => {
  const reports = parseGenericMarkdownToReports(document)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].displayName, 'a/a')
  assert.deepEqual(reports[0].data.repo, { github: 'a/a', directory: 'src' })
  assert.equal(reports[0].data.product, undefined)
  const [a, b] = reports[0].data.findings
  assert.equal(a.description, 'First\n\nDescription of First.\n\n**Tests:**\n1. Security regression test.\n2. Negative test.')
  assert.equal(a.recommendation, '1. Recommended remediation.\n2. Additional controls.')
  assert.equal(a.severity, 'medium', 'the format names no severity')
  assert.equal(a.security, true)
  assert.equal(isSecurityFinding(a, reports[0].data.source), true)
  assert.deepEqual(a.repo, { github: 'a/a' })
  assert.equal(a.file, 'src/a.ts')
  assert.equal(a.line, '10-20')
  assert.equal(a.location, blob('a/a', 'src/a.ts', '#L10-L20'))
  assert.deepEqual(a.evidence, [{ file: 'src/a.ts', line: '10-20', url: a.location, text: 'Explanation of First.' }])
  assert.equal(a.auditedCommit, 'abcdef012345')
  assert.deepEqual(b.evidence.map(({ file, line, text }) => [file, line, text]), [['src/b/c.ts', '5', 'One.'], ['src/b/d.ts', '?', 'Two,\ncontinued.']])
  assert.equal(b.auditedCommit, 'abcdef012345', 'one commit in two casings is still one commit')
  assert.equal(b.sourceId, undefined)
  assert.equal(detectFormat(document, 'report.md'), 'markdown-generic')
  assert.deepEqual(analyzeReport(document), { count: 2, source: 'markdown-generic', recognized: true })
})

test('Description is free text: fenced `#` lines, other headings and severity words stay in it', () => {
  const description = [
    '**Severity:** High, as it is reachable unauthenticated.',
    '',
    '```sh',
    '# a comment, not a finding',
    '### Fix',
    'curl https://github.com/other/repo',
    '```',
    '',
    '### Impact',
    '',
    '#### Prerequisites',
    '',
    '- [link](https://github.com/other/repo/blob/main/x.js) in prose',
  ].join('\n')
  const reports = parseGenericMarkdownToReports(finding('Free', undefined, description))
  assert.equal(reports.length, 1)
  const [f] = reports[0].data.findings
  assert.equal(f.description, `Free\n\n${description}\n\n**Tests:**\n1. Security regression test.\n2. Negative test.`)
  assert.equal(f.severity, 'medium')
  assert.equal(f.evidence.length, 1)
})

test('Affected Code takes any list marker, angle-bracket and parenthesised links, and an optional explanation', () => {
  const affected = [
    `* [page](${blob('a/a', 'app/(main)/page.tsx', '#L1-L2')})`,
    `1. [\`api.ts\`](<${blob('a/a', 'app/api.ts', '#L7')}>): Colon.`,
    `+ [x](${blob('a/a', 'app/x.ts', '#L3-4')}) – Dash.`,
    '',
    `- [y](${blob('a/a', 'app/y.ts')})`,
    '  - Nested detail.',
  ].join('\n')
  const [report] = parseGenericMarkdownToReports(finding('Forms', affected).replace('### Affected Code', '### Affected code'))
  assert.deepEqual(report.data.repo, { github: 'a/a', directory: 'app' })
  assert.deepEqual(report.data.findings[0].evidence, [
    { file: 'app/(main)/page.tsx', line: '1-2', url: blob('a/a', 'app/(main)/page.tsx', '#L1-L2') },
    { file: 'app/api.ts', line: '7', url: blob('a/a', 'app/api.ts', '#L7'), text: 'Colon.' },
    { file: 'app/x.ts', line: '3-4', url: blob('a/a', 'app/x.ts', '#L3-4'), text: 'Dash.' },
    { file: 'app/y.ts', line: '?', url: blob('a/a', 'app/y.ts'), text: '- Nested detail.' },
  ])
  const [encoded] = parseGenericMarkdownToReports(finding('Encoded', `- [a b](${blob('a/a', 'my%20app/a%20b.ts', '#L1')})`))
  assert.equal(encoded.data.findings[0].file, 'my app/a b.ts', 'decoded as the table layout decodes it')
})

test('findings in different repositories import as one report per repository', async () => {
  const other = finding('Other', `- [b.ts](${blob('b/b', 'lib/b.ts', '#L1')})`)
  const text = `${finding('First')}\n${other}\n${second}`
  const reports = parseGenericMarkdownToReports(text)
  assert.deepEqual(reports.map(({ displayName, data }) => [displayName, data.repo, data.findings.length]), [
    ['a/a', { github: 'a/a', directory: 'src' }, 2],
    ['b/b', { github: 'b/b', directory: 'lib' }, 1],
  ])
  const loaded = await loadFindings(text)
  assert.equal(loaded.data.repo, undefined, 'a multi-repository document has no single report-level repo')
  assert.deepEqual(loaded.findings.map((f) => f.repo.github), ['a/a', 'a/a', 'b/b'])
})

test('each id hashes only its own finding: the others, their order and line endings move none', async () => {
  const ids = async (text) => (await loadFindings(text)).findings.map((f) => f.id)
  const [first, last] = await ids(document)
  assert.notEqual(first, last)
  assert.deepEqual(await ids(`${second}\n${finding('First')}`), [last, first])
  assert.deepEqual(await ids(document.replaceAll('\n', '\r\n')), [first, last])
  const [edited, unchanged] = await ids(document.replace('Description of First.', 'Changed.'))
  assert.notEqual(edited, first)
  assert.equal(unchanged, last)
})

test('findings survive a Markdown export with ids, evidence notes and narrative', async () => {
  const loaded = await loadFindings(document)
  const findings = loaded.findings.map((f) => ({ ...f, source: loaded.data.source }))
  const result = await loadFindings(writeMarkdown({ title: 'Audit', groups: findings.map((f) => [f]) }))
  assert.deepEqual(result.findings.map((f) => f.id), findings.map((f) => f.id))
  assert.deepEqual(result.findings.map((f) => f.repo), findings.map((f) => f.repo))
  assert.deepEqual(result.findings[1].evidence.map((row) => row.text), ['One.', 'Two,\ncontinued.'])
  assert.equal(result.findings[0].recommendation, findings[0].recommendation)
  assert.match(result.findings[0].description, /Negative test\./u)
})

const invalid = [
  ['text before the sections', document.replace('### Description', 'Preamble.\n\n### Description'), /text before section headers for "First"/u],
  ['a document title before the findings', `# Security Report\n\n${document}`, /missing required headers for "Security Report"/u],
  ['a duplicate section', document.replace('### Fix', '### Tests'), /duplicate section Tests for "First"/u],
  ['a duplicate finding', `${document}\n${finding('First')}`, /duplicate finding "First"/u],
  ['prose in Affected Code', finding('Prose', `See [a.ts](${blob('a/a', 'a.ts')}).`), /Affected Code for "Prose"; expected a list/u],
  ['an empty Affected Code', finding('Empty', ''), /Affected Code for "Empty"; expected a list/u],
  ['an item not opening on a link', finding('Late', `- In [a.ts](${blob('a/a', 'a.ts')})`), /item for "Late"/u],
  ['a bare URL item', finding('Bare', `- ${blob('a/a', 'a.ts')}`), /item for "Bare"/u],
  ['a relative link', finding('Relative', '- [a.ts](src/a.ts#L1)'), /item for "Relative"/u],
  ['a non-GitHub link', finding('Elsewhere', '- [a.ts](https://example.com/a/a/blob/main/a.ts)'), /repository URL/u],
  ['a directory link', finding('Tree', '- [src](https://github.com/a/a/tree/main/src)'), /link for "Tree"; expected a link to a file/u],
  ['a repository link', finding('Root', '- [a/a](https://github.com/a/a)'), /link for "Root"; expected a link to a file/u],
  ['two repositories in one finding', finding('Two', `- [a](${blob('a/a', 'a.ts')})\n- [b](${blob('b/b', 'b.ts')})`), /repository set for "Two"/u],
  ['a missing Description', document.replace('### Description\n\nDescription of First.\n', ''), /missing required headers for "First"/u],
  ...['Affected Code', 'Fix', 'Tests'].map((section) => [`a missing ${section}`, document.replace(`### ${section}\n`, ''), /missing required headers for "First"/u]),
]
for (const [label, text, reason] of invalid) {
  test(`rejects ${label} without returning partial reports`, async () => {
    assert.throws(() => parseGenericMarkdownToReports(text), reason)
    assert.equal(readReport(text).data, null)
    assert.match(readReport(text).reason, /^Markdown \(generic\): unsupported /u)
    assert.equal(detectFormat(text), 'markdown-generic')
    assert.equal(await loadFindings(text), null)
  })
}

test('a `# Title` document with no Affected Code section is left to the other formats', () => {
  const text = finding('Claude finding').replace('### Affected Code', '### Location')
  assert.equal(parseGenericMarkdownToReports(text), null)
  assert.equal(readReport(text).format, 'claude-security')
  const fenced = `# Claude finding\n\n## Details\n\n\`\`\`md\n### Affected Code\n\`\`\`\n\n---\n**Severity:** high`
  assert.equal(parseGenericMarkdownToReports(fenced), null)
  assert.equal(readReport(fenced).data.findings[0].severity, 'high')
})
