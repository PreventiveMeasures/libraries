// A bundle's source map as Metro's dev server serves it (MIT, Copyright (c) Meta Platforms, Inc. and
// affiliates): absolute source paths, or with sourcePaths=url-server, each at a path the server serves it
// at; node_modules on the ignore list (rn's src/source-map.js's remapped()).

import { resolve, sep } from 'node:path'

import { remapped } from '@preventive/rn/src/source-map.js'
import { inside } from './dev-bundler.js'

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
  return inside(root, path) ? path : null
}
