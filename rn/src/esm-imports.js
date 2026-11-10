// Checks named imports against their module's exports as esbuild's linker does, for builds it doesn't link
// (dev bundles, and CommonJS for inline requires): a missing export warns, the import undefined as in Metro.
// As in esbuild, modules of unknown exports (CommonJS) and TS files are not checked.

import { extname } from 'node:path'

import { posixRelative } from './build-host.js'

const TS = new Set(['.ts', '.tsx', '.mts', '.cts'])

// `modules`: esModuleOf()'s records by path; `graph`: build-host.js's state.graph; `source(path)`: a
// file's text or null, to locate warnings.
export function unmatchedImports({ modules, graph, projectRoot, source }) {
  const targetOf = (importer, specifier) => {
    const resolution = graph.get(importer)?.get(specifier)
    return resolution?.type === 'sourceFile' ? resolution.filePath : null
  }
  // A module's exports, following `export *` (less `default`) through cycles; null where a module reached
  // is CommonJS or unknown, so it may export anything.
  const known = new Map()
  const exportsOf = (path) => {
    if (!known.has(path)) known.set(path, reachedOf(path))
    return known.get(path)
  }
  const reachedOf = (path) => {
    const module = modules.get(path)
    if (module === undefined || module.commonJs) return null
    const names = new Set(module.exports)
    // Grows as it is iterated.
    const seen = new Set([path])
    for (const from of seen) {
      for (const star of modules.get(from).stars) {
        const target = targetOf(from, star)
        const reached = modules.get(target)
        if (reached === undefined || reached.commonJs) return null
        if (seen.has(target)) continue
        seen.add(target)
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
      const exported = exportsOf(target)
      if (exported === null) continue
      for (const name of names) {
        if (!exported.has(name)) warnings.push({ text: `No matching export in ${JSON.stringify(posixRelative(projectRoot, target))} for import ${JSON.stringify(name)}: the import is undefined, as in Metro`, location: locationOf(projectRoot, importer, specifier, name, source) })
      }
    }
  }
  return warnings.toSorted((a, b) => a.location.file.localeCompare(b.location.file) || (a.location.line ?? 0) - (b.location.line ?? 0) || a.text.localeCompare(b.text))
}

// As esbuild locates it: the first statement (not type-only) naming both the module and `name`, else the
// first naming the module.
function locationOf(projectRoot, path, specifier, name, source) {
  const file = posixRelative(projectRoot, path)
  const text = source(path)
  const found = text === null ? [] : [...text.matchAll(new RegExp(`(["'])${RegExp.escape(specifier)}\\1`, 'gu'))]
  if (found.length === 0) return { file }
  const statement = (match) => text.slice(Math.max(text.lastIndexOf('import', match.index), text.lastIndexOf('export', match.index), 0), match.index)
  const naming = new RegExp(`(?<![\\w$])${RegExp.escape(name)}(?![\\w$])`, 'u')
  const at = found.find((match) => naming.test(statement(match)) && !/^(?:import|export)\s+type(?:of)?\s/u.test(statement(match))) ?? found[0]
  const before = text.slice(0, at.index)
  const start = before.lastIndexOf('\n') + 1
  const end = text.indexOf('\n', at.index)
  return { file, line: before.split('\n').length, column: at.index - start, length: at[0].length, lineText: text.slice(start, end === -1 ? undefined : end) }
}
