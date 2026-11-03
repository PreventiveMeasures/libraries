// Checks each import by name of an ES module as esbuild's linker does where it links them (bundle.js
// with `esm`), for the builds it doesn't link: a dev bundle's modules, each built alone, and a build whose
// modules Babel makes CommonJS for inline requires. An import of a name an ES module doesn't export,
// following its `export *`s, is a warning, the import undefined, as in Metro. Not of a module whose
// exports aren't known (CommonJS, or one exporting all of such a module), nor in a TS file, where it may
// be of a type, as esbuild has it.

import { extname } from 'node:path'

import { posixRelative } from './build-host.js'

const TS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const escaped = (text) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&')

// The warnings of the build's imports: `modules`, each ES module's { imports, exports, stars, commonJs? }
// by path (babel-transformer.js's esModuleOf()); `graph`, how the build resolved each import (build-host.js's
// state.graph); `source(path)`, a file's text, or null, for a warning's location.
export function unmatchedImports({ modules, graph, projectRoot, source }) {
  const targetOf = (importer, specifier) => {
    const resolution = graph.get(importer)?.get(specifier)
    return resolution?.type === 'sourceFile' ? resolution.filePath : null
  }
  // The names a module exports: its own, and those but `default` of each module it reaches through its
  // `export *`s, through any cycle of them; null where it may export any (one of them CommonJS, or unknown).
  const known = new Map()
  const exportsOf = (path) => {
    if (!known.has(path)) known.set(path, reachedOf(path))
    return known.get(path)
  }
  const reachedOf = (path) => {
    const module = modules.get(path)
    if (module === undefined || module.commonJs) return null
    const names = new Set(module.exports)
    const seen = new Set([path])
    const queue = [path]
    while (queue.length > 0) {
      const from = queue.pop()
      for (const star of modules.get(from).stars) {
        const target = targetOf(from, star)
        const reached = target === null ? undefined : modules.get(target)
        if (reached === undefined || reached.commonJs) return null
        if (seen.has(target)) continue
        seen.add(target)
        queue.push(target)
        for (const name of reached.exports) if (name !== 'default') names.add(name)
      }
    }
    return names
  }
  const warnings = []
  for (const [importer, module] of modules) {
    if (TS.has(extname(importer))) continue
    for (const { specifier, names } of module.imports) {
      const target = targetOf(importer, specifier)
      const exported = target === null ? null : exportsOf(target)
      for (const name of exported === null ? [] : names) {
        if (!exported.has(name)) warnings.push({ text: `No matching export in ${JSON.stringify(posixRelative(projectRoot, target))} for import ${JSON.stringify(name)}: the import is undefined, as in Metro`, location: locationOf(projectRoot, importer, specifier, name, source) })
      }
    }
  }
  return warnings.toSorted((a, b) => a.location.file.localeCompare(b.location.file) || (a.location.line ?? 0) - (b.location.line ?? 0) || a.text.localeCompare(b.text))
}

// Where a file names the module it imports `name` of: in the first statement that names both (not an import
// of a type alone), else the first that names the module; as esbuild locates a message.
function locationOf(projectRoot, path, specifier, name, source) {
  const file = posixRelative(projectRoot, path)
  const text = source(path)
  const found = text === null ? [] : [...text.matchAll(new RegExp(`(["'])${escaped(specifier)}\\1`, 'gu'))]
  if (found.length === 0) return { file }
  const statement = (match) => text.slice(Math.max(text.lastIndexOf('import', match.index), text.lastIndexOf('export', match.index), 0), match.index)
  const naming = new RegExp(`(?<![\\w$])${escaped(name)}(?![\\w$])`, 'u')
  const at = found.find((match) => naming.test(statement(match)) && !/^(?:import|export)\s+type(?:of)?\s/u.test(statement(match))) ?? found[0]
  const before = text.slice(0, at.index)
  const start = before.lastIndexOf('\n') + 1
  const end = text.indexOf('\n', at.index)
  return { file, line: before.split('\n').length, column: at.index - start, length: at[0].length, lineText: text.slice(start, end === -1 ? undefined : end) }
}
