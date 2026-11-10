// The words of a podspec in the strict form pod reads, podspec-read.js's: names, literals and punctuation. A
// podspec is Ruby, and anything of Ruby that is not one of these is refused, with its line.

import { PodError } from './error.js'

const ESCAPES = { n: '\n', t: '\t', r: '\r', s: ' ', e: '\u001B', 0: '\0', a: '\u0007', b: '\b', f: '\f', v: '\v' }
const CLOSERS = { '(': ')', '[': ']', '{': '}', '<': '>' }
const PUNCTUATION = ['=>', '::', '=', ',', '.', '(', ')', '[', ']', '{', '}', '|', '+', ';', ':']

function fail(t, what) {
  throw new PodError(`line ${t.line}: ${what}, which is not in the form of a podspec that is read without Ruby`, t.where)
}
const push = (t, type, value, extra) => t.tokens.push({ type, value, line: t.line, ...extra })
const lineEnd = (t) => (t.source.indexOf('\n', t.at) === -1 ? t.source.length : t.source.indexOf('\n', t.at))

// Where the `}` of an interpolation that starts at `from` is: past the strings and the braces in it, on its
// line; -1 where there is none.
function closing(source, from) {
  let depth = 0
  for (let at = from; at < source.length && source[at] !== '\n'; at++) {
    const char = source[at]
    if (char === '"' || char === "'") {
      at = source.indexOf(char, at + 1)
      if (at === -1) return -1
    } else if (char === '{') depth++
    else if (char === '}' && depth-- === 0) return at
  }
  return -1
}

// A double-quoted string's body, to `close`: its escapes taken, each `#{...}` kept as `{ code }`, to be read.
function interpolated(t, close) {
  const parts = ['']
  const { source } = t
  for (; source[t.at] !== close; t.at++) {
    if (t.at >= source.length) fail(t, 'a string that does not end')
    if (source[t.at] === '\n') t.line++
    if (source[t.at] === '\\') {
      const next = source[++t.at]
      if (/[uxcMC1-9]/u.test(next)) fail(t, `the escape \`\\${next}\``)
      parts[parts.length - 1] += ESCAPES[next] ?? next
    } else if (source[t.at] === '#' && source[t.at + 1] === '{') {
      const end = closing(source, t.at + 2)
      if (end === -1) fail(t, 'an interpolation that does not end, or of more than a line')
      parts.push({ code: source.slice(t.at + 2, end), line: t.line }, '')
      t.at = end
    } else if (source[t.at] === '#' && /[$@]/u.test(source[t.at + 1] ?? '')) fail(t, 'an interpolation of a variable')
    else parts[parts.length - 1] += source[t.at]
  }
  t.at++
  return parts.filter((part) => part !== '')
}

// A single-quoted string's body: as it is, but for `\'` and `\\`.
function single(t) {
  let text = ''
  const { source } = t
  for (; source[t.at] !== "'"; t.at++) {
    if (t.at >= source.length) fail(t, 'a string that does not end')
    if (source[t.at] === '\n') t.line++
    if (source[t.at] === '\\' && (source[t.at + 1] === "'" || source[t.at + 1] === '\\')) t.at++
    text += source[t.at]
  }
  t.at++
  return text === '' ? [] : [text]
}

// The bodies of the heredocs a line opened, each to the line of its name, a `<<~` one less its indentation.
function heredocs(t) {
  for (const { token, name, squiggly, raw } of t.pending.splice(0)) {
    const lines = []
    for (;;) {
      if (t.at >= t.source.length) fail(t, `a heredoc without its \`${name}\``)
      const end = lineEnd(t)
      const text = t.source.slice(t.at, end)
      t.at = Math.min(end + 1, t.source.length)
      t.line++
      if (text.trim() === name) break
      lines.push(text)
    }
    const indent = squiggly ? Math.min(...lines.filter((one) => one.trim() !== '').map((one) => /^[ \t]*/u.exec(one)[0].length)) : 0
    const body = lines.map((one) => `${one.slice(Number.isFinite(indent) ? indent : 0)}\n`).join('')
    if (!raw && /\\|#[{$@]/u.test(body)) fail(t, 'a heredoc with an escape or an interpolation')
    token.parts = body === '' ? [] : [body]
  }
}

// `%w(...)`: its words.
function words(t, match) {
  if (match[1] !== 'w') fail(t, `a \`%${match[1]}\` literal`)
  const end = t.source.indexOf(CLOSERS[match[2]], t.at)
  if (end === -1) fail(t, 'a word list that does not end')
  const body = t.source.slice(t.at + match[0].length, end)
  if (/[\\([{<]/u.test(body)) fail(t, 'a word list with an escape or a bracket')
  push(t, 'words', body.split(/\s+/u).filter((word) => word !== ''))
  t.line += body.split('\n').length - 1
  t.at = end + 1
}

// A literal at `rest`, or false where there is none: a heredoc, a word list, a string, a symbol or a number.
function literal(t, rest) {
  let match
  if ((match = /^<<([~-]?)(['"]?)([A-Za-z_]\w*)\2/u.exec(rest)) !== null && t.tokens.at(-1)?.type !== 'name') {
    push(t, 'string', undefined, { parts: [] })
    t.pending.push({ token: t.tokens.at(-1), name: match[3], squiggly: match[1] === '~', raw: match[2] === "'" })
    t.at += match[0].length
  } else if ((match = /^%([wWiIqQ]?)([([{<])/u.exec(rest)) !== null) words(t, match)
  else if (rest[0] === '"' || rest[0] === "'") {
    t.at++
    push(t, 'string', undefined, { parts: rest[0] === '"' ? interpolated(t, '"') : single(t) })
  } else if ((match = /^:([A-Za-z_]\w*[?!=]?)(?!:)/u.exec(rest)) !== null) {
    push(t, 'symbol', match[1])
    t.at += match[0].length
  } else if (rest.startsWith(':"')) {
    t.at += 2
    const parts = interpolated(t, '"')
    if (parts.some((part) => typeof part !== 'string')) fail(t, 'a symbol with an interpolation')
    push(t, 'symbol', parts.join(''))
  } else {
    const number = /^\d[\d_]*(\.\d+)?/u.exec(rest)
    if (number === null) return false
    if (number[1] !== undefined) fail(t, 'a number with a fraction')
    push(t, 'number', Number(number[0].replaceAll('_', '')))
    t.at += number[0].length
  }
  return true
}

// `source` is the podspec's text, from `line` of it; `where` what a refusal is about. A string comes as its
// `parts`, each text or `{ code }`, an interpolation to read; a heredoc's body is taken after its line.
export function tokenize(source, where, line = 1) {
  const t = { source, where, at: 0, line, tokens: [], pending: [] }
  while (t.at < source.length) {
    const char = source[t.at]
    const rest = source.slice(t.at)
    let match
    if (char === '\n') {
      push(t, 'newline')
      t.at++
      t.line++
      heredocs(t)
    } else if (char === ' ' || char === '\t' || char === '\r') t.at++
    else if (char === '#') t.at = lineEnd(t)
    else if (char === '\\' && source[t.at + 1] === '\n') {
      t.at += 2
      t.line++
    } else if (literal(t, rest)) continue
    else if ((match = /^[A-Za-z_]\w*[?!]?/u.exec(rest)) !== null) {
      push(t, 'name', match[0])
      t.at += match[0].length
    } else if ((match = PUNCTUATION.find((one) => rest.startsWith(one))) !== undefined && !/^(?:==|=~|\+=|\|\||<<)/u.test(rest)) {
      push(t, match)
      t.at += match.length
    } else fail(t, `\`${/^\S{1,12}/u.exec(rest)[0]}\``)
  }
  push(t, 'newline')
  heredocs(t)
  push(t, 'end of file')
  return t.tokens
}
