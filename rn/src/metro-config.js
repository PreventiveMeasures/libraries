// A metro.config.js's assetExts, read off it, never run, for what must not
// run it (stasis): rn-bundle and rn-serve load it, as Metro does
// (metro-options.js).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'

const LIST_METHODS = new Set(['concat', 'filter', 'slice'])

function walk(node, fn) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn)
  } else if (typeof node?.type === 'string') {
    fn(node)
    for (const child of Object.values(node)) walk(child, fn)
  }
}

const string = (node) => (node.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked
  : null)
const method = (node) => (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : undefined)
const named = (node) => (node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' && !node.computed ? node.property.name : undefined)

// Strings only: what it spreads in is Metro's defaults.
export function metroAssetExts(program) {
  const declarators = []
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) declarators.push(node)
  })
  const inits = Map.groupBy(declarators, ({ id }) => id.name)
  const exts = new Set()
  const seen = new Set()
  // `list`: whether `node` is a list of extensions or one of them.
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
      readEach(node.elements)
    } else if (list && LIST_METHODS.has(method(node))) {
      read(node.callee.object, true)
      if (method(node) === 'concat') for (const arg of node.arguments) read(arg, true)
    } else if (string(node) !== null) {
      exts.add(string(node))
    }
  }
  const readEach = (nodes) => {
    for (const node of nodes) {
      if (node?.type === 'SpreadElement') read(node.argument, true)
      else read(node, false)
    }
  }
  walk(program, (node) => {
    const [name, value] = node.type === 'Property' && !node.computed ? [node.key.name ?? node.key.value, node.value]
      : node.type === 'VariableDeclarator' ? [named(node.id), node.init]
      : node.type === 'AssignmentExpression' ? [named(node.left), node.right]
      : []
    if (name === 'assetExts') read(value, true)
    else if (['push', 'unshift'].includes(method(node)) && named(node.callee.object) === 'assetExts') readEach(node.arguments)
  })
  return [...exts]
}

const SPREAD_AND_STRINGS = /assetExts\s*:\s*\[\s*\.\.\.[\w$.?]+\.assetExts((?:\s*,\s*(?:'[\w.-]+'|"[\w.-]+"))*)\s*,?\s*\]/gu

// A mention possibly in a string, a comment or a template, which only a
// parser can tell.
const unclear = (before) => /['"`/]/u.test(before.slice(before.lastIndexOf('\n') + 1))
  || before.lastIndexOf('/*') > before.lastIndexOf('*/')
  || before.split('`').length % 2 === 0

// Any other mention of assetExts could change the list in ways only a parser sees.
export function scanMetroAssetExts(source) {
  const exts = []
  const rest = source.replaceAll(SPREAD_AND_STRINGS, (match, strings, index) => {
    if (unclear(source.slice(0, index))) return match
    exts.push(...(strings.match(/[\w.-]+/gu) ?? []))
    return ''
  })
  return rest.includes('assetExts') ? null : [...new Set(exts)]
}

const tryResolve = (from, name) => {
  try {
    return from.resolve(name)
  } catch {
    return null
  }
}

// oxc-parser, the project's, else the one beside rn/; null where neither is.
function locateOxc(projectRoot) {
  const path = tryResolve(createRequire(resolve(projectRoot, 'package.json')), 'oxc-parser') ?? tryResolve(createRequire(import.meta.url), 'oxc-parser')
  return path === null ? null : createRequire(import.meta.url)(path)
}

// Metro's asset extensions, and those the project's metro.config.js (`file`,
// from the project, where given) adds, read off it, never run: by its AST
// with oxc-parser (`oxc`, its module; the project's, else the one beside rn/,
// where not given; none where null), else in the one form a regex reads.
// Metro's defaults alone where there's no metro.config.js; throws where
// `file` isn't there, or only a parser reads it and there's none.
export function readMetroAssetExts(projectRoot, { file = null, oxc } = {}) {
  const config = resolve(projectRoot, file ?? 'metro.config.js')
  if (!existsSync(config)) {
    if (file === null) return [...defaults.assetExts]
    throw new Error(`no such Metro config: ${file}`)
  }
  const source = readFileSync(config, 'utf8')
  const parser = oxc === undefined ? locateOxc(projectRoot) : oxc
  const listed = parser === null ? scanMetroAssetExts(source) : metroAssetExts(parser.parseSync(config, source, { sourceType: 'unambiguous' }).program)
  if (listed === null) throw new Error(`reading the assetExts of ${file ?? 'metro.config.js'} needs oxc-parser: npm i -D oxc-parser`)
  return [...defaults.assetExts, ...listed]
}
