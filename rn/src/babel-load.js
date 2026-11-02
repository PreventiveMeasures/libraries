// Each file as load.js's loadFile() loads it, of Babel, off the main thread:
// in Babel's worker (babel-worker.js), which strips its Flow, lowers it by
// esbuild, picks the plugins Babel is without, and transforms it; the
// config Babel loads for the file loaded once, for the plugins it has and
// for its transform alike. The main thread then reads and resolves.

import { createRequire } from 'node:module'

import { transformerOf } from './babel-transformer.js'
import { loadFile } from './load.js'

const require = createRequire(import.meta.url)

// ({ corePath, options, profile }) -> (message) => its answer, as
// transformerOf()'s; with options.esbuildPath, the esbuild loadFile() lowers
// by, of { load: { path, contents, projectRoot, sourcemap, keepPlugins, esm,
// flow } }, a promise of loadFile()'s result, and Babel's `spent`, or {
// thrown }, the message of what it threw: `esm`, false, or 'commonjs' of a
// file left CommonJS, else 'module'; `flow`, the path of the
// flow-remove-types that strips it, or null for none.
export function handlerOf({ corePath, options: { esbuildPath = null, ...options }, profile }) {
  const transformer = transformerOf({ corePath, options, profile })
  if (esbuildPath === null) return transformer
  const esbuild = require(esbuildPath)
  const load = async ({ path, contents, projectRoot, sourcemap, keepPlugins, esm, flow }) => {
    let config
    let configMs = 0
    let spent
    const configOf = () => {
      if (config === undefined) {
        const start = performance.now()
        config = transformer.configOf(path)
        configMs = performance.now() - start
      }
      return config
    }
    const babel = (source, filename, without) => {
      const answer = transformer({ source, filename, without, config: configOf(), configMs })
      if (answer.error !== undefined) throw Object.assign(new Error(answer.error), answer.loc && { loc: answer.loc })
      spent = answer.spent
      return answer
    }
    const stripFlow = flow === null ? null : (source) => require(flow)(source, { all: true, removeEmptyImports: true }).toString()
    try {
      const loaded = await loadFile({ esbuild, projectRoot, stripFlow, babel, babelPlugins: () => transformer.pluginsOf(configOf(), path), sourcemap, esm: esm === false ? false : new Set(esm === 'commonjs' ? [path] : []), keepPlugins }, path, contents)
      return { ...loaded, ...(spent && { spent }) }
    } catch (error) {
      return { thrown: error?.message ?? String(error) }
    }
  }
  return (message) => (message.load === undefined ? transformer(message) : load(message.load))
}
