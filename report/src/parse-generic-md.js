import { inFence, isCommitHash, normalizeNewlines, readFences } from './md-structure.js'

const SOURCE = 'markdown-generic'
const HEADERS = ['#', 'id', 'product', 'priority', 'vulnerability']
const SEVERITY = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low', P4: 'informational' }
const cells = (line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
function requireSupported(ok, detail) { if (!ok) throw new Error(`Markdown (generic): unsupported ${detail}`) }

function links(text) {
  const prose = text.replace(/`[^`\n]*`/gu, '')
  return [...new Set(prose.split('\n').filter((line) => !/^(?: {4}|\t)/u.test(line) && /https?:\/\//iu.test(line)).map((line) => line.trim()))].map((raw) => {
    requireSupported(/^https?:\/\/[^\s()[\]{}"'<>`\\]+$/iu.test(raw) && !/[.,;!?]$/u.test(raw), 'link syntax; use bare URLs on separate lines')
    let url
    try { url = new URL(raw) } catch { requireSupported(false, 'URL') }
    const [owner, name, kind, ref, ...path] = url.pathname.slice(1).split('/')
    requireSupported(['github.com', 'www.github.com'].includes(url.hostname) && !url.username && !url.password && !url.port
      && [owner, name].every((part) => part && /^[\w-][\w.-]*$/u.test(part)), 'repository URL')
    const repo = `${owner}/${name.replace(/\.git$/iu, '')}`.toLowerCase()
    const anchor = /^#L(\d+)(?:-L?(\d+))?$/u.exec(url.hash)
    return { repo, ref, ...(kind === 'blob' && path.length && { evidence: { file: path.join('/'), line: anchor ? anchor.slice(1).filter(Boolean).join('-') : '?', url: raw } }) }
  })
}

export function parseGenericMarkdownToReports(content) {
  const text = normalizeNewlines(content).trim()
  const { ranges, closer } = readFences(text, true)
  let end = 0
  // Mask blocks only for structure/link discovery; every stored field stays raw.
  const visible = ranges.map(([start, stop]) => {
    const part = text.slice(end, start) + ' '.repeat(stop - start); end = stop; return part
  }).join('') + text.slice(end)
  const marks = [...visible.matchAll(/^## +(.*)$/gmu)]
  if (!marks.some((mark) => /^\d+\.\s+\S+/u.test(mark[1])) && (marks.length || text.startsWith('# '))) return null
  const header = [...text.matchAll(/^\|[^\n]*\|$/gmu)].find(([line]) => cells(line).map((cell) => cell.toLowerCase()).join() === HEADERS.join())
  if (!header) return null
  requireSupported(!inFence(ranges, header.index) && closer === null, 'summary or section boundary')
  // The summary is structured; section bodies are free-form Markdown.
  requireSupported(!/[\\`<>]|~{3}|!\[|\]\s*[([]|^\s*\[[^\n]+\]:|&(?:#\w+|\w+);|^ {4}|\t|^ +#/mu.test(text.slice(0, marks[0]?.index)), 'summary Markdown syntax')
  requireSupported(header.index < (marks[0]?.index ?? text.length), 'summary position')
  const table = text.slice(header.index, marks[0]?.index).trim().split('\n')
  const headers = new Set(cells(table[0]).map((cell) => cell.toLowerCase()))
  requireSupported(table[1] && cells(table[1]).length === 5 && cells(table[1]).every((cell) => /^:?-{3,}:?$/u.test(cell)), 'summary separator')
  const prefixes = new Map(), products = new Map(), rows = new Map()
  for (const raw of table.slice(2).filter((line) => line.trim())) {
    requireSupported(/^\|.*\|$/u.test(raw) && cells(raw).length === 5, 'summary row')
    const [, id, product, priority, vulnerability] = cells(raw); const prefix = /^(.+-)\d+$/u.exec(id)?.[1]
    requireSupported(prefix && product && Object.hasOwn(SEVERITY, priority) && !rows.has(id), `summary values for ${id}`)
    const group = products.get(product) ?? { prefix, repos: new Set(), rows: [] }
    requireSupported(group.prefix === prefix && (!prefixes.has(prefix) || prefixes.get(prefix) === product), 'product ID prefixes')
    const row = { raw, id, product, priority, vulnerability, group }
    rows.set(id, row); group.rows.push(row); products.set(product, group); prefixes.set(prefix, product)
  }
  requireSupported(rows.size, 'empty summary')
  for (const [i, mark] of marks.entries()) {
    const id = /^\d+\.\s+(\S+)\s*$/u.exec(mark[1])?.[1], row = rows.get(id)
    requireSupported(row && !row.finding, `finding section ${mark[1]}`)
    const raw = text.slice(mark.index, marks[i + 1]?.index); const body = raw.slice(mark[0].length + 1)
    const visibleBody = visible.slice(mark.index + mark[0].length + 1, marks[i + 1]?.index)
    const fields = new Map(), parts = [...visibleBody.matchAll(/^### +(.*)$/gmu)]
    for (const [j, part] of parts.entries()) {
      const heading = part[1].replace(/ +#+$/u, '').trim(), key = heading.toLowerCase()
      requireSupported(!fields.has(key), `duplicate section ${heading}`)
      fields.set(key, { heading, body: body.slice(part.index + part[0].length, parts[j + 1]?.index).trim() })
    }
    const title = fields.get('title')?.body
    requireSupported(title, `missing Title for ${id}`)
    // FROZEN: original row + complete raw partition; never parsed display fields.
    const finding = { sourceId: id, _idBasis: { source: SOURCE, row: row.raw.trim(), section: raw.trim() }, product: row.product, priority: row.priority, severity: SEVERITY[row.priority], file: 'unknown', line: '?' }
    // Keep the header's security meaning separate from the current format guard.
    if (headers.has('vulnerability')) finding.security = true
    const narrative = [title]
    for (const [key, field] of fields) {
      if (key === 'title') continue
      if (/^steps to reproduce(?:\s|$)/u.test(key)) finding.reproduction = field.body
      else if (key === 'patch') finding.recommendation = field.body
      else narrative.push(key === 'description' ? field.body : `**${field.heading}:**\n${field.body}`)
    }
    finding.description = narrative.join('\n\n')
    const refs = links(`${row.vulnerability}\n${visibleBody}`); const evidence = refs.flatMap((link) => link.evidence ?? [])
    for (const link of refs) row.group.repos.add(link.repo)
    if (evidence.length) {
      Object.assign(finding, { file: evidence[0].file, line: evidence[0].line, location: evidence[0].url, evidence })
      const ref = refs.find((link) => link.evidence).ref
      if (isCommitHash(ref)) finding.commitHash = ref
    }
    row.finding = finding
  }
  requireSupported([...rows.values()].every((row) => row.finding), 'missing finding sections')
  return [...products].map(([product, group]) => {
    requireSupported(group.repos.size === 1, `repository set for ${product}; expected exactly one repository`)
    const repo = { github: [...group.repos][0] }; const findings = group.rows.map((row) => ({ ...row.finding, repo: { ...repo } }))
    return { displayName: product, data: { type: 'security', source: SOURCE, product, repo, findings } }
  })
}

export function parseGenericMarkdown(content) {
  const reports = parseGenericMarkdownToReports(content)
  return reports === null ? null : reports.length === 1 ? reports[0].data : { type: 'security', source: SOURCE, findings: reports.flatMap(({ data }) => data.findings) }
}
