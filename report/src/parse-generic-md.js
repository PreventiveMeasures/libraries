import { genericMarkdownIdBasis } from './parse-generic-md-id.js'
import { H2_RE, H3_RE, fenceRanges, findMdLink, isCommitHash, normalizeNewlines, splitLeading, unescapeMd, unfencedMatches } from './md-structure.js'

const SOURCE = 'markdown-generic'
const COLUMNS = ['#', 'id', 'product', 'priority', 'vulnerability']
const PRIORITIES = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low', P4: 'informational' }

function fail(message) { throw new Error(`Markdown (generic): ${message}`) }

// Escaped pipes belong to a cell, including product names and titles.
function cells(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map((cell) => unescapeMd(cell.trim()))
}

function summaryRows(text) {
  const lines = unfencedMatches(text, /^ {0,3}\|[^\n]*$/gmu)
  const start = lines.findIndex(([line]) => {
    const names = cells(line).map((cell) => cell.toLowerCase())
    return names.length === COLUMNS.length && COLUMNS.every((name) => names.includes(name))
  })
  if (start === -1) return null
  const header = cells(lines[start][0]).map((cell) => cell.toLowerCase())
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
    rows.push({ ...Object.fromEntries(header.map((key, j) => [key, values[j]])), raw: lines[i][0] })
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

// Code examples are not report links. Pair inline backtick runs by length,
// including multiline spans, without treating unmatched backticks as code.
function withoutCode(text) {
  const prose = []
  let from = 0
  for (const [start, end] of fenceRanges(text)) {
    prose.push(text.slice(from, start))
    from = end
  }
  prose.push(text.slice(from))
  text = prose.join('\n')
  const runs = [...text.matchAll(/`+/gu)]
  const closes = new Map(), next = new Map()
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length
    if (next.has(length)) closes.set(i, next.get(length))
    next.set(length, i)
  }
  const parts = []
  from = 0
  for (let i = 0; i < runs.length; i++) {
    if (!closes.has(i)) continue
    // Escaped backticks cannot open a span (backslashes within a span are literal).
    let slashes = 0
    for (let j = runs[i].index - 1; text[j] === '\\'; j--) slashes++
    if (slashes % 2) continue
    parts.push(text.slice(from, runs[i].index))
    i = closes.get(i)
    from = runs[i].index + runs[i][0].length
  }
  parts.push(text.slice(from))
  return parts.join(' ')
}

// Preserve Markdown link destinations with parentheses in their paths. Bare
// URLs and autolinks are accepted too; trailing prose punctuation is not a URL.
function urlsIn(text) {
  const urls = []
  for (let line of withoutCode(text).split('\n')) {
    const plain = []
    let link
    while ((link = findMdLink(line))) {
      urls.push(link.url)
      plain.push(line.slice(0, link.index))
      const end = line.indexOf(link.url, link.index + link.label.length + 3) + link.url.length
      line = line.slice(end)
    }
    plain.push(line)
    for (const [raw] of plain.join('\n').matchAll(/https?:\/\/[^\s<>"`]+/giu)) {
      let url = raw.replace(/[.,;:!?]+$/u, '')
      // A closing Markdown parenthesis is not part of a bare URL unless balanced.
      while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1)
      urls.push(url)
    }
  }
  return [...new Set(urls)]
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

function findingFromBlock(row, body, rawSection) {
  const { subs } = splitLeading(body, H3_RE)
  const title = subs.find((section) => section.heading.trim().toLowerCase() === 'title')?.body.trim()
  if (!title) fail(`finding ${row.id} has no Title section`)
  const finding = {
    sourceId: row.id, _idBasis: genericMarkdownIdBasis(row.raw, rawSection), product: row.product, priority: row.priority.toUpperCase(),
    file: 'unknown', line: '?', severity: PRIORITIES[row.priority.toUpperCase()],
    description: title,
  }
  const narrative = [title]
  for (const { heading, body: content } of subs) {
    const key = heading.trim().toLowerCase()
    if (key === 'title') continue
    if (/^steps to reproduce(?:\s|$)/u.test(key)) finding.reproduction = content.trim()
    else if (key === 'patch') finding.recommendation = content.trim()
    else narrative.push(key === 'description' ? content.trim() : `**${heading.trim()}:**\n${content.trim()}`)
  }
  finding.description = narrative.join('\n\n')
  const links = urlsIn(`${row.vulnerability}\n${body}`).map((url) => repositoryLink(url, row.product))
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
  const rows = summaryRows(text.slice(0, marks[0]?.index))
  if (rows === null) return null
  const byId = indexRows(rows), parsed = new Map(), seen = new Set()
  for (const [i, mark] of marks.entries()) {
    const heading = mark[1]
    const section = text.slice(mark.index, marks[i + 1]?.index)
    const body = section.slice(mark[0].length + 1)
    const id = /^\d+\.\s+(\S+)\s*$/u.exec(heading)?.[1]
    if (!id || !byId.has(id)) fail(`finding section "${heading}" is not in the summary table`)
    if (seen.has(id)) fail(`duplicate finding section ${id}`)
    seen.add(id)
    parsed.set(id, findingFromBlock(byId.get(id), body, section))
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
