import { LIST_MARKER_RE, findMdLink, isCommitHash, normalizeNewlines, splitHeadingLine, splitLeading, splitUnfenced } from './md-structure.js'

const SOURCE = 'markdown-generic'
const HEADERS = ['#', 'id', 'product', 'priority', 'vulnerability']
const FIELDS = ['title', 'description', 'root cause', 'code references', 'attack scenario', 'steps to reproduce', 'impact', 'patch']
const FIELD_RE = /^(?:#{3,6}[ \t]+)?(?:\*\*)?(Title|Description|Root Cause|Code references|Attack Scenario|Steps to Reproduce(?:[ \t]+.*?)?|Impact|Patch):?(?:\*\*)?(?:[ \t]+#+)?[ \t]*$/gimu
const SEVERITY = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low', P4: 'informational' }
// The other layout: `# <title>` findings, concatenated, each with these
// sections and its repository named only by its Affected Code links.
const SECTION_RE = /^### +(Description|Affected Code|Fix|Tests)[ \t]*$/gimu
const SECTIONS = ['description', 'affected code', 'fix', 'tests']
const cells = (line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
function requireSupported(ok, detail) { if (!ok) throw new Error(`Markdown (generic): unsupported ${detail}`) }

function links(text) {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))].map((raw) => {
    requireSupported(/^https?:\/\/[^\s()[\]{}"'<>`\\]+$/iu.test(raw) && !/[.,;!?]$/u.test(raw), 'link syntax; use bare URLs on separate lines')
    return githubLink(raw)
  })
}

function githubLink(raw) {
  let url
  try { url = new URL(raw) } catch { requireSupported(false, 'URL') }
  const [owner, name, kind, ref, ...path] = url.pathname.slice(1).split('/')
  requireSupported(['github.com', 'www.github.com'].includes(url.hostname) && !url.username && !url.password && !url.port
    && [owner, name].every((part) => part && /^[\w-][\w.-]*$/u.test(part)), 'repository URL')
  requireSupported(path.every(Boolean), 'repository path; empty components')
  const repo = `${owner}/${name.replace(/\.git$/iu, '')}`.toLowerCase()
  const anchor = /^#L(\d+)(?:-L?(\d+))?$/u.exec(url.hash)
  const directory = repositoryPath(kind === 'blob' ? path.slice(0, -1) : kind === 'tree' ? path : [], 'repository directory')
  if (kind !== 'blob' || !path.length) return { repo, ref, directory }
  const file = [...directory, ...repositoryPath(path.slice(-1), 'repository file name')].join('/')
  return { repo, ref, directory, evidence: { file, line: anchor ? anchor.slice(1).filter(Boolean).join('-') : '?', url: raw } }
}

// Path components decoded once, as the repository names them; none may then
// hold a separator, a drive or stream colon, a query, a fragment or a control.
function repositoryPath(parts, what) {
  try { parts = parts.map(decodeURIComponent) } catch { requireSupported(false, `${what} encoding`) }
  requireSupported(parts.every((part) => part === part.trim() && !/[\\/:?#\p{Cc}]/u.test(part)), what)
  return parts
}

function assignReferences(row, finding, text, repoPrefixes) {
  const refs = links(text)
  const github = assignEvidence(finding, refs, `finding ${row.id}`)
  requireSupported(!row.group.github || row.group.github === github, `repository set for product ${row.product}; expected exactly one repository`)
  const prefix = repoPrefixes.get(github)
  requireSupported(prefix === undefined || prefix === row.prefix, `repository ID prefixes for ${github}; expected ${prefix}, got ${row.prefix} (${row.id})`)
  repoPrefixes.set(github, row.prefix)
  row.group.github = github
  row.group.directories.push(...refs.map((link) => link.directory))
}

// The references' one repository, returned, and their evidence on the finding.
function assignEvidence(finding, refs, subject) {
  const github = refs[0]?.repo
  requireSupported(github && refs.every((link) => link.repo === github), `repository set for ${subject}; expected exactly one repository`)
  const evidence = refs.flatMap((link) => link.evidence ?? [])
  if (evidence.length) {
    Object.assign(finding, { file: evidence[0].file, line: evidence[0].line, location: evidence[0].url, evidence })
    // A reference's commit is where the code was read, not where the bug landed;
    // stamped, in lowercase and at its longest spelling, only when every evidence
    // row was read at that one commit: all links name one repository, so a hash
    // the longest one starts with names the same commit.
    const commits = refs.filter((link) => link.evidence).map((link) => link.ref.toLowerCase())
    const longest = commits.reduce((a, b) => (b.length > a.length ? b : a))
    if (commits.every((ref) => isCommitHash(ref) && longest.startsWith(ref))) finding.auditedCommit = longest
  }
  return github
}

function commonDirectory(directories) {
  let common = directories[0]
  for (const directory of directories.slice(1)) {
    let length = 0
    while (length < common.length && common[length] === directory[length]) length++
    common = common.slice(0, length)
  }
  return common.join('/')
}

// Findings keep repository-root paths; the common directory describes the listing.
function report(displayName, github, directories, findings, extra) {
  const repo = { github, directory: commonDirectory(directories) }
  return { displayName, data: { type: 'security', source: SOURCE, ...extra, repo, findings: findings.map((f) => ({ ...f, repo: { github } })) } }
}

// `- [label](GitHub file link) - explanation`, one item per affected site;
// indented lines continue an item's explanation.
function affectedCode(text, title) {
  const unlisted = `Affected Code for "${title}"; expected a list of links`
  const items = []
  for (const line of text.split('\n')) {
    const marker = LIST_MARKER_RE.exec(line)
    if (marker && !marker[1]) items.push([line.slice(marker[0].length)])
    else if (line.trim()) {
      requireSupported(items.length && /^[ \t]/u.test(line), unlisted)
      items.at(-1).push(line.trim())
    }
  }
  requireSupported(items.length, unlisted)
  return items.map(([item, ...more]) => {
    const link = findMdLink(item)
    requireSupported(link?.index === 0 && /^https?:\/\/\S+$/iu.test(link.url), `Affected Code item for "${title}"; expected [file](link) first`)
    const ref = githubLink(link.url)
    requireSupported(ref.evidence, `Affected Code link for "${title}"; expected a link to a file`)
    const note = [item.slice(link.end).replace(/^[ \t]*(?:[-\u2013\u2014:][ \t]*)?/u, ''), ...more].join('\n').trim()
    if (note) ref.evidence.text = note
    return ref
  })
}

function parseSectionedReports(blocks) {
  const repos = new Map(), sections = new Set()
  for (const { block, title, head, subs } of blocks) {
    requireSupported(title, 'finding without a title')
    requireSupported(!head.trim(), `text before section headers for "${title}"`)
    const fields = new Map()
    for (const sub of subs) {
      const key = sub.heading.toLowerCase()
      requireSupported(!fields.has(key), `duplicate section ${sub.heading} for "${title}"`)
      fields.set(key, sub.body.trim())
    }
    requireSupported(SECTIONS.every((key) => fields.has(key)), `missing required headers for "${title}"`)
    // FROZEN: the complete raw finding; never parsed display fields.
    const section = `# ${block}`.trim()
    requireSupported(!sections.has(section), `duplicate finding "${title}"`)
    sections.add(section)
    const [description, affected, fix, tests] = SECTIONS.map((key) => fields.get(key))
    const refs = affectedCode(affected, title)
    // The format names no severity; the description's calibration is prose.
    const finding = { _idBasis: { source: SOURCE, section }, severity: 'medium', security: true,
      description: [title, description, tests && `**Tests:**\n${tests}`].filter(Boolean).join('\n\n') }
    if (fix) finding.recommendation = fix
    const github = assignEvidence(finding, refs, `"${title}"`)
    const group = repos.get(github) ?? { directories: [], findings: [] }
    group.directories.push(...refs.map((link) => link.directory))
    group.findings.push(finding)
    repos.set(github, group)
  }
  return [...repos].map(([github, { directories, findings }]) => report(github, github, directories, findings))
}

export function parseGenericMarkdownToReports(content) {
  const text = normalizeNewlines(content).trim()
  // Split only where the heading is in the text at all, and fence-aware: a
  // `# comment` in a snippet is the snippet's.
  if (text.startsWith('# ') && /^### +Affected Code[ \t]*$/imu.test(text)) {
    const blocks = splitUnfenced(text, /^# /gmu).slice(1).map((block) => {
      const { title, body } = splitHeadingLine(block)
      return { block, title, ...splitLeading(body, SECTION_RE) }
    })
    if (blocks.some(({ subs }) => subs.some(({ heading }) => heading.toLowerCase() === 'affected code'))) return parseSectionedReports(blocks)
  }
  const marks = [...text.matchAll(/^## +(.*)$/gmu)]
  if (!marks.some((mark) => /^\d+\.\s+\S+/u.test(mark[1])) && (marks.length || text.startsWith('# '))) return null
  const header = [...text.matchAll(/^\|[^\n]*\|$/gmu)].find(([line]) => cells(line).map((cell) => cell.toLowerCase()).join() === HEADERS.join())
  if (!header) return null
  const preamble = text.slice(0, header.index).trim()
  requireSupported(!preamble || /^# [^\n]+$/u.test(preamble), 'summary preamble')
  requireSupported(header.index < (marks[0]?.index ?? text.length), 'summary position')
  const table = text.slice(header.index, marks[0]?.index).trim().split('\n')
  const headers = new Set(cells(table[0]).map((cell) => cell.toLowerCase()))
  requireSupported(table[1] && cells(table[1]).length === 5 && cells(table[1]).every((cell) => /^:?-{3,}:?$/u.test(cell)), 'summary separator')
  const products = new Map(), repoPrefixes = new Map(), rows = new Map()
  for (const raw of table.slice(2).filter((line) => line.trim())) {
    requireSupported(/^\|.*\|$/u.test(raw) && cells(raw).length === 5, 'summary row')
    const [number, id, product, priority] = cells(raw); const prefix = /^(.+-)\d+$/u.exec(id)?.[1]
    requireSupported(/^\d+$/u.test(number) && prefix && product && Object.hasOwn(SEVERITY, priority) && !rows.has(id), `summary values for ${id}`)
    const group = products.get(product) ?? { directories: [], rows: [] }
    const row = { raw, id, prefix, product, priority, group }
    rows.set(id, row); group.rows.push(row); products.set(product, group)
  }
  requireSupported(rows.size, 'empty summary')
  for (const [i, mark] of marks.entries()) {
    const id = /^\d+\.\s+(\S+)\s*$/u.exec(mark[1])?.[1], row = rows.get(id)
    requireSupported(row && !row.finding, `finding section ${mark[1]}`)
    const raw = text.slice(mark.index, marks[i + 1]?.index); const body = raw.slice(mark[0].length + 1)
    // Only the report's known headers delimit fields; body Markdown is opaque.
    const fields = new Map(), parts = [...body.matchAll(FIELD_RE)]
    for (const [j, part] of parts.entries()) {
      const heading = part[1], key = heading.toLowerCase().replace(/^steps to reproduce\b.*$/u, 'steps to reproduce')
      requireSupported(!fields.has(key), `duplicate section ${heading}`)
      fields.set(key, { heading, body: body.slice(part.index + part[0].length, parts[j + 1]?.index).trim() })
    }
    requireSupported(FIELDS.every((key) => fields.has(key)), `missing required headers for ${id}`)
    requireSupported(!body.slice(0, parts[0].index).trim(), `text before field headers for ${id}`)
    const title = fields.get('title')?.body
    requireSupported(title, `missing Title for ${id}`)
    // FROZEN: original row + complete raw partition; never parsed display fields.
    const finding = { sourceId: id, _idBasis: { source: SOURCE, row: row.raw.trim(), section: raw.trim() }, product: row.product, priority: row.priority, severity: SEVERITY[row.priority], file: 'unknown', line: '?' }
    // Keep the header's security meaning separate from the current format guard.
    if (headers.has('vulnerability')) finding.security = true
    const narrative = [title]
    for (const [key, field] of fields) {
      // Code references are bare URLs only, carried as the evidence rows.
      if (key === 'title' || key === 'code references') continue
      if (key === 'steps to reproduce') finding.reproduction = field.body
      else if (key === 'patch') finding.recommendation = field.body
      else narrative.push(key === 'description' ? field.body : `**${field.heading}:**\n${field.body}`)
    }
    finding.description = narrative.join('\n\n')
    assignReferences(row, finding, fields.get('code references').body, repoPrefixes)
    row.finding = finding
  }
  requireSupported([...rows.values()].every((row) => row.finding), 'missing finding sections')
  return [...products].map(([product, group]) => report(product, group.github, group.directories, group.rows.map((row) => row.finding), { product }))
}

export function parseGenericMarkdown(content) {
  const reports = parseGenericMarkdownToReports(content)
  return reports === null ? null : reports.length === 1 ? reports[0].data : { type: 'security', source: SOURCE, findings: reports.flatMap(({ data }) => data.findings) }
}
