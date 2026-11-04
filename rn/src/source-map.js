// A bundle's source map as Metro gives it (MIT, Copyright (c) Meta Platforms, Inc. and affiliates):
// absolute source paths and node_modules on the ignore list (serializer.isThirdPartyModule), as
// `react-native bundle --sourcemap-output` writes it; as the dev server serves it, serve/source-map.js.

import { relative, resolve } from 'node:path'

// bundle()'s namespaces: a polyfill's or asset's source is its file, from the project root.
const NAMESPACED = /^metro-([a-z]+):(.*)$/su
const THIRD_PARTY = /(?:^|[/\\])node_modules[/\\]/u

// `text`, esbuild's map of a bundle written to `outDir`, with each source path through `sourceOf`;
// other namespaced sources (the main module) are kept as they are.
export function remapped(text, { outDir, projectRoot, excludeSource = false }, sourceOf) {
  const map = JSON.parse(text)
  const ignored = []
  const sources = map.sources.map((source, i) => {
    const namespaced = NAMESPACED.exec(source)
    if (namespaced !== null && namespaced[1] !== 'polyfill' && namespaced[1] !== 'asset') return source
    const path = namespaced === null ? resolve(outDir, source) : resolve(projectRoot, namespaced[2])
    if (THIRD_PARTY.test(path)) ignored.push(i)
    return sourceOf(path)
  })
  return JSON.stringify({ version: map.version, sources, ...(!excludeSource && { sourcesContent: map.sourcesContent }), names: map.names, mappings: map.mappings, ...(ignored.length > 0 && { x_google_ignoreList: ignored }) })
}

// As `react-native bundle` writes it (relativateSerializedMap): relative to `sourcesRoot` if given.
export function metroSourceMap(text, { outDir, projectRoot, sourcesRoot = null }) {
  return remapped(text, { outDir, projectRoot }, (path) => (sourcesRoot === null ? path : relative(sourcesRoot, path)))
}
