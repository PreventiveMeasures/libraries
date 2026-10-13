// A file formatted by oxfmt, used only where checks apart from oxfmt find it differs in layout
// alone: a script's syntax tree as oxc parses it, a style sheet's as css-tree does (an optional peer,
// CSS refused without it), JSON's strings and comments as written.

import { getParser } from '#oxc'
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
// blanks, parentheses, semicolons, quotes and numbers, and a comma before a closing bracket, past any
// comments (`import { a, b, }`). A regular expression's flags it may reorder are sorted where the
// syntax tree has them (respelled).
const scriptForm = (text) => text.replaceAll(NUMBER, numberSpelling).replaceAll(/,(?=(?:\s|\/\/[^\n]*|\/\*[^]*?\*\/)*[\])}>])/gu, '')
  .replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')

// JSON has no point without a digit either side: such a number is kept as written, or a copy would read as
// valid, as would one with other blanks than JSON's four, which stay.
const jsonNumber = (text) => (/^\.|\.(?!\d)/u.test(text) ? text.toLowerCase() : numberSpelling(text))
const jsonForm = (text) => text.split(LITERAL).map((part, i) => (i % 2 ? (part.startsWith('/') ? indentless(part) : part) : part.replaceAll(/[\t\n\r ]/gu, '').replaceAll(NUMBER, jsonNumber)))

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i])

function parsed(text, extension) {
  const lang = extension === 'tsx' ? 'tsx' : /^[cm]?ts$/u.test(extension) ? 'ts' : 'jsx'
  const sourceType = extension.startsWith('m') ? 'module' : extension.startsWith('c') ? 'commonjs' : 'unambiguous'
  const result = getParser()(`file.${extension}`, text, { lang, sourceType, preserveParens: false })
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

// Each node of a syntax tree given to `each`.
function visit(program, each) {
  const work = [program]
  while (work.length > 0) {
    const node = work.pop()
    // Pushed one by one: a spread of a file's statements could pass more arguments than a call takes.
    if (Array.isArray(node)) for (const item of node) work.push(item)
    else if (node !== null && typeof node === 'object') {
      each(node)
      for (const key of Object.keys(node)) if (!POSITION.has(key) && typeof node[key] === 'object') work.push(node[key])
    }
  }
}

// `text` with each of `edits`, `[from, to, put]`, none overlapping another.
function edited(text, edits) {
  let from = 0, out = ''
  for (const [start, end, put] of edits.toSorted(([x], [y]) => x - y)) {
    out += text.slice(from, start) + put
    from = end
  }
  return out + text.slice(from)
}

// A script as the formatter may write it, read off its syntax tree: each regular expression's flags
// sorted (`/x/yu` as `/x/uy`), and where it has `types`, a member's separator `;` where it was `,`
// (`{ a: string, b: number }`), and no `|` or `&` before a union's or an intersection's first type
// (`type P =\n  | A\n  | B`, `[K in\n  | A\n  | B]`). oxc reads a member with the separator ending it
// and a union from the mark leading it, so each is taken where it is, in whatever context.
function respelled(text, program, types) {
  const edits = []
  visit(program, (node) => {
    if (node.regex) edits.push([node.end - node.regex.flags.length, node.end, sorted(node.regex.flags)])
    if (!types) return
    const members = node.type === 'TSTypeLiteral' ? node.members : node.type === 'TSInterfaceBody' ? node.body : []
    for (const member of members) if (text[member.end - 1] === ',') edits.push([member.end - 1, member.end, ';'])
    const mark = node.type === 'TSUnionType' ? '|' : node.type === 'TSIntersectionType' ? '&' : null
    if (mark && text[node.start] === mark && node.types[0]?.start > node.start) edits.push([node.start, node.start + 1, ''])
  })
  return edited(text, edits)
}

// A safeguard on oxfmt's own output, not a comparison of any two texts: exported
// for tests alone, not by the package. CSS is read by `csstree` where given.
export function sameCode(text, formatted, extension = 'js', csstree = null) {
  if (extension === 'css') return csstree !== null && sameCss(csstree, text, formatted)
  if (extension === 'json') return sameList(jsonForm(text), jsonForm(formatted))
  if (!SCRIPTS.has(extension)) return false
  const [before, after] = [parsed(text, extension), parsed(formatted, extension)]
  if (before === null || after === null) return false
  const form = (code, { program }) => scriptForm(respelled(code, program, /^[cm]?tsx?$/u.test(extension)))
  return form(text, before) === form(formatted, after) && sameList(comments(before), comments(after)) && sameTree(before.program, after.program)
}

// A name as written from where it starts, escapes and all.
const NAME = /(?:\\u\{[\dA-Fa-f]+\}|\\u[\dA-Fa-f]{4}|[$\p{ID_Continue}\u{200C}\u{200D}])+/uy
// What oxfmt may write after a block comment the file has after it: an operator, `,`, `?` or `:`.
const MOVED = /[\t ]*([!%&*+,\-/:<=>?^|~]+|in(?:stanceof)?(?![$\p{ID_Continue}]))/uy
const MARK = /[!%&*+,\-/:<=>?^|~]/u
const NAME_PART = /[$\p{ID_Continue}]/u

// Each name of a syntax tree, `[where it starts, what it reads, as written]`, in order: a shorthand
// property's key and value, one name, once.
function names(text, program) {
  const found = new Map()
  visit(program, (node) => {
    if (node.type !== 'Identifier' && node.type !== 'PrivateIdentifier') return
    const at = node.type === 'Identifier' ? node.start : node.start + 1
    NAME.lastIndex = at
    found.set(at, [at, node.name, NAME.exec(text)?.[0] ?? ''])
  })
  return [...found.values()].toSorted(([x], [y]) => x - y)
}

// Where the blanks on its line before `at` start.
function blanksFrom(text, at) {
  let from = at
  while (from > 0 && (text[from - 1] === ' ' || text[from - 1] === '\t')) from--
  return from
}

// The copy as the file writes what oxfmt writes otherwise, where that changes no more than its layout,
// before it is checked as any copy is:
// - a name's escapes, which oxfmt reads (`\u{61}` as `a`): a copy shows no character the file only
//   escapes, one unseen, a joiner in a name say, or one like another;
// - a block comment after an operator, a `,`, `?` or `:`, which oxfmt moves before it where the comment
//   ends its line (`a &&/* c */\nb` as `a /* c */ && b`): where a comment is may matter to what reads
//   it, a bundler a `#__PURE__` mark say, and a reader sees it where the file has it.
// Names and comments are paired in order, as the check finds them alike or refuses the copy.
function asWritten(text, code, extension) {
  if (!SCRIPTS.has(extension) || !/\\u|\/\*/u.test(text)) return code
  const [before, after] = [parsed(text, extension), parsed(code, extension)]
  if (before === null || after === null) return code
  const edits = []
  const [olds, news] = [names(text, before.program), names(code, after.program)]
  if (olds.length === news.length) {
    olds.forEach(([, name, written], i) => {
      const [at, read, spelled] = news[i]
      if (written !== spelled && written.includes('\\') && name === read) edits.push([at, at + spelled.length, written])
    })
  }
  const [was, now] = [before.comments, after.comments]
  for (let i = 0; was.length === now.length && i < now.length; i++) {
    // A run of comments on one line moves as one.
    const first = i
    while (i + 1 < now.length && /^[\t ]*$/u.test(code.slice(now[i].end, now[i + 1].start))) i++
    MOVED.lastIndex = now[i].end
    const from = blanksFrom(code, now[first].start), moved = MOVED.exec(code)
    if (moved === null || from === 0 || code[from - 1] === '\n') continue
    const [, mark] = moved
    // One the copy has before the comment too stayed, the one after another (`a + /* c */ +b`).
    if (code.startsWith(mark, from - mark.length)) continue
    const at = blanksFrom(text, was[first].start) - mark.length
    if (at >= 0 && text.startsWith(mark, at) && !(mark.startsWith('i') ? NAME_PART : MARK).test(text[at - 1] ?? '')) {
      edits.push([from, now[first].start, `${mark === ',' ? '' : ' '}${mark} `], [now[i].end, now[i].end + moved[0].length, ''])
    }
  }
  return edited(code, edits)
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
// oxfmt, and oxc-parser that checks a script, are loaded outside the try: one missing is thrown, not
// taken for a file that won't format, or for a copy the check finds changed.
export async function format(text, extension) {
  const csstree = extension === 'css' ? await loadCssTree() : null
  if (!(SCRIPTS.has(extension) || extension === 'json' || csstree)) return { error: 'unsupported' }
  const oxfmt = await loadFormatter()
  if (SCRIPTS.has(extension)) getParser()
  const result = await oxfmt(`pretty.${extension}`, text, PRETTY_OPTIONS).catch(() => null)
  if (result === null || result.errors.length > 0) return { error: 'unformattable' }
  // oxfmt's copy as it is, or where the check refuses it, as the file writes what oxfmt respelled: a
  // copy the check takes respelled nothing so, as its text would differ. A check that fails in itself,
  // its stack say, refuses the copy as one that finds it changed would.
  const checked = (code) => (sameCode(text, code, extension, csstree) ? { code } : null)
  try {
    return checked(breakAfterComments(result.code, extension)) ?? checked(breakAfterComments(asWritten(text, result.code, extension), extension)) ?? { error: 'pretty-mismatch' }
  } catch {
    return { error: 'pretty-mismatch' }
  }
}
