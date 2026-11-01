// A bundle's source map as `react-native bundle --sourcemap-output` writes
// it (Metro's sourceMapString, relativateSerializedMap): each source's path
// absolute, else from `sourcesRoot`; each under node_modules on the ignore
// list, as Metro's default serializer.isThirdPartyModule has it.

import { relative, resolve } from 'node:path'

// A source of one of bundle()'s namespaces: a polyfill or an asset is its
// file, from the project root (Metro's module of an asset is the asset's
// path); the main module, as it is.
const NAMESPACED = /^metro-([a-z]+):(.*)$/su
const THIRD_PARTY = /(?:^|[/\\])node_modules[/\\]/u

// `text`, esbuild's map of the bundle written to `outDir`. -> its text, as Metro's.
export function metroSourceMap(text, { outDir, projectRoot, sourcesRoot = null }) {
  const map = JSON.parse(text)
  const pathOf = (source) => {
    const namespaced = NAMESPACED.exec(source)
    if (namespaced === null) return resolve(outDir, source)
    return namespaced[1] === 'polyfill' || namespaced[1] === 'asset' ? resolve(projectRoot, namespaced[2]) : null
  }
  const paths = map.sources.map(pathOf)
  const sources = paths.map((path, i) => (path === null ? map.sources[i] : sourcesRoot === null ? path : relative(sourcesRoot, path)))
  const ignored = paths.flatMap((path, i) => (path !== null && THIRD_PARTY.test(path) ? [i] : []))
  return JSON.stringify({ version: map.version, sources, sourcesContent: map.sourcesContent, names: map.names, mappings: map.mappings, ...(ignored.length > 0 && { x_google_ignoreList: ignored }) })
}
