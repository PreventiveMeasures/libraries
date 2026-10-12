// Two style sheets alike but for layout, as css-tree reads them: one tree but for the ASCII case of what
// CSS reads in any case (properties, at-rules, pseudo-classes, units, `!important`, hex colors where the
// property's grammar takes them), zeros in a number that change neither its value nor its type
// (`.50` as `0.5`), an attribute's value quoted, and comments' indentation.

// A comment but for its lines' indentation, which formatting changes.
export const indentless = (text) => text.replaceAll(/(?<![ \t])[ \t]*\r?\n[ \t]*/gu, '\n')

const FOLDED = new Set(['Declaration.property', 'Atrule.name', 'Dimension.unit', 'PseudoClassSelector.name', 'PseudoElementSelector.name'])
const NUMBERS = new Set(['Number', 'Dimension', 'Percentage'])

// A number as written but for the zeros formatting adds before its point and drops after its last
// digit (`.50` as `0.5`), one digit kept after the point (`1.00` as `1.0`), as `1` is an integer.
const numberForm = (number) => number.replace(/^(?<sign>[+-]?)\./u, '$<sign>0.').replace(/^(?<kept>[+-]?\d*\.\d+?)0+(?!\d)/u, '$<kept>')
const lower = (text) => text.replaceAll(/[A-Z]+/gu, (upper) => upper.toLowerCase())

// A custom property's value, read as written but for CSS's own blanks at either end and its numbers in that form.
function raw(csstree, value) {
  const { Dimension: dimension, Number: number, Percentage: percentage } = csstree.tokenTypes
  let at = 0, form = ''
  csstree.tokenize(value, (type, start, end) => {
    if (type !== number && type !== percentage && type !== dimension) return
    form += value.slice(at, start) + numberForm(value.slice(start, end))
    at = end
  })
  return (form + value.slice(at)).replaceAll(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '')
}

// The hex colors among a sheet's declarations, as each known property's grammar matches its value:
// matched only where one holds a capital, the one case folding changes, as matching is slow.
function colorsOf(csstree, tree) {
  const colors = new Set()
  csstree.walk(tree, { visit: 'Declaration', enter(declaration) {
    if (!csstree.lexer.getProperty(declaration.property)) return
    const hashes = []
    csstree.walk(declaration.value, { visit: 'Hash', enter: (hash) => /[A-Z]/u.test(hash.value) && hashes.push(hash) })
    if (hashes.length === 0) return
    const match = csstree.lexer.matchProperty(declaration.property, declaration.value)
    if (match.matched) for (const hash of hashes) if (match.isType(hash, 'hex-color')) colors.add(hash)
  } })
  return colors
}

// A sheet's tree and comments in one form; null where css-tree finds an error.
function read(csstree, text) {
  const comments = []
  let failed = false
  const tree = csstree.parse(text, { positions: false, parseCustomProperty: false, onComment: (value) => comments.push(indentless(value)), onParseError: () => { failed = true } })
  if (failed) return null
  const colors = colorsOf(csstree, tree)
  return JSON.stringify([tree, comments], function form(key, value) {
    if (key === 'loc') return undefined
    // An attribute's unquoted value is the string it spells, unless it holds an escape: css-tree
    // decodes those in strings alone.
    if (key === 'value' && this.type === 'AttributeSelector' && value?.type === 'Identifier' && !value.name.includes('\\')) return { type: 'String', value: value.name }
    if (typeof value !== 'string') return value
    if (this.type === 'Declaration' && key === 'important') return lower(value) === 'important' || value
    if (FOLDED.has(`${this.type}.${key}`) && !value.startsWith('--')) return lower(value)
    if (key !== 'value') return value
    if (this.type === 'Hash' && colors.has(this)) return lower(value)
    if (NUMBERS.has(this.type)) return numberForm(value)
    return this.type === 'Raw' ? raw(csstree, value) : value
  })
}

// What css-tree throws on is format's to refuse.
export function sameCss(csstree, text, formatted) {
  const before = read(csstree, text)
  return before !== null && before === read(csstree, formatted)
}
