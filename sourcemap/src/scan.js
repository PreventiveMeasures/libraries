// The modules a source requests, read with no parser, so Flow, which oxc
// does not read, reads too: comments, strings, templates and regular
// expressions are passed by as a lexer passes them, and the shapes that
// request a module are matched on the tokens left. A quote in JSX text,
// taken for a string's start, ends with its line.

const SPACE = /\s+/uy
// JavaScript's line terminators, which end a line comment, a string, a
// regular expression.
const LINE_ENDS = '\n\r\u2028\u2029'
const LINE_END = /[\n\r\u2028\u2029]/gu
const LINE_BREAK = /[\n\r\u2028\u2029]/u
const WORD = /[\w$\u0080-￿]+/uy
// After these a `/` starts a regular expression, not a division; and
// after the `)` that closes the head of these, `if (a) /re/.test(b)`, and
// the `}` that closes a block, not an object.
const OPERATORS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'default', 'extends', 'do', 'else', 'yield', 'await'])
const CONTROL = new Set(['if', 'while', 'for', 'with'])
// And after these, the end of their statement.
const ENDING = new Set(['break', 'continue', 'debugger'])
// A `{` after these opens an object, where an expression goes; after
// anything else (`)`, `=>`, a statement's end, `else`), a block.
const EXPRESSION_BEFORE = new Set(['(', '[', ',', '=', ':', '?', '!', '~', '+', '-', '*', '/', '%', '&', '|', '^', '<', '>'])

function opensObject(previous, lineBefore) {
  if (previous?.type !== 'word') return EXPRESSION_BEFORE.has(previous?.value)
  // A line's end after `return` or `yield` ends the statement there.
  if (lineBefore && ['return', 'yield'].includes(previous.value)) return false
  return OPERATORS.has(previous.value) && !['do', 'else'].includes(previous.value)
}

// `if (`, and `for await (`.
function opensHead(tokens) {
  const previous = tokens.at(-1)
  return previous?.type === 'word' && (CONTROL.has(previous.value) || (previous.value === 'await' && tokens.at(-2)?.value === 'for'))
}

function regexAllowed(previous) {
  if (!previous) return true
  if (previous.type === 'word') return OPERATORS.has(previous.value) || ENDING.has(previous.value) || previous.label === true
  if (previous.value === ')') return previous.control
  if (previous.value === '}') return !previous.object
  return previous.type === 'punctuator' && !['++', '--', ']'].includes(previous.value)
}

// An escaped line's end, `\r\n` too, continues a string.
const escapeLength = (text, at) => (text.startsWith('\r\n', at + 1) ? 3 : 2)

// A string's value, or null for one cut off by its line, or escaped.
function quoted(text, at) {
  const quote = text[at]
  let i = at + 1
  while (i < text.length && text[i] !== quote && !LINE_ENDS.includes(text[i])) i += text[i] === '\\' ? escapeLength(text, i) : 1
  const value = text.slice(at + 1, i)
  return [text[i] === quote && !value.includes('\\') ? value : null, i + 1]
}

function regexEnd(text, at) {
  let i = at + 1
  let inClass = false
  while (i < text.length && !LINE_ENDS.includes(text[i]) && (inClass || text[i] !== '/')) {
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
  const parens = []
  let i = 0
  let lastEnd = 0
  while (i < text.length) {
    const count = tokens.length
    SPACE.lastIndex = i
    if (SPACE.test(text)) i = SPACE.lastIndex
    if (i >= text.length) break
    const c = text[i]
    const next = text[i + 1]
    WORD.lastIndex = i
    if (c === '/' && next === '/') {
      LINE_END.lastIndex = i + 2
      i = LINE_END.test(text) ? LINE_END.lastIndex - 1 : text.length
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === '"' || c === "'") {
      const [value, end] = quoted(text, i)
      tokens.push({ type: 'string', value })
      i = end
    } else if (c === '`' || (c === '}' && braces.at(-1) === 'template')) {
      if (c === '}') braces.pop()
      const depth = braces.length
      const end = templateEnd(text, i + 1, braces)
      // A template with nothing put in it, or escaped, is the string it spells.
      const raw = text.slice(i + 1, end - 1)
      const whole = c === '`' && braces.length === depth && text[end - 1] === '`' && !raw.includes('\\')
      tokens.push({ type: 'string', value: whole ? raw : null })
      i = end
    } else if (c === '/' && regexAllowed(tokens.at(-1))) {
      i = regexEnd(text, i)
      tokens.push({ type: 'regex' })
    } else if (WORD.test(text)) {
      // `break label`'s label, on its line, ends the statement as `break` does.
      const label = ENDING.has(tokens.at(-1)?.value) && !LINE_BREAK.test(text.slice(lastEnd, i))
      tokens.push({ type: 'word', value: text.slice(i, WORD.lastIndex), ...(label && { label }) })
      i = WORD.lastIndex
    } else {
      if (c === '{') braces.push(opensObject(tokens.at(-1), LINE_BREAK.test(text.slice(lastEnd, i))) ? 'object' : 'block')
      const closed = c === '}' ? braces.pop() : undefined
      if (c === '(') parens.push(opensHead(tokens))
      // `a++ / b`: a postfix update ends an operand; `=> {` opens a block.
      const value = ((c === '+' || c === '-') && next === c) || (c === '=' && next === '>') ? c + next : c
      tokens.push({ type: 'punctuator', value, ...(c === ')' && { control: parens.pop() === true }), ...(c === '}' && { object: closed === 'object' }) })
      i += value.length
    }
    if (tokens.length > count) lastEnd = i
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

// What a call's first argument names, as the parser reads it: its string,
// or null for one computed; undefined for a call with none.
function argumentOf(tokens, k) {
  const [argument, after] = [tokens[k + 2], tokens[k + 3]]
  if (argument?.value === ')') return undefined
  return isString(argument) && [')', ','].includes(after?.value) ? argument.value : null
}

// `callees`: functions taking a module's name, as require does.
export function scanSpecifiers(text, callees = new Set()) {
  const tokens = lex(text)
  const found = []
  for (const [k, token] of tokens.entries()) {
    if (token.type !== 'word' || ['.', 'function'].includes(tokens[k - 1]?.value)) continue
    // TypeScript's `import type a = require(…)`, which type erasure takes.
    if (tokens[k - 1]?.value === '=' && tokens[k - 3]?.value === 'type' && tokens[k - 4]?.value === 'import') continue
    const called = tokens[k + 1]?.value === '('
    const specifier = called ? argumentOf(tokens, k) : undefined
    if ((token.value === 'require' || callees.has(token.value)) && specifier !== undefined) {
      found.push({ kind: 'require', specifier, ...(token.value !== 'require' && { callee: token.value }) })
    } else if (token.value === 'import' && called) {
      if (specifier !== undefined) found.push({ kind: 'dynamic-import', specifier })
    } else if (token.value === 'import' || token.value === 'export') {
      const request = declared(tokens, k)
      if (request) found.push(request)
    }
  }
  return found
}
