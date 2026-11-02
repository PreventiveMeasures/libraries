// Comments attached to an AST's nodes as @babel/parser attaches them as it
// parses, replayed on the AST it would make (oxc-babel.js).

// What @babel/parser skips between tokens, but comments.
export const isSpace = (code) =>
  code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff

// Where a list closing at `close` ends with a comma, past space and comments
// (`commentStarts`, each comment's start by its end): its index, else -1.
export function trailingComma(code, commentStarts, close) {
  let i = close - 1
  for (;;) {
    while (i >= 0 && isSpace(code.codePointAt(i))) i--
    const start = commentStarts.get(i + 1)
    if (start === undefined) break
    i = start - 1
  }
  return code.codePointAt(i) === 44 ? i : -1
}

// The lists of a node a comment after a comma goes with.
const LISTS = {
  ObjectExpression: 'properties',
  ObjectPattern: 'properties',
  CallExpression: 'arguments',
  NewExpression: 'arguments',
  OptionalCallExpression: 'arguments',
  ImportExpression: 'source',
  FunctionDeclaration: 'params',
  FunctionExpression: 'params',
  ArrowFunctionExpression: 'params',
  ObjectMethod: 'params',
  ClassMethod: 'params',
  ClassPrivateMethod: 'params',
  ArrayExpression: 'elements',
  ArrayPattern: 'elements',
  ExportNamedDeclaration: 'specifiers',
  ImportDeclaration: 'specifiers',
}

function add(node, key, comments) {
  if (node[key] === undefined) node[key] = comments
  else node[key].unshift(...comments)
}

// Babel's finalizeComment.
function finalize(code, { start, comments, leadingNode, trailingNode, containingNode: node }) {
  if (leadingNode !== null || trailingNode !== null) {
    if (leadingNode !== null) add(leadingNode, 'trailingComments', comments)
    if (trailingNode !== null) add(trailingNode, 'leadingComments', comments)
    return
  }
  const elements = LISTS[node.type]
  if (code.codePointAt(start - 1) !== 44 || elements === undefined) return add(node, 'innerComments', comments)
  // After a comma: the last element's, if before it.
  const list = node.type === 'ImportExpression' ? [node.source, node.options ?? null] : node[elements]
  let last = null
  for (let i = list.length - 1; last === null && i >= 0; i--) last = list[i]
  if (last === null || last.start > start) add(node, 'innerComments', comments)
  else add(last, 'trailingComments', comments)
}

// Each run of comments, with the space around them: from the token before
// to the token after.
function runsOf(code, comments, after, locate) {
  const all = []
  const runs = []
  for (const { type, value, start, end } of comments) {
    if (end <= after) continue
    const comment = locate({ type: type === 'Line' ? 'CommentLine' : 'CommentBlock', value, start, end })
    all.push(comment)
    let run = runs.at(-1)
    if (run !== undefined && run.end === start) run.comments.push(comment)
    else {
      let before = start
      while (before > after && isSpace(code.codePointAt(before - 1))) before--
      run = { start: before, end, comments: [comment], leadingNode: null, trailingNode: null, containingNode: null }
      runs.push(run)
    }
    run.end = end
    while (run.end < code.length && isSpace(code.codePointAt(run.end))) run.end++
  }
  return { all, runs }
}

// (code, comments, after, finished, ends, locate) -> the comments, as Babel
// has them, each attached to the node that ends where its run starts (one
// of its trailing comments) and to the one that starts where it ends (its
// leading ones), else to the smallest node around it (its inner ones):
// replayed as Babel finishes each node, in `finished` (`ends`, the end of one
// that Babel finishes before it ends; a parenthesized node, the parentheses
// after it), with the runs lexed by then, past the token it ends with.
// `after`, where the code starts, past its hashbang; `locate`, the loc of a
// comment.
export function attachComments(code, comments, after, finished, ends, locate) {
  const { all, runs } = runsOf(code, comments, after, locate)
  if (runs.length === 0) return all
  const stack = []
  let lexed = 0
  const lex = (upTo) => {
    while (lexed < runs.length && runs[lexed].start <= upTo) stack.push(runs[lexed++])
  }
  for (const node of finished) {
    if (node.around !== undefined) {
      // Babel's takeSurroundingComments, of a parenthesized node.
      lex(node.end)
      for (let i = stack.length - 1; i >= 0; i--) {
        const run = stack[i]
        if (run.start === node.end) run.leadingNode = node.around
        else if (run.end === node.start) run.trailingNode = node.around
        else if (run.end < node.start) break
      }
      continue
    }
    // Babel's processComment.
    const end = ends.get(node) ?? node.end
    lex(end)
    let i = stack.length - 1
    if (i >= 0 && stack[i].start === end) stack[i--].leadingNode = node
    for (; i >= 0; i--) {
      const run = stack[i]
      if (run.end <= node.start) {
        if (run.end === node.start) run.trailingNode = node
        break
      }
      run.containingNode = node
      finalize(code, run)
      stack.splice(i, 1)
    }
  }
  return all
}
