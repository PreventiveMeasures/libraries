// A bundle's source map as `react-native bundle --sourcemap-output` writes it: absolute source paths, with
// node_modules on the ignore list (MIT, Copyright (c) Meta Platforms, Inc. and affiliates). The dev
// server's is rn-serve's source-map.js.

import { relative, resolve } from 'node:path'

// bundle()'s namespaces: a polyfill's or asset's source is its file, from the project root.
const NAMESPACED = /^metro-([a-z]+):(.*)$/su
const THIRD_PARTY = /(?:^|[/\\])node_modules[/\\]/u

// esbuild's map of a bundle written to `outDir`, with each file's source path through `sourceOf`.
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

// Sources relative to `sourcesRoot` if given, as `react-native bundle` writes them.
export function metroSourceMap(text, { outDir, projectRoot, sourcesRoot = null }) {
  return remapped(text, { outDir, projectRoot }, (path) => (sourcesRoot === null ? path : relative(sourcesRoot, path)))
}
