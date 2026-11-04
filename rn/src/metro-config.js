// Reads a metro.config.js's assetExts from its source, without running it (which needs Metro).
// Pure: asset-exts.js reads the files.

const LIST_METHODS = new Set(['concat', 'filter', 'slice'])

function walk(node, fn) {
  const isNode = typeof node?.type === 'string'
  if (isNode) fn(node)
  if (isNode || Array.isArray(node)) for (const child of Object.values(node)) walk(child, fn)
}

const string = (node) => (node.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked
  : null)
const method = (node) => (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : undefined)
const named = (node) => (node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' && !node.computed ? node.property.name : undefined)

// The extensions a config's AST adds to assetExts; what it spreads in is taken as Metro's defaults.
export function metroAssetExts(program) {
  const declarators = []
  // What assetExts is set to, and what is pushed to it, as an array of those elements.
  const lists = []
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) declarators.push(node)
    const [name, value] = node.type === 'Property' && !node.computed ? [node.key.name ?? node.key.value, node.value]
      : node.type === 'VariableDeclarator' ? [named(node.id), node.init]
      : node.type === 'AssignmentExpression' ? [named(node.left), node.right]
      : []
    if (name === 'assetExts') {
      lists.push(value)
    } else if (['push', 'unshift'].includes(method(node)) && named(node.callee.object) === 'assetExts') {
      lists.push({ type: 'ArrayExpression', elements: node.arguments })
    }
  })
  const inits = Map.groupBy(declarators, ({ id }) => id.name)
  const exts = new Set()
  const seen = new Set()
  // `list`: whether `node` is a list of extensions rather than one.
  const read = (node, list) => {
    if (!node || seen.has(node)) return
    seen.add(node)
    if (node.type === 'ParenthesizedExpression') {
      read(node.expression, list)
    } else if (node.type === 'Identifier') {
      for (const { init } of inits.get(node.name) ?? []) read(init, list)
    } else if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      for (const side of node.type === 'LogicalExpression' ? [node.left, node.right] : [node.consequent, node.alternate]) read(side, list)
    } else if (list && node.type === 'ArrayExpression') {
      for (const element of node.elements) {
        const spread = element?.type === 'SpreadElement'
        read(spread ? element.argument : element, spread)
      }
    } else if (list && LIST_METHODS.has(method(node))) {
      read(node.callee.object, true)
      if (method(node) === 'concat') for (const arg of node.arguments) read(arg, true)
    } else if (string(node) !== null) {
      exts.add(string(node))
    }
  }
  for (const list of lists) read(list, true)
  return [...exts]
}

const SPREAD_AND_STRINGS = /assetExts\s*:\s*\[\s*\.\.\.[\w$.?]+\.assetExts((?:\s*,\s*(?:'[\w.-]+'|"[\w.-]+"))*)\s*,?\s*\]/gu

// Whether a match may sit in a string, comment or template, which only a parser can tell.
const unclear = (before) => /['"`/]/u.test(before.slice(before.lastIndexOf('\n') + 1))
  || before.lastIndexOf('/*') > before.lastIndexOf('*/')
  || before.split('`').length % 2 === 0

// The regex fallback: reads only `assetExts: [...x.assetExts, 'ext', ...]`, and gives null if
// assetExts is mentioned anywhere else, as that could change the list in ways only a parser sees.
export function scanMetroAssetExts(source) {
  const exts = []
  const rest = source.replaceAll(SPREAD_AND_STRINGS, (match, strings, index) => {
    if (unclear(source.slice(0, index))) return match
    exts.push(...(strings.match(/[\w.-]+/gu) ?? []))
    return ''
  })
  return rest.includes('assetExts') ? null : [...new Set(exts)]
}
