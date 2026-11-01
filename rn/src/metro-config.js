// A metro.config.js, read off its ESTree AST, never run (its getDefaultConfig
// needs Metro).

import { literalString, readLists } from './config-lists.js'

const ASSET_LISTS = new Map([['assetExts', 'asset']])

// The extensions the config lists among `resolver.assetExts`, besides
// Metro's defaults it spreads in: `assetExts: [...defaults, 'riv']`,
// `config.resolver.assetExts.push('riv')`. One it filters out is still listed.
export function metroAssetExts(program) {
  const exts = new Set()
  readLists(program, ASSET_LISTS, (_, node) => {
    const ext = literalString(node)
    if (ext !== null) exts.add(ext)
  })
  return [...exts]
}

// With no parser: the same extensions as metroAssetExts finds in the usual
// forms, from the source's tokens. An array assigned to `assetExts` (`:` or
// `=`), or the arguments of its `push`, `unshift` or `concat`, give their
// strings, and those of the arrays among them; what is in nested calls,
// spreads of variables and branches is not followed.
export function scanMetroAssetExts(source) {
  const all = [...tokens(source)]
  const exts = new Set()
  const take = (open) => {
    for (let at = open + 1, depth = 1; at < all.length && depth > 0; at++) {
      const { kind, value } = all[at]
      if (kind === 'punct' && '([{'.includes(value)) depth++
      else if (kind === 'punct' && ')]}'.includes(value)) depth--
      // An argument's own array is a list too: `concat(['riv'])`.
      else if (kind === 'string' && (depth === 1 || (depth === 2 && all[open].value === '(' && enclosing(all, at) === '['))) exts.add(value)
    }
  }
  all.forEach(({ kind, value }, at) => {
    if (kind !== 'word' || value !== 'assetExts') return
    const [next, then, open] = [all[at + 1], all[at + 2], all[at + 3]]
    if (next?.kind === 'punct' && (next.value === ':' || next.value === '=') && then?.value === '[') take(at + 2)
    if (next?.kind === 'punct' && (next.value === '.' || next.value === '?.') && ['push', 'unshift', 'concat'].includes(then?.value) && open?.value === '(') take(at + 3)
  })
  return [...exts]
}

// The bracket `at` is directly inside.
function enclosing(all, at) {
  for (let depth = 0, i = at - 1; i >= 0; i--) {
    const { kind, value } = all[i]
    if (kind !== 'punct') continue
    if (')]}'.includes(value)) depth++
    else if ('([{'.includes(value)) {
      if (depth === 0) return value
      depth--
    }
  }
  return null
}

const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>']
// What a `/` after starts a regular expression rather than divides.
const BEFORE_REGEXP = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await'])
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }

// JS source's tokens: strings (a template with no substitutions one too),
// words and punctuators; comments, regular expressions and templates with
// substitutions passed over.
function* tokens(source) {
  let previous = null
  for (let at = 0; at < source.length;) {
    const char = source[at]
    if (/\s/u.test(char)) {
      at++
    } else if (source.startsWith('//', at)) {
      at = source.includes('\n', at) ? source.indexOf('\n', at) : source.length
    } else if (source.startsWith('/*', at)) {
      at = source.includes('*/', at + 2) ? source.indexOf('*/', at + 2) + 2 : source.length
    } else if (char === '"' || char === "'" || char === '`') {
      const { end, value } = quoted(source, at)
      at = end
      previous = { kind: value === null ? 'template' : 'string', value }
      if (value !== null) yield previous
    } else if (char === '/' && (previous === null || (previous.kind === 'punct' && !')]}'.includes(previous.value)) || (previous.kind === 'word' && BEFORE_REGEXP.has(previous.value)))) {
      at = regExpEnd(source, at)
      previous = { kind: 'regexp' }
    } else if (/[\w$]/u.test(char)) {
      const [word] = /^[\w$]+/u.exec(source.slice(at))
      at += word.length
      yield (previous = { kind: 'word', value: word })
    } else {
      const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, at)) ?? char
      at += punct.length
      yield (previous = { kind: 'punct', value: punct })
    }
  }
}

// A string or template starting at `at`: its end, and its value, null for a
// template with substitutions.
function quoted(source, at) {
  const quote = source[at]
  let value = ''
  for (let i = at + 1; i < source.length; i++) {
    const char = source[i]
    if (char === quote) return { end: i + 1, value }
    if (char === '\\') {
      if (value !== null) value += ESCAPES[source[i + 1]] ?? source[i + 1]
      i++
    } else if (quote === '`' && source.startsWith('${', i)) {
      i = substitutionEnd(source, i + 2) - 1
      value = null
    } else if (value !== null) {
      value += char
    }
  }
  return { end: source.length, value }
}

// The end of a template's substitution whose expression starts at `at`, past its `}`.
function substitutionEnd(source, at) {
  for (let depth = 1, i = at; i < source.length; i++) {
    const char = source[i]
    if (char === '"' || char === "'" || char === '`') i = quoted(source, i).end - 1
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i + 1
  }
  return source.length
}

// The end of the regular expression starting at `at`, its flags included.
function regExpEnd(source, at) {
  let inClass = false
  for (let i = at + 1; i < source.length; i++) {
    const char = source[i]
    if (char === '\\') i++
    else if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) return i + 1 + /^[a-z]*/u.exec(source.slice(i + 1))[0].length
    else if (char === '\n') return i
  }
  return source.length
}
