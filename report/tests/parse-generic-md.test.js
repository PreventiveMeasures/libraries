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

test('keeps fenced headings, nested steps, and arbitrary reproduction heading suffixes', () => {
  const snippet = '\n```md\n## 30. FAKE-01\n### Patch\nexample\n```\n'
  const [report] = parseGenericMarkdownToReports(document.replace('Description AAA-02.', 'Description AAA-02.' + snippet))
  assert.ok(report.data.findings[0].description.includes(snippet.trim()))
  assert.equal(report.data.findings[0].recommendation, 'Text')
})

test('reads Markdown and angle links, parentheses in file paths, and escaped table cells', () => {
  const text = document.replaceAll('Product A', 'Product \\| A').replace(
    'https://github.com/a/a/blob/abcdef012345/c/d/e.js#L100-L110',
    '[code](https://github.com/A/A/blob/main/app/(main)/[id]/page.ts#L10-L20)\n<https://github.com/a/a/blob/main/second.js#L4>',
  )
  const [report] = parseGenericMarkdownToReports(text)
  assert.equal(report.displayName, 'Product | A')
  assert.equal(report.data.findings[0].file, 'app/(main)/[id]/page.ts')
  assert.equal(report.data.findings[0].evidence.length, 2)
  assert.equal(report.data.findings[0].commitHash, undefined)
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

const invalid = [
  ['multiple repositories', document.replace('https://github.com/a/b/blob/abcdef012345/f/g/h.js', 'https://github.com/a/other/blob/abcdef012345/f/g/h.js'), /Product B.*exactly one repository/u],
  ['same prefix across products', document.replaceAll('BBB-05', 'AAA-05'), /prefix "AAA-" is shared/u],
  ['multiple prefixes within a product', document.replaceAll('Product B', 'Product A'), /Product A.*multiple ID prefixes/u],
  ['no repository', document.replaceAll(/https:\/\/[^\n]+/gu, ''), /Product A.*found none/u],
  ['missing body', `${summary}\n\n${first}`, /missing finding section BBB-05/u],
  ['unlisted body', `${document}\n\n${block(3, 'CCC-01', 'C', 'c/c')}`, /not in the summary/u],
  ['duplicate body', `${document}\n\n${first}`, /duplicate finding section AAA-02/u],
  ['duplicate summary ID', document.replace('| 8 |', '| 2 | AAA-02 | Product A | P0 | Duplicate. |\n| 8 |'), /duplicate summary ID/u],
  ['invalid priority', document.replace('| P0 |', '| P7 |'), /unknown priority/u],
  ['missing title', document.replace('### Title', '### Other'), /no Title section/u],
  ['repo prefix lookalike', document.replace('https://github.com/a/b/blob/abcdef012345/f/g/h.js', 'https://github.com/a/b-other/blob/abcdef012345/f/g/h.js'), /exactly one repository/u],
  ['external link in narrative', document.replace('### Impact', 'https://example.com/docs\n\n### Impact'), /outside a GitHub repository/u],
  ['foreign link before Markdown link', document.replace('Something.', 'https://github.com/other/repo [code](https://github.com/a/a/blob/main/a.js)'), /exactly one repository/u],
  ['GitHub hostname lookalike', document.replace('https://github.com/a/a/', 'https://github.com.example.com/a/a/'), /outside a GitHub repository/u],
]

for (const [label, text, error] of invalid) {
  test(`rejects ${label} without returning partial reports`, async () => {
    assert.throws(() => parseGenericMarkdownToReports(text), error)
    assert.equal(readReport(text).data, null)
    assert.match(readReport(text).reason, error)
    assert.equal(detectFormat(text), 'markdown-generic')
    assert.equal(await loadFindings(text), null)
  })
}

test('leaves other formats alone, including fenced examples of the summary', () => {
  for (const text of ['ordinary prose', '# Claude finding\n\n## Details\n\nText', `# Example\n\n\`\`\`md\n${document}\n\`\`\``]) {
    assert.equal(parseGenericMarkdownToReports(text), null)
  }
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
    assert.throws(() => parseGenericMarkdownToReports(text), /missing finding section/u)
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

for (const snippet of [
  '```sh\ncurl https://api.example.com\n```',
  '~~~md\n[unrelated](https://github.com/other/repo/blob/main/a.js)\n~~~',
  '`curl https://api.example.com`',
  '``curl `https://api.example.com`\nhttps://github.com/other/repo``',
  '1. Run the command\n   ```sh\n   curl https://api.example.com\n   ```',
]) {
  test(`ignores code example URLs when inferring repositories: ${snippet.split('\n')[0]}`, () => {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${snippet}`))
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(report.data.findings[0].evidence.length, 1)
    assert.ok(report.data.findings[0].description.includes(snippet), 'example remains in the finding narrative')
  })
}

test('keeps actual Markdown links with code-formatted labels', () => {
  const text = document.replace('https://github.com/a/a/blob/abcdef012345/c/d/e.js#L100-L110', '[`c/d/e.js`](https://github.com/a/a/blob/abcdef012345/c/d/e.js#L100-L110)')
  assert.equal(parseGenericMarkdownToReports(text)[0].data.findings[0].file, 'c/d/e.js')
})

for (const snippet of [
  '    curl https://api.example.com\n    echo https://github.com/other/repo',
  '\tcurl https://api.example.com',
  '1. Run the command\n\n       curl https://api.example.com\n       echo https://github.com/other/repo',
]) {
  test(`ignores indented code URLs: ${snippet.split('\n')[0]}`, () => {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${snippet}`))
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(report.data.findings[0].evidence.length, 1)
  })
}

test('indented paragraph and list continuations remain actual links', () => {
  for (const extra of [
    'Some text\n    https://github.com/other/repo',
    '1. More evidence:\n   https://github.com/other/repo',
    '1. More evidence:\n\n    https://github.com/other/repo',
  ]) {
    assert.throws(() => parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${extra}`)), /exactly one repository/u)
  }
})

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

for (const snippet of [
  '>     curl https://api.example.com',
  '> ~~~sh\n> curl https://api.example.com\n> ~~~',
  '> ```sh\n> curl https://api.example.com',
  '> > ~~~sh\n> > curl https://api.example.com\n> > ~~~',
  '- >     curl https://api.example.com',
  '1. > ~~~sh\n   > curl https://api.example.com\n   > ~~~',
  '1. > ~~~sh\n   > curl https://api.example.com',
  '- 1. > ~~~sh\n     > curl https://api.example.com\n     > ~~~',
  '> - > ~~~sh\n>   > curl https://api.example.com\n>   > ~~~',
]) {
  test(`ignores quoted code examples without consuming later links: ${snippet.split('\n')[0]}`, () => {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${snippet}\n`))
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(report.data.findings[0].evidence.length, 1)
  })
}

test('quoted prose links still participate in repository validation', () => {
  for (const snippet of [
    '> https://github.com/other/repo',
    '- > https://github.com/other/repo',
    '1. > https://github.com/other/repo',
    '- > ~~~sh\n  > curl https://api.example.com\n- > https://github.com/other/repo',
    '> > ~~~sh\n> > curl https://api.example.com\n> https://github.com/other/repo',
    '> Paragraph\nlazy continuation\n>     https://github.com/other/repo',
  ]) {
    assert.throws(() => parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${snippet}`)), /exactly one repository/u)
  }
})

test('quote and list boundaries keep literal nested markers in their code blocks', () => {
  for (const snippet of [
    '> ~~~sh\n> > https://api.example.com\n> ~~~',
    '> 1. ~~~sh\n>    https://api.example.com\n> Actual prose.',
    '> - > ~~~sh\n>   > https://api.example.com\n> - > Actual prose.',
  ]) {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${snippet}`))
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(report.data.findings[0].evidence.length, 1)
  }
})

for (const image of [
  '![proof](https://images.example.com/proof.png)',
  '![](https://images.example.com/proof.png)',
  '![proof](<https://images.example.com/proof (1).png>)',
  '![proof](https://images.example.com/proof(1).png)',
  '[![proof](https://images.example.com/proof.png)](https://github.com/a/a)',
  '![https://images.example.com/alt](https://images.example.com/proof.png)',
  '![proof](https://images.example.com/proof.png "Proof")',
  '![](https://images.example.com/proof(1).png \'Proof\')',
  '![proof](<https://images.example.com/proof (1).png> (Proof))',
  '![proof](https://images.example.com/proof.png "https://images.example.com/title")',
]) {
  test(`ignores image destinations while retaining the narrative: ${image}`, () => {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${image}`))
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(report.data.findings[0].evidence.length, 1)
    assert.ok(report.data.findings[0].description.includes(image))
  })
}

test('linked images and escaped exclamation marks preserve actual link destinations', () => {
  for (const link of [
    '[![proof](https://images.example.com/proof.png)](https://github.com/other/repo)',
    '\\![proof](https://github.com/other/repo)',
    '[repo](https://github.com/other/repo "Repository")',
  ]) {
    assert.throws(() => parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${link}`)), /exactly one repository/u)
  }
})

for (const reference of [
  '![proof][img]\n\n[img]: https://images.example.com/proof.png',
  '![img][]\n\n[img]: <https://images.example.com/proof.png>',
  '![img]\n\n[img]: https://images.example.com/proof.png "Proof"',
  '![proof][ IMG ]\n\n[img]:\n  https://images.example.com/proof.png',
  '![proof][img]\n\n[img]: https://images.example.com/proof.png\n  "https://images.example.com/title"',
  '[![proof][img]](https://github.com/a/a)\n\n[img]: https://images.example.com/proof.png',
  '[![proof](https://images.example.com/proof.png)][repo]\n\n[repo]: https://github.com/a/a',
]) {
  test(`ignores reference images while preserving hyperlinks: ${reference.split('\n')[0]}`, () => {
    const [report] = parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${reference}`))
    assert.equal(report.data.repo.github, 'a/a')
    assert.equal(report.data.findings[0].evidence.length, 1)
    assert.ok(report.data.findings[0].description.includes(reference))
  })
}

test('ordinary references, including definitions shared with images, validate repositories', () => {
  for (const reference of [
    '[repo][other]\n\n[other]: https://github.com/other/repo',
    '[other][]\n\n[other]: https://github.com/other/repo',
    '[other]\n\n[other]: https://github.com/other/repo',
    '![proof][other] and [repo][other]\n\n[other]: https://github.com/other/repo',
    '[![proof][img]][other]\n\n[img]: https://images.example.com/proof.png\n[other]: https://github.com/other/repo',
    '[nested [label]][other]\n\n[other]: https://github.com/other/repo',
    '[escaped\\[label\\]]\n\n[escaped\\[label\\]]: https://github.com/other/repo',
  ]) {
    assert.throws(() => parseGenericMarkdownToReports(document.replace('Something.', `Something.\n\n${reference}`)), /exactly one repository/u)
  }
})

test('HTML comments and unused definitions cannot supply or contradict repository evidence', () => {
  for (const hidden of ['<!-- https://github.com/other/repo -->', '<!--\nhttps://github.com/other/repo\n-->', '[unused]: https://github.com/other/repo']) {
    const text = document.replace('Something.', `Something.\n\n${hidden}`)
    assert.equal(parseGenericMarkdownToReports(text)[0].data.repo.github, 'a/a')
    const withoutEvidence = text.replaceAll(/https:\/\/github.com\/a\/[^\n]+/gu, '')
    assert.throws(() => parseGenericMarkdownToReports(withoutEvidence), /Product A.*found none/u)
  }
})

test('reference definitions resolve across finding partitions without attributing unused definitions', () => {
  const text = document.replace('https://github.com/a/a/blob/abcdef012345/c/d/e.js#L100-L110', '[code][a-ref]')
    + '\n\n[a-ref]: https://github.com/a/a/blob/abcdef012345/c/d/e.js#L100-L110'
  const reports = parseGenericMarkdownToReports(text)
  assert.deepEqual(reports.map(({ data }) => data.repo.github), ['a/a', 'a/b'])
  assert.equal(reports[0].data.findings[0].evidence[0].file, 'c/d/e.js')
})

for (const [label, prose] of [
  ['unclosed inline links', '[a]('.repeat(12_500)],
  ['nested unclosed links before a titled link', '[a]('.repeat(12_500) + 'https://github.com/a/a "repo")'],
  ['many valid inline links', '[code](https://github.com/a/a) '.repeat(6_000)],
  ['excess trailing parentheses', 'https://github.com/a/a' + ')'.repeat(50_000)],
  ['nested shortcut labels with an available reference', '['.repeat(32_000) + 'x' + ']'.repeat(32_000) + '\n\n[ref]: https://github.com/a/a'],
  ['nested explicit reference labels', '[label][' + '['.repeat(32_000) + 'x' + ']'.repeat(32_000) + ']\n\n[ref]: https://github.com/a/a'],
  ['deeply nested quoted prose', '> '.repeat(32_000) + 'https://github.com/a/a'],
  ['deeply nested quoted code', ['~~~sh', 'curl https://api.example.com', '~~~'].map(line => '> '.repeat(10_000) + line).join('\n')],
  ['alternating nested quotes and lists', '> - '.repeat(10_000) + '> https://github.com/a/a'],
]) {
  test(`repository inference stays bounded for ${label}`, () => {
    const text = document.replace('Something.', prose)
    const started = process.cpuUsage()
    assert.deepEqual(parseGenericMarkdownToReports(text).map(({ data }) => data.repo.github), ['a/a', 'a/b'])
    const { user, system } = process.cpuUsage(started)
    const took = (user + system) / 1000
    // CPU time avoids penalizing a busy CI host. The former suffix scan took
    // seconds even for 4,000 candidates; indexed collection needs one pass.
    assert.ok(took < 1000, `${text.length} characters took ${took.toFixed(0)}ms of CPU`)
  })
}
