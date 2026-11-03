// A bundle's source map as Metro gives it (MIT, Copyright (c) Meta Platforms, Inc. and affiliates):
// absolute source paths and node_modules on the ignore list (serializer.isThirdPartyModule), either
// as `react-native bundle --sourcemap-output` writes it or as the dev server serves it.

import { isAbsolute, relative, resolve, sep } from 'node:path'

// bundle()'s namespaces: a polyfill's or asset's source is its file, from the project root.
const NAMESPACED = /^metro-([a-z]+):(.*)$/su
const THIRD_PARTY = /(?:^|[/\\])node_modules[/\\]/u

// `text`, esbuild's map of a bundle written to `outDir`, with each source path through `sourceOf`;
// other namespaced sources (the main module) are kept as they are.
function remapped(text, { outDir, projectRoot, excludeSource = false }, sourceOf) {
  const map = JSON.parse(text)
  const paths = map.sources.map((source) => {
    const namespaced = NAMESPACED.exec(source)
    if (namespaced === null) return resolve(outDir, source)
    return namespaced[1] === 'polyfill' || namespaced[1] === 'asset' ? resolve(projectRoot, namespaced[2]) : null
  })
  const sources = paths.map((path, i) => (path === null ? map.sources[i] : sourceOf(path)))
  const ignored = paths.flatMap((path, i) => (path !== null && THIRD_PARTY.test(path) ? [i] : []))
  return JSON.stringify({ version: map.version, sources, ...(!excludeSource && { sourcesContent: map.sourcesContent }), names: map.names, mappings: map.mappings, ...(ignored.length > 0 && { x_google_ignoreList: ignored }) })
}

// As `react-native bundle` writes it (relativateSerializedMap): relative to `sourcesRoot` if given.
export function metroSourceMap(text, { outDir, projectRoot, sourcesRoot = null }) {
  return remapped(text, { outDir, projectRoot }, (path) => (sourcesRoot === null ? path : relative(sourcesRoot, path)))
}

// Where the dev server serves sources with sourcePaths=url-server, as Metro's does: [prefix, dir][]
// for the project root, then each watch folder by index (Metro's has the project root first).
export const sourceRoutes = (projectRoot, watchFolders) => [['/[metro-project]/', projectRoot], ...watchFolders.map((folder, i) => [`/[metro-watchFolders]/${i}/`, folder])]

// A source's URL path: under the first route it is in, else its absolute path.
const urlPathOf = (path, routes) => {
  for (const [prefix, root] of routes) if (path.startsWith(root + sep)) return prefix + encodeURI(path.slice(root.length + 1).split(sep).join('/'))
  const posix = path.split(sep).join('/')
  return encodeURI(posix.startsWith('/') ? posix : `/${posix}`)
}

// As Metro's dev server serves it (Server's _getModuleSourceUrl); RN DevTools ask for url-server
// and excludeSource. `text`'s sources are relative to the project root (esbuild's cwd) or absolute.
export function servedSourceMap(text, { projectRoot, routes, urlServer = false, excludeSource = false }) {
  return remapped(text, { outDir: projectRoot, projectRoot, excludeSource }, (path) => (urlServer ? urlPathOf(path, routes) : path))
}

// The file a url-server source request is for: null if outside its route's directory or undecodable,
// undefined if under no route.
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
