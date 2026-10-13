// What Node's type stripping erases of TypeScript, as oxc's syntax tree has it, and what a text it
// stripped may hold: Node reads a `.d.ts` as the `.ts` it is named and runs what it does not erase,
// so a declaration file runs nothing only where stripping leaves nothing to run. Nothing here
// parses; types.node.js gives both the tree and Node's text.

// What stripping makes of a statement: nothing (`erased`); `export {}` or `export as namespace N`,
// which import and run nothing (`inert`); a statement that loads a module (`imports`); or code.
export const CODE = 'code', ERASED = 'erased', IMPORT = 'imports', INERT = 'inert'

const TYPES = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'])

// A namespace not declared is erased where TypeScript emits nothing for it: it holds interfaces,
// type aliases and such namespaces alone, exported or not. One declared within it is held to the
// same, as Node holds it: `namespace N { declare namespace M { const x = 1 } }` is refused.
function typesAlone(namespace) {
  if (namespace.kind !== 'namespace') return false
  if (namespace.body?.type === 'TSModuleDeclaration') return typesAlone(namespace.body)
  if (namespace.body?.type !== 'TSModuleBlock') return false
  return namespace.body.body.every((statement) => {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    return TYPES.has(node?.type) || (node?.type === 'TSModuleDeclaration' && typesAlone(node))
  })
}

// A declaration erased whole: a type, an interface, a function's signature, anything `declare`d
// (its initializers and bodies with it), a namespace of types. A decorator is code, kept where
// the class it decorates is erased (`@d declare class A {}` leaves `@d`).
function erased(node) {
  switch (node.type) {
    case 'TSInterfaceDeclaration': case 'TSTypeAliasDeclaration': case 'TSDeclareFunction': return true
    case 'VariableDeclaration': case 'TSEnumDeclaration': return node.declare === true
    case 'ClassDeclaration': return node.declare === true && !(node.decorators?.length > 0)
    case 'TSModuleDeclaration': return node.declare === true || typesAlone(node)
    default: return false
  }
}

// A statement of a program's, as stripping leaves it. `import { type A }` from a module loads it, as
// stripping leaves `import {}` from it; `export { type A }` leaves `export {}`.
export function strippedAs(statement) {
  switch (statement.type) {
    case 'ImportDeclaration': return statement.importKind === 'type' ? ERASED : IMPORT
    case 'ExportAllDeclaration': return statement.exportKind === 'type' ? ERASED : IMPORT
    case 'TSImportEqualsDeclaration':
      if (statement.importKind === 'type') return ERASED
      return statement.moduleReference.type === 'TSExternalModuleReference' ? IMPORT : CODE
    case 'ExportNamedDeclaration':
      if (statement.declaration) return erased(statement.declaration) ? ERASED : strippedAs(statement.declaration)
      if (statement.exportKind === 'type') return ERASED
      if (statement.source) return IMPORT
      return statement.specifiers.every((specifier) => specifier.exportKind === 'type') ? INERT : CODE
    case 'ExportDefaultDeclaration': return statement.declaration.type === 'TSInterfaceDeclaration' || statement.declaration.type === 'TSDeclareFunction' ? ERASED : CODE
    case 'TSNamespaceExportDeclaration': return INERT
    default: return erased(statement) ? ERASED : CODE
  }
}

// What a stripped text may hold, read token by token as no parser reads it: blanks and line breaks
// (JavaScript's, `\s`), comments, a hashbang first, and the inert statements, a name in them ASCII.
const LINE_END = /[\n\r\u2028\u2029]/gu
const BLANK = /\s/u
const INERT_FORMS = [
  [/export(?![\w$])/uy, /\{/uy, /\}/uy],
  [/export(?![\w$])/uy, /as(?![\w$])/uy, /namespace(?![\w$])/uy, /[A-Za-z_$][\w$]*(?![\w$])/uy],
]

function lineEnd(text, at) {
  LINE_END.lastIndex = at
  return LINE_END.test(text) ? LINE_END.lastIndex - 1 : text.length
}

// Past blanks and comments; an unclosed comment stays, for what follows to refuse.
function skip(text, at) {
  for (;;) {
    const close = text.startsWith('/*', at) ? text.indexOf('*/', at + 2) : -1
    if (BLANK.test(text[at] ?? '')) at++
    else if (text.startsWith('//', at)) at = lineEnd(text, at)
    else if (close === -1) return at
    else at = close + 2
  }
}

function inertEnd(text, from) {
  for (const form of INERT_FORMS) {
    let at = from
    for (const token of form) {
      token.lastIndex = skip(text, at)
      at = token.test(text) ? token.lastIndex : -1
      if (at === -1) break
    }
    if (at === -1) continue
    const semicolon = skip(text, at)
    return text[semicolon] === ';' ? semicolon + 1 : at
  }
  return -1
}

// Where a stripped text first holds anything else, or -1 where it holds nothing else.
export function leftover(text) {
  let at = text.startsWith('#!') ? lineEnd(text, 0) : 0
  for (;;) {
    at = skip(text, at)
    if (at === text.length) return -1
    const end = inertEnd(text, at)
    if (end === -1) return at
    at = end
  }
}
