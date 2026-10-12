// A file formatted by oxfmt, used only where checks apart from oxfmt find it
// differs in layout alone: strings and comments as written, the rest as
// formatting may respell it, and a script's syntax tree as oxc parses it.

import { getOxc } from '#oxc'
import { loadFormatter } from './oxfmt.js'

const PRETTY_OPTIONS = { quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off' }

const SCRIPTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'])
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu
const POSITION = new Set(['start', 'end', 'range', 'loc'])
// Strings and comments, compared as written, split from the rest; one unclosed runs
// to the end. CSS's unquoted URLs and element() references count as strings, as do attribute
// values formatting quotes.
const LITERAL = {
  css: /("(?:[^"\\\n]|\\[^])*"|'(?:[^'\\\n]|\\[^])*'|\/\*[^]*?(?:\*\/|$)|(?<![-\w])(?:url|(?:-moz-)?element)\(\s*(?:[^"'()\s\\]|\\[^])*\s*\)|(?=-?[_a-z\u00A0-\uFFFF])(?<==\s*)-?[_a-z\u00A0-\uFFFF][-\w\u00A0-\uFFFF]*(?=\s*(?:[is]\s*)?\]))/iu,
  json: /("(?:[^"\\\n]|\\[^])*"|\/\*[^]*?(?:\*\/|$)|\/\/.*)/u,
}
const UNIT = String.raw`(?<![-\w.#\\])-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[a-z]+`
// What formatting changes in CSS but layout, strings and comments aside: it lowercases
// at-rule names, queries, `!important`, units, a declaration's property and hex colors and a
// selector's pseudo-classes, and spaces a selector's `+` (a value's is kept, as `calc()` needs).
const CSS_FORM = new RegExp(String.raw`${LITERAL.css.source}|(?<query>@(?:media|supports)\b(?:[^{};/"']|\/(?!\*))*)|@[-\w]+|![a-z]+|${UNIT}`
  + String.raw`|(?<declared>#[\da-f]{3,8}(?![-\w])|(?<![-\w.#\\])[a-z][-\w]*(?=\s*:))|(?<selected>(?<=:)-?[a-z][-\w]*|(?<!\s)\s*\+\s*)|(?<semi>;)(?=\s*\})`, 'giu')
// A query's words but its values (`(prefers-color-scheme: DARK)`) and custom properties.
const QUERY_WORD = new RegExp(String.raw`${UNIT}|(?=[a-z])(?<![-\w.#\\]|:\s*)[a-z][-\w]*`, 'giu')
// A space in CSS is kept between two characters a selector may hold, as in `.a .b`, around
// `+`, and where dropping it would make one token of two (`# fff`, `5 %`).
const CSS_SPACE = /(?<![-\w\u00A0-\uFFFF%)\]*+#.@\\]) | (?![-\w\u00A0-\uFFFF.#:[(*+&%\\])| (?=\()(?<=@[-\w]+ )|(?<=[)\]]) (?=[-\w]+\()/gu

// A number as the formatter spells it (`.50E+3` as `0.5e3`).
function numberSpelling(text) {
  const number = text.toLowerCase()
  const parts = /^0[box]|n$/u.test(number) ? null : /^([^e]*)(?:e([+-]?)0*(\d+))?$/u.exec(number)
  if (!parts) return number
  const [, mantissa = '', sign = '', exponent = ''] = parts
  const fraction = (mantissa.startsWith('.') ? `0${mantissa}` : mantissa).replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
  return exponent === '' || /^0+$/u.test(exponent) ? fraction : `${fraction}e${sign === '-' ? '-' : ''}${exponent}`
}

// A script's text without what formatting may respell, comments and all; its
// strings and comments are compared exactly in the syntax tree and comment list.
const scriptForm = (text) => text.replaceAll(NUMBER, numberSpelling).replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')
  .replaceAll(/(?<=\/)[dgimsuvy]{2,}(?![\p{L}\p{N}_$])/gu, (flags) => [...flags].toSorted().join(''))

const squash = (text) => text.replaceAll(/\s+/gu, ' ').trim()
const indentless = (text) => text.replaceAll(/(?<![ \t])[ \t]*\r?\n[ \t]*/gu, '\n')

// Formatting may change a string's quotes and a comment's indentation alone.
function literal(token) {
  if (token.startsWith('/')) return indentless(token)
  return /^["']/u.test(token) ? `"${token.slice(1, -1).replaceAll(/\\(?=["'])/gu, '')}"` : `"${token}"`
}

// CSS as formatting would write it but for layout. What is in a selector or query (whose next
// `{`, `;` or `}`, strings and comments aside, is a `{`) is told from what is declared, and a
// rule's last `;` dropped, not one closing a block in a custom property's value (`--x: {a;}`).
function cssCase(text) {
  const blank = text.replaceAll(new RegExp(LITERAL.css.source, 'giu'), (token) => ' '.repeat(token.length))
  const blocks = [], next = new Uint8Array(text.length + 1)
  for (let i = 0, start = 0; i < blank.length; i++) {
    if (blank[i] === '{') blocks.push(blocks.at(-1) === 3 || /^\s*--[^:]*:/u.test(blank.slice(start, i)) ? 3 : 2)
    if (blank[i] === '}') next[i] = blocks.pop() ?? 2
    if ('{;}'.includes(blank[i])) start = i + 1
  }
  for (let i = text.length - 1; i >= 0; i--) if (blank[i] !== '}') next[i] = blank[i] === '{' ? 1 : blank[i] === ';' ? 0 : next[i + 1]
  return text.replaceAll(CSS_FORM, (token, string, ...rest) => {
    const { query, declared, selected, semi } = rest.at(-1), offset = rest.at(-3)
    const inSelector = next[offset] === 1
    if (semi !== undefined) return next[offset + 1] === 2 ? '' : token
    if (string !== undefined || (declared !== undefined && inSelector) || (selected !== undefined && !inSelector)) return token
    if (query !== undefined) return token.replaceAll(QUERY_WORD, (word) => word.toLowerCase())
    return token.includes('+') ? '+' : token.toLowerCase()
  })
}

const code = (part, css) => (css ? squash(part).replaceAll(CSS_SPACE, '') : part.replaceAll(/\s/gu, '')).replaceAll(NUMBER, numberSpelling)

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i])
const textForm = (text, extension) => (extension === 'css' ? cssCase(text) : text).split(LITERAL[extension]).map((part, i) => (i % 2 ? literal(part) : code(part, extension === 'css')))

function parsed(text, extension) {
  const lang = extension === 'tsx' ? 'tsx' : /^[cm]?ts$/u.test(extension) ? 'ts' : 'jsx'
  const sourceType = extension.startsWith('m') ? 'module' : extension.startsWith('c') ? 'commonjs' : 'unambiguous'
  const result = getOxc().parseSync(`file.${extension}`, text, { lang, sourceType, preserveParens: false })
  return result.errors.length > 0 ? null : result
}

const comments = ({ comments: list }) => list.map(({ type, value }) => `${type} ${indentless(value)}`)
// `a && (b && c)` and `(a && b) && c` read alike, as do `||` and `??` chains.
const chain = (node, operator) => (node?.type === 'LogicalExpression' && node.operator === operator ? [...chain(node.left, operator), ...chain(node.right, operator)] : [node])
const fields = (node) => Object.keys(node).filter((key) => !POSITION.has(key) && !(node.type === 'Literal' && (key === 'raw' || key === 'regex' || (key === 'value' && node.regex))))
const flags = (regex) => [...regex.flags].toSorted().join('')

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
      if (x.type === 'Literal' && x.regex && (x.regex.pattern !== y.regex?.pattern || flags(x.regex) !== flags(y.regex))) return false
      pairs = [keys.map((key) => x[key]), keys.map((key) => y[key])]
    }
    if (pairs[0].length !== pairs[1].length) return false
    pairs[0].forEach((node, i) => work.push([node, pairs[1][i]]))
  }
  return true
}

// A safeguard on oxfmt's own output, not a comparison of any two texts: exported
// for tests alone, not by the package.
export function sameCode(text, formatted, extension = 'js') {
  if (!SCRIPTS.has(extension)) return Object.hasOwn(LITERAL, extension) && sameList(textForm(text, extension), textForm(formatted, extension))
  if (scriptForm(text) !== scriptForm(formatted)) return false
  const [before, after] = [parsed(text, extension), parsed(formatted, extension)]
  return before !== null && after !== null && sameList(comments(before), comments(after)) && sameTree(before.program, after.program)
}

// oxfmt is loaded outside the try: one missing is thrown, not taken for a file
// that won't format.
export async function formatChecked(text, extension) {
  const format = await loadFormatter()
  let result
  try {
    result = await format(`pretty.${extension}`, text, PRETTY_OPTIONS)
  } catch {
    return { error: 'unformattable' }
  }
  if (result.errors.length > 0) return { error: 'unformattable' }
  return sameCode(text, result.code, extension) ? { code: result.code } : { error: 'pretty-mismatch' }
}
