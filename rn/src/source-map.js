// A bundle's source map as Metro gives it (MIT, Copyright (c) Meta
// Platforms, Inc. and affiliates): each source's path absolute; each under
// node_modules on the ignore list, as Metro's default
// serializer.isThirdPartyModule has it.
// - As `react-native bundle --sourcemap-output` writes it (sourceMapString,
//   relativateSerializedMap): else from `sourcesRoot`.
// - As Metro's dev server serves it (Server's _getModuleSourceUrl): with
//   sourcePaths=url-server, which the app asks for where RN DevTools are on,
//   at a path the server serves the source at (sourceRoutes()); with
//   excludeSource, no sourcesContent.

import { isAbsolute, relative, resolve, sep } from 'node:path'

// A source of one of bundle()'s namespaces: a polyfill or an asset is its
// file, from the project root (Metro's module of an asset is the asset's
// path); the main module, as it is.
const NAMESPACED = /^metro-([a-z]+):(.*)$/su
const THIRD_PARTY = /(?:^|[/\\])node_modules[/\\]/u

// A source of esbuild's map of a bundle written to `outDir`. -> its path, else null.
const pathOf = (source, { outDir, projectRoot }) => {
  const namespaced = NAMESPACED.exec(source)
  if (namespaced === null) return resolve(outDir, source)
  return namespaced[1] === 'polyfill' || namespaced[1] === 'asset' ? resolve(projectRoot, namespaced[2]) : null
}

// `map`, its sources each `sourceOf(path)` where a path, with the ignore list. -> its text.
const remapped = (map, where, sourceOf, { excludeSource = false } = {}) => {
  const paths = map.sources.map((source) => pathOf(source, where))
  const sources = paths.map((path, i) => (path === null ? map.sources[i] : sourceOf(path)))
  const ignored = paths.flatMap((path, i) => (path !== null && THIRD_PARTY.test(path) ? [i] : []))
  return JSON.stringify({ version: map.version, sources, ...(!excludeSource && { sourcesContent: map.sourcesContent }), names: map.names, mappings: map.mappings, ...(ignored.length > 0 && { x_google_ignoreList: ignored }) })
}

// `text`, esbuild's map of the bundle written to `outDir`. -> its text, as Metro's.
export function metroSourceMap(text, { outDir, projectRoot, sourcesRoot = null }) {
  return remapped(JSON.parse(text), { outDir, projectRoot }, (path) => (sourcesRoot === null ? path : relative(sourcesRoot, path)))
}

// Where the dev server serves a source a map names with
// sourcePaths=url-server, as Metro's does: [path prefix, directory][], the
// project root's, then each of the config's watchFolders (Metro's, which
// the project root is the first of) by its index.
export const sourceRoutes = (projectRoot, watchFolders) => [['/[metro-project]/', projectRoot], ...watchFolders.map((folder, i) => [`/[metro-watchFolders]/${i}/`, folder])]

// A source's URL path: of the first route it is under, else its absolute path.
const urlPathOf = (path, routes) => {
  for (const [prefix, root] of routes) if (path.startsWith(root + sep)) return prefix + encodeURI(path.slice(root.length + 1).split(sep).join('/'))
  const posix = path.split(sep).join('/')
  return encodeURI(posix.startsWith('/') ? posix : `/${posix}`)
}

// `text`, a dev bundle's map, its sources from the project root (esbuild's
// working directory) or absolute. -> its text, as Metro's dev server's.
export function servedSourceMap(text, { projectRoot, routes, urlServer = false, excludeSource = false }) {
  return remapped(JSON.parse(text), { outDir: projectRoot, projectRoot }, (path) => (urlServer ? urlPathOf(path, routes) : path), { excludeSource })
}

// A request's path `pathname`, of a source a map names with
// sourcePaths=url-server. -> its path, inside the route's directory; null
// where none is; undefined where it is of no route.
export function sourceOfRequest(pathname, routes) {
  const route = routes.find(([prefix]) => pathname.startsWith(prefix))
  if (route === undefined) return undefined
  const [prefix, root] = route
  let path
  try {
    path = resolve(root, ...pathname.slice(prefix.length).split('/').map(decodeURIComponent))
  } catch {
    return null
  }
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? path : null
}
