// A file formatted by oxfmt, used only where checks apart from oxfmt find it differs in layout
// alone: a script's syntax tree as oxc parses it, a style sheet's as css-tree does (an optional peer,
// CSS refused without it), JSON's strings and comments as written.

import { getOxc } from '#oxc'
import { indentless, sameCss } from './css.js'
import { loadCssTree, loadFormatter } from './peers.js'

const PRETTY_OPTIONS = { quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off' }

const SCRIPTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'])
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu
const POSITION = new Set(['start', 'end', 'range', 'loc'])
// JSON's strings, quoted either way or in backticks as its kin may have them, and its comments, compared
// as written, split from the rest; one unclosed runs to its line's end, or the end.
const LITERAL = /("(?:[^"\\\n]|\\(?:\r\n|[^]))*(?:"|(?=\n)|$)|'(?:[^'\\\n]|\\(?:\r\n|[^]))*(?:'|(?=\n)|$)|`(?:[^`\\]|\\[^])*(?:`|$)|\/\*[^]*?(?:\*\/|$)|\/\/.*)/u

// A number as the formatter spells it (`.50E+3` as `0.5e3`), but for what JSON may read as another
// type: a point keeps a digit after it, a whole number its zero exponent (`1.0`, `1e0`).
function numberSpelling(text) {
  const number = text.toLowerCase()
  const parts = /^0[box]|n$/u.test(number) ? null : /^([^e]*)(?:e([+-]?)0*(\d+))?$/u.exec(number)
  if (!parts) return number
  const [, mantissa = '', sign = '', exponent = ''] = parts
  const fraction = (mantissa.startsWith('.') ? `0${mantissa}` : mantissa).replace(/(\.\d+?)0+$/u, '$1').replace(/\.$/u, '')
  const zero = /^0+$/u.test(exponent)
  return exponent === '' || (zero && fraction.includes('.')) ? fraction : `${fraction}e${sign === '-' && !zero ? '-' : ''}${exponent}`
}

const sorted = (flags) => [...flags].toSorted().join('')
// A script's text but for what the formatter may respell, beside the syntax tree compared after:
// blanks, parentheses, semicolons, quotes, numbers and a regular expression's flags, and a comma before
// a closing bracket, past any comments (`import { a, b, }`).
const scriptForm = (text) => text.replaceAll(NUMBER, numberSpelling).replaceAll(/,(?=(?:\s|\/\/[^\n]*|\/\*[^]*?\*\/)*[\])}>])/gu, '')
  .replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')
  .replaceAll(/(?<=\/)[dgimsuvy]{2,}(?![\p{L}\p{N}_$])/gu, sorted)

// JSON has no point without a digit either side: such a number is kept as written, or a copy would read as
// valid, as would one with other blanks than JSON's four, which stay.
const jsonNumber = (text) => (/^\.|\.(?!\d)/u.test(text) ? text.toLowerCase() : numberSpelling(text))
const jsonForm = (text) => text.split(LITERAL).map((part, i) => (i % 2 ? (part.startsWith('/') ? indentless(part) : part) : part.replaceAll(/[\t\n\r ]/gu, '').replaceAll(NUMBER, jsonNumber)))

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i])

function parsed(text, extension) {
  const lang = extension === 'tsx' ? 'tsx' : /^[cm]?ts$/u.test(extension) ? 'ts' : 'jsx'
  const sourceType = extension.startsWith('m') ? 'module' : extension.startsWith('c') ? 'commonjs' : 'unambiguous'
  const result = getOxc().parseSync(`file.${extension}`, text, { lang, sourceType, preserveParens: false })
  return result.errors.length > 0 ? null : result
}

// A comment as written, but for its indentation and the blanks ending it, which formatting trims.
const comments = ({ comments: list }) => list.map(({ type, value }) => `${type} ${indentless(value).replace(/[\t ]+$/u, '')}`)
// `a && (b && c)` and `(a && b) && c` read alike, as do `||` and `??` chains.
function chain(node, operator) {
  const operands = [], rest = [node]
  while (rest.length > 0) {
    const next = rest.pop()
    if (next?.type === 'LogicalExpression' && next.operator === operator) rest.push(next.right, next.left)
    else operands.push(next)
  }
  return operands
}
const fields = (node) => Object.keys(node).filter((key) => !POSITION.has(key) && !(node.type === 'Literal' && (key === 'raw' || key === 'regex' || (key === 'value' && node.regex))))

function sameTree(a, b) {
  const work = [[a, b]]
  while (work.length > 0) {
    const [x, y] = work.pop()
    if (x === y) continue
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null || Array.isArray(x) !== Array.isArray(y)) return false
    let pairs
    if (Array.isArray(x)) pairs = [x, y].map((list) => list.filter((node) => node?.type !== 'EmptyStatement'))
    else if (x.type === 'LogicalExpression' && y.type === 'LogicalExpression' && x.operator === y.operator) pairs = [chain(x, x.operator), chain(y, y.operator)]
    else {
      const [keys, others] = [fields(x), fields(y)]
      if (keys.join() !== others.join()) return false
      if (x.type === 'Literal' && x.regex && (x.regex.pattern !== y.regex?.pattern || sorted(x.regex.flags) !== sorted(y.regex.flags))) return false
      pairs = [keys.map((key) => x[key]), keys.map((key) => y[key])]
    }
    if (pairs[0].length !== pairs[1].length) return false
    pairs[0].forEach((node, i) => work.push([node, pairs[1][i]]))
  }
  return true
}

// A script's types as the formatter writes them: a member's separator `;` where it was `,`
// (`{ a: string, b: number }`), and no `|` or `&` before a union's or an intersection's first type
// (`type P =\n  | A\n  | B`, `[K in\n  | A\n  | B]`). oxc reads a member with the separator ending it
// and a union from the mark leading it, so each is taken where it is, in whatever context.
function typed(text, program) {
  const edits = [], work = [program]
  while (work.length > 0) {
    const node = work.pop()
    // Pushed one by one: a spread of a file's statements could pass more arguments than a call takes.
    if (Array.isArray(node)) for (const item of node) work.push(item)
    else if (node !== null && typeof node === 'object') {
      const members = node.type === 'TSTypeLiteral' ? node.members : node.type === 'TSInterfaceBody' ? node.body : []
      for (const member of members) if (text[member.end - 1] === ',') edits.push([member.end - 1, ';'])
      const mark = node.type === 'TSUnionType' ? '|' : node.type === 'TSIntersectionType' ? '&' : null
      if (mark && text[node.start] === mark && node.types[0]?.start > node.start) edits.push([node.start, ''])
      for (const key of Object.keys(node)) if (!POSITION.has(key) && typeof node[key] === 'object') work.push(node[key])
    }
  }
  let from = 0, out = ''
  for (const [at, put] of edits.toSorted(([x], [y]) => x - y)) {
    out += text.slice(from, at) + put
    from = at + 1
  }
  return out + text.slice(from)
}

// A safeguard on oxfmt's own output, not a comparison of any two texts: exported
// for tests alone, not by the package. CSS is read by `csstree` where given.
export function sameCode(text, formatted, extension = 'js', csstree = null) {
  if (extension === 'css') return csstree !== null && sameCss(csstree, text, formatted)
  if (extension === 'json') return sameList(jsonForm(text), jsonForm(formatted))
  if (!SCRIPTS.has(extension)) return false
  const [before, after] = [parsed(text, extension), parsed(formatted, extension)]
  if (before === null || after === null) return false
  const form = (code, { program }) => scriptForm(/^[cm]?tsx?$/u.test(extension) ? typed(code, program) : code)
  return form(text, before) === form(formatted, after) && sameList(comments(before), comments(after)) && sameTree(before.program, after.program)
}

// A script's block comments over more than one line, a license's say, each end their line: what oxfmt
// leaves after one on its last line (`*/ class A {`) goes to the next, indented as the comment's first
// line is. A comment holding a line break ends a line to the parser already (`return /*\n*/ 1` returns),
// so the break changes nothing it reads; the check after says so.
function breakAfterComments(code, extension) {
  if (!SCRIPTS.has(extension) || !/\*\/[\t ]*\S/u.test(code)) return code
  const result = parsed(code, extension)
  if (!result) return code
  let from = 0, out = ''
  for (const { type, value, start, end } of result.comments) {
    const lineEnd = code.indexOf('\n', end)
    const rest = code.slice(end, lineEnd === -1 ? code.length : lineEnd)
    if (type !== 'Block' || !value.includes('\n') || rest.trim() === '') continue
    out += code.slice(from, end)
    const line = out.slice(out.lastIndexOf('\n', out.length - (end - start)) + 1)
    out += `\n${/^[\t ]*/u.exec(line)[0]}`
    from = end + rest.length - rest.trimStart().length
  }
  return out + code.slice(from)
}

// Only what can be checked is formatted: scripts, JSON, and CSS where css-tree is there to read it.
// oxfmt is loaded outside the try: one missing is thrown, not taken for a file that won't format.
export async function format(text, extension) {
  const csstree = extension === 'css' ? await loadCssTree() : null
  if (!(SCRIPTS.has(extension) || extension === 'json' || csstree)) return { error: 'unsupported' }
  const oxfmt = await loadFormatter()
  const result = await oxfmt(`pretty.${extension}`, text, PRETTY_OPTIONS).catch(() => null)
  if (result === null || result.errors.length > 0) return { error: 'unformattable' }
  // A check that fails in itself, its stack say, refuses the copy as one that finds it changed would.
  try {
    const code = breakAfterComments(result.code, extension)
    return sameCode(text, code, extension, csstree) ? { code } : { error: 'pretty-mismatch' }
  } catch {
    return { error: 'pretty-mismatch' }
  }
}
