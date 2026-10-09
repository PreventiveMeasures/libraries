// The modules a source requests, read with no parser, so Flow, which oxc
// does not read, reads too: comments, strings, templates and regular
// expressions are passed by as a lexer passes them, and the shapes that
// request a module are matched on the tokens left. A quote in JSX text,
// taken for a string's start, ends with its line.

const SPACE = /\s+/uy
const WORD = /[\w$\u0080-￿]+/uy
// After these a `/` starts a regular expression, not a division.
const OPERATORS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

function regexAllowed(previous) {
  if (!previous) return true
  if (previous.type === 'word') return OPERATORS.has(previous.value)
  return previous.type === 'punctuator' && !')]}'.includes(previous.value)
}

// A string's value, or null for one cut off by its line, or escaped.
function quoted(text, at) {
  const quote = text[at]
  let i = at + 1
  while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
  const value = text.slice(at + 1, i)
  return [text[i] === quote && !value.includes('\\') ? value : null, i + 1]
}

function regexEnd(text, at) {
  let i = at + 1
  let inClass = false
  while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
    if (text[i] === '\\') i++
    else if (text[i] === '[') inClass = true
    else if (text[i] === ']') inClass = false
    i++
  }
  WORD.lastIndex = i + 1
  return WORD.test(text) ? WORD.lastIndex : i + 1
}

// Through a template's text to its end, or into a `${`, pushed on `braces`.
function templateEnd(text, at, braces) {
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '`') return i + 1
    else if (text[i] === '$' && text[i + 1] === '{') {
      braces.push('template')
      return i + 2
    }
  }
  return text.length
}

function lex(text) {
  const tokens = []
  const braces = []
  let i = 0
  while (i < text.length) {
    SPACE.lastIndex = i
    if (SPACE.test(text)) i = SPACE.lastIndex
    if (i >= text.length) break
    const c = text[i]
    const next = text[i + 1]
    WORD.lastIndex = i
    if (c === '/' && (next === '/' || next === '*')) {
      const end = text.indexOf(next === '/' ? '\n' : '*/', i + 2)
      i = end < 0 ? text.length : end + (next === '*' ? 2 : 0)
    } else if (c === '"' || c === "'") {
      const [value, end] = quoted(text, i)
      tokens.push({ type: 'string', value })
      i = end
    } else if (c === '`' || (c === '}' && braces.at(-1) === 'template')) {
      if (c === '}') braces.pop()
      i = templateEnd(text, i + 1, braces)
      tokens.push({ type: 'string', value: null })
    } else if (c === '/' && regexAllowed(tokens.at(-1))) {
      i = regexEnd(text, i)
      tokens.push({ type: 'regex' })
    } else if (WORD.test(text)) {
      tokens.push({ type: 'word', value: text.slice(i, WORD.lastIndex) })
      i = WORD.lastIndex
    } else {
      if (c === '{') braces.push('block')
      else if (c === '}') braces.pop()
      tokens.push({ type: 'punctuator', value: c })
      i++
    }
  }
  return tokens
}

const isString = (token) => token?.type === 'string' && token.value !== null
const TYPE_WORDS = new Set(['type', 'typeof'])

// `{ type A, typeof B }`: names a type erasure takes with the statement.
function onlyTypes(tokens, open) {
  let any = false
  for (let j = open + 1; j < tokens.length && tokens[j].value !== '}'; j++) {
    if (j > open + 1 && tokens[j - 1].value !== ',') continue
    if (!TYPE_WORDS.has(tokens[j].value)) return false
    any = true
  }
  return any
}

// The string after the statement's `from`, before its end.
function fromOf(tokens, at) {
  for (let j = at; j < tokens.length; j++) {
    const { value } = tokens[j]
    if (value === ';' || (j > at && (value === 'import' || value === 'export'))) return null
    if (value === 'from' && isString(tokens[j + 1])) return tokens[j + 1].value
  }
  return null
}

// What `import` or `export` at `k` requests, as importEdges' kinds; null
// for none, or for one that requests only types.
function declared(tokens, k) {
  const [keyword, next, after] = [tokens[k].value, tokens[k + 1], tokens[k + 2]]
  const kind = keyword === 'import' ? 'import' : 'export-from'
  if (keyword === 'import' && isString(next)) return { kind, specifier: next.value }
  if (TYPE_WORDS.has(next?.value) && ![',', 'from'].includes(after?.value)) return null
  if (next?.value === '{' && onlyTypes(tokens, k + 1)) return null
  if (keyword === 'export' && !['{', '*'].includes(next?.value)) return null
  if (keyword === 'import' && next?.type !== 'word' && !['{', '*'].includes(next?.value)) return null
  const specifier = fromOf(tokens, k + 1)
  return specifier === null ? null : { kind, specifier }
}

// `callees`: functions taking a module's name, as require does.
export function scanSpecifiers(text, callees = new Set()) {
  const tokens = lex(text)
  const found = []
  for (const [k, token] of tokens.entries()) {
    if (token.type !== 'word' || tokens[k - 1]?.value === '.') continue
    const [open, argument, close] = [tokens[k + 1], tokens[k + 2], tokens[k + 3]]
    if ((token.value === 'require' || callees.has(token.value)) && open?.value === '(' && isString(argument) && close?.value === ')') {
      found.push({ kind: 'require', specifier: argument.value, ...(token.value !== 'require' && { callee: token.value }) })
    } else if (token.value === 'import' && open?.value === '(') {
      if (isString(argument)) found.push({ kind: 'dynamic-import', specifier: argument.value })
    } else if (token.value === 'import' || token.value === 'export') {
      const request = declared(tokens, k)
      if (request) found.push(request)
    }
  }
  return found
}
