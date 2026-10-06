import MarkdownIt from 'markdown-it'
import { H2_RE, H3_RE, isCommitHash, normalizeNewlines, splitLeading, unescapeMd, unfencedMatches } from './md-structure.js'

const SOURCE = 'markdown-generic'
const COLUMNS = ['#', 'id', 'product', 'priority', 'vulnerability']
const PRIORITIES = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low', P4: 'informational' }

const markdown = new MarkdownIt({ html: true, linkify: true })
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false })

function fail(message) { throw new Error(`Markdown (generic): ${message}`) }

function tokenize(text, env) {
  const tokens = markdown.parse(text, env)
  // The tokenizer stops at its nesting limit. Reject instead of importing a
  // partial token stream that could omit repository links after that point.
  if (tokens.some((token) => token.level >= markdown.options.maxNesting - 1)) fail('Markdown nesting limit exceeded')
  return tokens
}

// Escaped pipes belong to a cell, including product names and titles.
function cells(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map((cell) => cell.trim())
}

function summaryRows(text) {
  const lines = unfencedMatches(text, /^ {0,3}\|[^\n]*$/gmu)
  const start = lines.findIndex(([line]) => {
    const names = cells(line).map((cell) => unescapeMd(cell).toLowerCase())
    return names.length === COLUMNS.length && COLUMNS.every((name) => names.includes(name))
  })
  if (start === -1) return null
  const header = cells(lines[start][0]).map((cell) => unescapeMd(cell).toLowerCase())
  const separator = lines[start + 1]
  if (!separator || separator.index !== lines[start].index + lines[start][0].length + 1
    || cells(separator[0]).length !== header.length || !cells(separator[0]).every((cell) => /^:?-{3,}:?$/u.test(cell))) {
    fail('missing summary table separator')
  }
  const rows = []
  for (let i = start + 2; i < lines.length; i++) {
    if (lines[i].index !== lines[i - 1].index + lines[i - 1][0].length + 1) break
    const values = cells(lines[i][0])
    if (values.length !== header.length) fail('invalid summary table row')
    // Vulnerability is Markdown, while the other columns are structured values.
    // Decoding its escapes here could change a rendered link into an image.
    rows.push({ ...Object.fromEntries(header.map((key, j) => [key, key === 'vulnerability' ? values[j] : unescapeMd(values[j])])), raw: lines[i][0] })
  }
  if (!rows.length) fail('summary table has no findings')
  return rows
}

function indexRows(rows) {
  const byId = new Map(), prefixes = new Map(), products = new Map()
  for (const row of rows) {
    const prefix = /^(.+-)\d+$/u.exec(row.id)?.[1]
    if (!prefix) fail(`invalid finding ID "${row.id}"; expected a prefix followed by a number`)
    if (!row.product) fail(`finding ${row.id} has no product`)
    if (!Object.hasOwn(PRIORITIES, row.priority.toUpperCase())) fail(`unknown priority "${row.priority}" for ${row.id}`)
    if (byId.has(row.id)) fail(`duplicate summary ID ${row.id}`)
    if (products.has(row.product) && products.get(row.product) !== prefix) fail(`product "${row.product}" has multiple ID prefixes`)
    if (prefixes.has(prefix) && prefixes.get(prefix) !== row.product) fail(`ID prefix "${prefix}" is shared by products "${prefixes.get(prefix)}" and "${row.product}"`)
    products.set(row.product, prefix)
    prefixes.set(prefix, row.product)
    byId.set(row.id, row)
  }
  return byId
}

function repositoryUrls(tokens) {
  // Images, code, raw HTML and unused definitions have no link_open tokens.
  return [...new Set(tokens.flatMap((block) => (block.children ?? [])
    .filter((token) => token.type === 'link_open')
    .map((token) => token.attrGet('href'))))]
}

function repositoryLink(raw, product) {
  let url
  try { url = new URL(raw) } catch { fail(`product "${product}" has an invalid repository link: ${raw}`) }
  const parts = url.pathname.split('/').filter(Boolean)
  if (!['https:', 'http:'].includes(url.protocol) || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port
    || parts.length < 2 || !parts.slice(0, 2).every((part) => /^[\w.-]+$/u.test(part) && part !== '.' && part !== '..')) {
    fail(`product "${product}" has a link outside a GitHub repository: ${raw}`)
  }
  const repo = parts.slice(0, 2).join('/').replace(/\.git$/iu, '').toLowerCase()
  let evidence
  if (parts[2] === 'blob' && parts.length >= 5) {
    const anchor = /^#L(\d+)(?:-L?(\d+))?$/u.exec(url.hash)
    evidence = {
      file: decodeURIComponent(parts.slice(4).join('/')),
      line: anchor ? [anchor[1], anchor[2]].filter(Boolean).join('-') : '?',
      url: raw,
    }
  }
  return { repo, evidence, ref: parts[3] }
}

function findingFromBlock(row, body, rawSection, env) {
  const { subs } = splitLeading(body, H3_RE)
  const title = subs.find((section) => section.heading.trim().toLowerCase() === 'title')?.body.trim()
  if (!title) fail(`finding ${row.id} has no Title section`)
  const finding = {
    sourceId: row.id,
    // FROZEN identity contract: original row + complete raw partition, with
    // only normalized newlines and trimmed boundaries. Keep key order stable.
    // Severity mapping and presentation parsing must never enter this basis.
    _idBasis: { source: SOURCE, row: row.raw.trim(), section: rawSection.trim() },
    product: row.product, priority: row.priority.toUpperCase(),
    file: 'unknown', line: '?', severity: PRIORITIES[row.priority.toUpperCase()],
    description: title,
  }
  // Header semantics are separate from the current format guard: if other
  // summary headers are accepted later, Vulnerability still declares security
  // involvement regardless of the priority-to-severity mapping.
  if (Object.hasOwn(row, 'vulnerability')) finding.security = true
  const narrative = [title]
  for (const { heading, body: content } of subs) {
    const key = heading.trim().toLowerCase()
    if (key === 'title') continue
    if (/^steps to reproduce(?:\s|$)/u.test(key)) finding.reproduction = content.trim()
    else if (key === 'patch') finding.recommendation = content.trim()
    else narrative.push(key === 'description' ? content.trim() : `**${heading.trim()}:**\n${content.trim()}`)
  }
  finding.description = narrative.join('\n\n')
  // A table cell is inline Markdown and cannot open a block around the body.
  const links = repositoryUrls([...markdown.parseInline(row.vulnerability, env), ...tokenize(body, env)]).map((url) => repositoryLink(url, row.product))
  const evidence = links.flatMap((link) => link.evidence ? [link.evidence] : [])
  if (evidence.length) {
    const [first] = evidence
    finding.file = first.file
    finding.line = first.line
    finding.location = first.url
    finding.evidence = evidence
    const ref = links.find((link) => link.evidence)?.ref
    if (isCommitHash(ref)) finding.commitHash = ref
  }
  return { finding, repos: links.map((link) => link.repo) }
}

// The summary table owns product/priority; section numbers are presentation.
// Validate the entire document before returning any product to an importer.
export function parseGenericMarkdownToReports(content) {
  const text = normalizeNewlines(content).trim()
  const marks = unfencedMatches(text, H2_RE)
  // An h1-led Claude finding may have arbitrary tables and no sections at all.
  // Numbered sections disambiguate it; a bare table still diagnoses missing
  // generic finding bodies instead of silently accepting an incomplete import.
  if (!marks.some((mark) => /^\d+\.\s+\S+/u.test(mark[1])) && (marks.length || text.startsWith('# '))) return null
  const rows = summaryRows(text.slice(0, marks[0]?.index))
  if (rows === null) return null
  // Share document-level reference definitions across finding partitions.
  const env = {}
  tokenize(text, env)
  const byId = indexRows(rows), parsed = new Map(), seen = new Set()
  for (const [i, mark] of marks.entries()) {
    const heading = mark[1]
    const section = text.slice(mark.index, marks[i + 1]?.index)
    const body = section.slice(mark[0].length + 1)
    const id = /^\d+\.\s+(\S+)\s*$/u.exec(heading)?.[1]
    if (!id || !byId.has(id)) fail(`finding section "${heading}" is not in the summary table`)
    if (seen.has(id)) fail(`duplicate finding section ${id}`)
    seen.add(id)
    parsed.set(id, findingFromBlock(byId.get(id), body, section, env))
  }
  for (const id of byId.keys()) if (!seen.has(id)) fail(`missing finding section ${id}`)
  return [...Map.groupBy(rows, (row) => row.product)].map(([product, records]) => {
    const entries = records.map((row) => parsed.get(row.id))
    const repos = new Set(entries.flatMap((entry) => entry.repos))
    if (repos.size !== 1) fail(`product "${product}" must have exactly one repository; found ${repos.size ? [...repos].join(', ') : 'none'}`)
    const repo = { github: [...repos][0] }
    const findings = entries.map(({ finding }) => ({ ...finding, repo: { ...repo } }))
    return { displayName: product, data: { type: 'security', source: SOURCE, product, repo, findings } }
  })
}

export function parseGenericMarkdown(content) {
  const reports = parseGenericMarkdownToReports(content)
  if (reports === null) return null
  if (reports.length === 1) return reports[0].data
  return { type: 'security', source: SOURCE, findings: reports.flatMap(({ data }) => data.findings) }
}
