// A file formatted by oxfmt, used only where checks apart from oxfmt find it
// differs in layout alone: strings and comments as written, the rest as
// formatting may respell it, and a script's syntax tree as oxc parses it.

import { getOxc } from '#oxc'
import { loadFormatter } from './oxfmt.js'

export const PRETTY_OPTIONS = { quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off' }

const SCRIPTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'])
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu
const POSITION = new Set(['start', 'end', 'range', 'loc'])
// Strings and comments, which are compared as written, split from the rest. CSS's
// unquoted attribute values count as strings, as formatting quotes them.
const LITERAL = {
  css: /("(?:[^"\\\n]|\\[^])*"|'(?:[^'\\\n]|\\[^])*'|\/\*[^]*?\*\/|(?<==\s*)-?[_a-z\u00A0-\uFFFF][-\w\u00A0-\uFFFF]*(?=\s*(?:[is]\s*)?\]))/iu,
  json: /("(?:[^"\\\n]|\\[^])*"|\/\*[^]*?\*\/|\/\/.*)/u,
}
// A space in CSS is kept between two characters a selector may hold, as in `.a .b`.
const CSS_SPACE = /(?<![-\w\u00A0-\uFFFF%)\]*\\]) | (?![-\w\u00A0-\uFFFF.#:[(*&\\])|(?<=@[-\w]+) (?=\()|(?<=[)\]]) (?=[-\w]+\()/gu

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

// Formatting may change a string's quotes and a comment's indentation alone.
function literal(token) {
  if (token.startsWith('/')) return squash(token)
  return /^["']/u.test(token) ? `"${token.slice(1, -1).replaceAll(/\\(?=["'])/gu, '')}"` : `"${token}"`
}

// Formatting lowercases CSS's keywords and ends a block's last declaration with `;`.
function code(part, css) {
  const form = (css ? squash(part).replaceAll(CSS_SPACE, '').replaceAll(/;(?=\})/gu, '') : part.replaceAll(/\s/gu, '')).replaceAll(NUMBER, numberSpelling)
  return css ? form.toLowerCase() : form
}

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i])
const textForm = (text, extension) => text.split(LITERAL[extension]).map((part, i) => (i % 2 ? literal(part) : code(part, extension === 'css')))

function parsed(text, extension) {
  const lang = extension === 'tsx' ? 'tsx' : /^[cm]?ts$/u.test(extension) ? 'ts' : 'jsx'
  const sourceType = extension.startsWith('m') ? 'module' : extension.startsWith('c') ? 'commonjs' : 'unambiguous'
  const result = getOxc().parseSync(`file.${extension}`, text, { lang, sourceType, preserveParens: false })
  return result.errors.length > 0 ? null : result
}

const comments = ({ comments: list }) => list.map(({ type, value }) => `${type} ${squash(value)}`)
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
