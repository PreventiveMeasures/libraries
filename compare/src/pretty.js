// A file formatted by oxfmt, used only where checks apart from oxfmt find it differs in layout
// alone: a script's syntax tree as oxc parses it, a style sheet's as css-tree does (an optional peer,
// CSS refused without it), JSON's strings and comments as written.

import { getOxc } from '#oxc'
import { indentless, sameCss } from './css.js'
import { loadCssTree } from './csstree.js'
import { loadFormatter } from './oxfmt.js'

const PRETTY_OPTIONS = { quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off' }

const SCRIPTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'])
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu
const POSITION = new Set(['start', 'end', 'range', 'loc'])
// JSON's strings and comments, compared as written, split from the rest; one unclosed runs to the end.
const LITERAL = /("(?:[^"\\\n]|\\[^])*"|\/\*[^]*?(?:\*\/|$)|\/\/.*)/u

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

const scriptForm = (text) => text.replaceAll(NUMBER, numberSpelling).replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')
  .replaceAll(/(?<=\/)[dgimsuvy]{2,}(?![\p{L}\p{N}_$])/gu, (flags) => [...flags].toSorted().join(''))

const jsonForm = (text) => text.split(LITERAL).map((part, i) => (i % 2 ? (part.startsWith('/') ? indentless(part) : part) : part.replaceAll(/\s/gu, '').replaceAll(NUMBER, numberSpelling)))
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i])

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
// for tests alone, not by the package. CSS is read by `csstree` where given.
export function sameCode(text, formatted, extension = 'js', csstree = null) {
  if (extension === 'css') return csstree !== null && sameCss(csstree, text, formatted)
  if (extension === 'json') return sameList(jsonForm(text), jsonForm(formatted))
  if (!SCRIPTS.has(extension) || scriptForm(text) !== scriptForm(formatted)) return false
  const [before, after] = [parsed(text, extension), parsed(formatted, extension)]
  return before !== null && after !== null && sameList(comments(before), comments(after)) && sameTree(before.program, after.program)
}

// Only what can be checked is formatted: scripts, JSON, and CSS where css-tree is there to read it.
// oxfmt is loaded outside the try: one missing is thrown, not taken for a file that won't format.
export async function format(text, extension) {
  const csstree = extension === 'css' ? await loadCssTree() : null
  if (!(SCRIPTS.has(extension) || extension === 'json' || csstree)) return { error: 'unsupported' }
  const oxfmt = await loadFormatter()
  let result
  try {
    result = await oxfmt(`pretty.${extension}`, text, PRETTY_OPTIONS)
  } catch {
    return { error: 'unformattable' }
  }
  if (result.errors.length > 0) return { error: 'unformattable' }
  return sameCode(text, result.code, extension, csstree) ? { code: result.code } : { error: 'pretty-mismatch' }
}
