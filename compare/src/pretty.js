// A file formatted by oxfmt, its copy used only where two checks apart from
// oxfmt find it differs from the file in layout alone: the text in one form,
// comments and all, and for scripts the syntax tree, as oxc parses it.

import { getOxc } from '#oxc'
import { loadFormatter } from './oxfmt.js'

// What is written changed no more than layout needs: keys keep their quotes,
// no trailing commas or arrow parentheses are added, template literals stay.
export const PRETTY_OPTIONS = { quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off' }

const SCRIPTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'])
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu
const POSITION = new Set(['start', 'end', 'range', 'loc'])

// A number literal as the formatter spells it: lowercase, a leading zero, no
// `+`, leading zeros or zero exponent, nor trailing zeros or dot in a fraction.
function numberSpelling(literal) {
  const number = literal.toLowerCase()
  const parts = /^0[box]|n$/u.test(number) ? null : /^([^e]*)(?:e([+-]?)0*(\d+))?$/u.exec(number)
  if (!parts) return number
  const [, mantissa = '', sign = '', exponent = ''] = parts
  const fraction = (mantissa.startsWith('.') ? `0${mantissa}` : mantissa).replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
  return exponent === '' || /^0+$/u.test(exponent) ? fraction : `${fraction}e${sign === '-' ? '-' : ''}${exponent}`
}

// The text with what formatting may respell made alike: numbers, quotes,
// regular expressions' flags in order, no whitespace, parentheses or semicolons.
// CSS goes without quotes, which formatting adds to attribute selectors, and in lowercase.
function codeForm(text, css) {
  const form = text.replaceAll(NUMBER, numberSpelling).replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')
    .replaceAll(/(?<=\/)[dgimsuvy]{2,}(?![\p{L}\p{N}_$])/gu, (flags) => [...flags].toSorted().join(''))
  return css ? form.replaceAll('"', '').toLowerCase() : form
}

function program(text, extension) {
  const lang = extension === 'tsx' ? 'tsx' : /^[cm]?ts$/u.test(extension) ? 'ts' : 'jsx'
  const sourceType = extension.startsWith('m') ? 'module' : extension.startsWith('c') ? 'commonjs' : 'unambiguous'
  const result = getOxc().parseSync(`file.${extension}`, text, { lang, sourceType, preserveParens: false })
  return result.errors.length > 0 ? null : result.program
}

// `a && (b && c)` and `(a && b) && c` read alike, as do `||` and `??` chains.
const chain = (node, operator) => (node?.type === 'LogicalExpression' && node.operator === operator ? [...chain(node.left, operator), ...chain(node.right, operator)] : [node])
const fields = (node) => Object.keys(node).filter((key) => !POSITION.has(key) && !(node.type === 'Literal' && (key === 'raw' || (key === 'value' && node.regex))))
const flags = (regex) => [...regex.flags].toSorted().join('')

// Whether two syntax trees are one but for positions, how literals are
// spelled, same-operator chains' grouping and empty statements.
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
      pairs = [keys.filter((key) => key !== 'regex').map((key) => x[key]), keys.filter((key) => key !== 'regex').map((key) => y[key])]
    }
    if (pairs[0].length !== pairs[1].length) return false
    pairs[0].forEach((node, i) => work.push([node, pairs[1][i]]))
  }
  return true
}

export function sameCode(text, formatted, extension = 'js') {
  const css = extension === 'css'
  if (codeForm(text, css) !== codeForm(formatted, css)) return false
  if (!SCRIPTS.has(extension)) return true
  const [before, after] = [program(text, extension), program(formatted, extension)]
  return before !== null && after !== null && sameTree(before, after)
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
