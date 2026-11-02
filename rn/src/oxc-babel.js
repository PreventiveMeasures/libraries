// oxc-parser's AST (ESTree) of JS and JSX, as @babel/parser makes it of the
// same code: what a Babel plugin's parserOverride may return in its place.
// Comments are attached to nodes as @babel/parser attaches them, which its
// generator reads (a parenthesized node's, a `return` argument's) even where
// it prints none (babel-comments.js).

import { attachComments } from './babel-comments.js'
import { MODULE_NODES } from './oxc-babel-modules.js'
import { NODES as OWN, Unconverted, directives } from './oxc-babel-nodes.js'

export { Unconverted } from './oxc-babel-nodes.js'

const NODES = new Map([...OWN, ...MODULE_NODES])

const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/gu

// -> (index) => its line, column and index, as @babel/parser has them.
function positions(code) {
  const lineStarts = [0]
  for (const { index, 0: lineBreak } of code.matchAll(LINE_BREAK)) lineStarts.push(index + lineBreak.length)
  lineStarts.push(Infinity)
  let line = 0
  return (index) => {
    // Nodes come mostly in order: from the line of the last one, else searched.
    if (index < lineStarts[line] || index >= lineStarts[line + 1]) {
      let lo = 0
      let hi = lineStarts.length - 2
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= index) lo = mid
        else hi = mid - 1
      }
      line = lo
    }
    return { line: line + 1, column: index - lineStarts[line], index }
  }
}

// What each node's conversion (NODES) shares of the file: each node, as
// Babel finishes it, in `finished`, and where Babel's end of it then isn't
// yet its own, that end, in `ends`.
function context(code, comments, options) {
  const position = positions(code)
  const c = {
    ...options,
    code,
    commentStarts: new Map(comments.map(({ start, end }) => [end, start])),
    finished: [],
    ends: new Map(),
    functions: 0,
    chains: 0,
    topLevelAwait: false,
    locate: (node) => {
      node.loc = { start: position(node.start), end: position(node.end), filename: undefined, identifierName: undefined }
      return node
    },
    create: (type, start, end) => c.locate({ type, start, end }),
    finish: (node) => {
      c.finished.push(node)
      return node
    },
    convert: (node) => {
      const convert = NODES.get(node.type)
      if (convert === undefined) throw new Unconverted(node.type)
      return convert(node, c)
    },
    list: (nodes) => {
      for (let i = 0; i < nodes.length; i++) if (nodes[i] !== null) nodes[i] = c.convert(nodes[i])
      return nodes
    },
    maybe: (node) => (node === null || node === undefined ? null : c.convert(node)),
    children: (node, keys) => {
      for (const key of keys) {
        const value = node[key]
        if (Array.isArray(value)) c.list(value)
        else if (value !== null && value !== undefined) node[key] = c.convert(value)
      }
    },
  }
  return c
}

// (program, comments, code, { sourceType, flow, importExpressions }) -> a
// File, as @babel/parser makes it with those options: `flow`, its flow
// plugin's on (which adds fields of its own: a class property's `variance`,
// an import's `importKind`); `importExpressions`, its createImportExpressions.
// `program` and `comments` are oxc-parser's of `code`, parsed with
// preserveParens, and are taken apart. Throws Unconverted where the AST has
// what isn't converted.
export function babelFile(program, comments, code, { sourceType = 'module', flow = false, importExpressions = false } = {}) {
  const c = context(code, comments, { flow, importExpressions })
  const { hashbang } = program
  const after = hashbang === null || hashbang === undefined ? 0 : hashbang.end
  // `<!--` and `-->`, which Babel reads in a module, then takes for a script's.
  for (const { start } of comments) if (start >= after && code.codePointAt(start) !== 47) throw new Unconverted('HTML comment')
  let interpreter = null
  if (after > 0) {
    interpreter = c.create('InterpreterDirective', hashbang.start, hashbang.end)
    interpreter.value = hashbang.value
    c.finish(interpreter)
  }
  const found = directives(program.body, c)
  const body = c.list(program.body)
  // Babel takes an await outside a function for ESM, else for an identifier.
  if (c.topLevelAwait) throw new Unconverted('top-level await')
  const babel = c.create('Program', 0, code.length)
  babel.sourceType = program.sourceType
  babel.interpreter = interpreter
  babel.body = body
  babel.directives = found
  // As Babel has it of a file it parses as a module, if only to try it.
  if (sourceType !== 'script') babel.extra = { topLevelAwait: false }
  c.finish(babel)
  const file = c.create('File', 0, code.length)
  file.errors = []
  file.program = babel
  file.comments = attachComments(code, comments, after, c.finished, c.ends, c.locate)
  return file
}
