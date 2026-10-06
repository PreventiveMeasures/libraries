import { createMdLinkReader, findMdLink, unescapeMd } from './md-structure.js'
import { withoutMarkdownCodeBlocks } from './md-prose.js'

// Code examples are not report links. Pair inline backtick runs by length,
// including multiline spans, without treating unmatched backticks as code.
function withoutCode(text) {
  text = withoutMarkdownCodeBlocks(text)
  const runs = [...text.matchAll(/`+/gu)]
  const closes = new Map(), next = new Map()
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length
    if (next.has(length)) closes.set(i, next.get(length))
    next.set(length, i)
  }
  const parts = []
  let from = 0
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

function referenceText(text) {
  const refs = new Map()
  text = withoutCode(text).replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
  // Definitions are not rendered links. Only ordinary references to them
  // contribute evidence; images and unused definitions do not.
  text = text.replace(/^ {0,3}\[((?:\\.|[^\]\\\n[])+)\]:[ \t]*(?:\n[ \t]*)?([^\n]+)(?:\n[ \t]+((?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))))?$/gmu, (raw, label, destination, title) => {
    const link = findMdLink(`[ref](${destination}${title ? ` ${title}` : ''})`, { allowTitle: true })
    if (!link) return raw
    const key = referenceKey(label)
    if (!refs.has(key)) refs.set(key, link.url)
    return ''
  })
  return { refs, text }
}

// Markdown definitions have document scope, even across finding partitions.
export function genericMarkdownReferences(text) { return referenceText(text).refs }

// Preserve Markdown link destinations with parentheses in their paths. Bare
// URLs and autolinks are accepted too; trailing prose punctuation is not a URL.
export function genericMarkdownUrls(content, references) {
  const { refs, text } = referenceText(content)
  const urls = []
  const { ends, nested } = bracketEnds(text)
  const plain = []
  const readLink = createMdLinkReader(text)
  const lookup = references ?? refs
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const close = ends.get(i)
    if (close === undefined) continue
    let end, link
    if (text[close + 1] === '(') {
      link = readLink(close)
      if (!link) continue
      end = link.end
    } else {
      if (!lookup.size) continue
      const refStart = close + 1
      const refEnd = ends.get(refStart)
      const explicit = refEnd !== undefined && refEnd > refStart + 1
      // Reference labels cannot contain unescaped brackets. Reject them from
      // indexed structure, before slicing or normalizing overlapping labels.
      if (nested.has(explicit ? refStart : i)) continue
      const label = explicit ? text.slice(refStart + 1, refEnd) : text.slice(i + 1, close)
      const url = lookup.get(referenceKey(label))
      if (!url) continue
      link = { url }
      end = refEnd === undefined ? close + 1 : refEnd + 1
    }
    if (text[i - 1] !== '!' || escaped(text, i - 1)) urls.push(link.url)
    plain.push(text.slice(from, i))
    from = end
    i = end - 1
  }
  plain.push(text.slice(from))
  for (const [raw] of plain.join('\n').matchAll(/https?:\/\/[^\s<>"`]+/giu)) {
    let url = raw.replace(/[.,;:!?]+$/u, '')
    // A closing Markdown parenthesis is not part of a bare URL unless balanced.
    let balance = 0, end = url.length
    for (const c of url) balance += c === '(' ? 1 : c === ')' ? -1 : 0
    while (balance < 0 && url[end - 1] === ')') { end--; balance++ }
    url = url.slice(0, end)
    urls.push(url)
  }
  return [...new Set(urls)]
}

function referenceKey(label) { return unescapeMd(label).trim().replace(/\s+/gu, ' ').toLowerCase() }

function escaped(text, index) {
  let count = 0
  for (let i = index - 1; text[i] === '\\'; i--) count++
  return count % 2 === 1
}

function bracketEnds(text) {
  const ends = new Map(), nested = new Set(), stack = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '[') stack.push(i)
    else if (text[i] === ']' && stack.length) {
      ends.set(stack.pop(), i)
      if (stack.length) nested.add(stack.at(-1))
    }
  }
  return { ends, nested }
}
