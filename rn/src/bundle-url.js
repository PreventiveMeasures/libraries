// Bundle and source map requests as Metro 0.87 reads them
// (parseBundleOptionsFromBundleRequestUrl; jsc-safe-url; MIT, Copyright (c)
// Meta Platforms, Inc. and affiliates): the entry from the path, the
// platform from `platform` or the file name, `dev` on and `minify` off
// unless told; `shallow` and `modulesOnly`, as a module's URL in an update
// has them (`shallow`: the module alone, not those it imports).

const TRUE = new Set(['true', '1'])
const PLATFORMS = new Set(['ios', 'android', 'windows', 'web'])
const MARKER = '//&'

const split = (url) => {
  const hashAt = url.indexOf('#')
  const rest = hashAt === -1 ? url : url.slice(0, hashAt)
  const queryAt = rest.indexOf('?')
  return { path: queryAt === -1 ? rest : rest.slice(0, queryAt), query: queryAt === -1 ? null : rest.slice(queryAt + 1), hash: hashAt === -1 ? '' : url.slice(hashAt) }
}

// JSC drops the query of a script's URL: Metro's sourceURL has it in the path.
export function toJscSafeUrl(url) {
  const { path, query, hash } = split(url)
  return query === null || query === '' ? url : `${path}${MARKER}${query}${hash}`
}

export function toNormalUrl(url) {
  const { path, query, hash } = split(url)
  const scheme = path.indexOf('://')
  const at = path.indexOf(MARKER, scheme === -1 ? 0 : scheme + 3)
  if (at === -1) return url
  return `${path.slice(0, at)}?${[path.slice(at + MARKER.length), query].filter(Boolean).join('&')}${hash}`
}

const flag = (params, name, fallback) => (params.has(name) ? TRUE.has(params.get(name)) : fallback)

// `url`: a request's, its origin given. -> { kind: 'bundle' | 'map',
// entryFile: './index', platform, dev, minify, shallow, modulesOnly,
// sourceUrl, sourceMapUrl },
// null where it is no bundle or source map; throws a URIError on a path
// that doesn't decode.
export function bundleRequest(url) {
  const { origin, pathname: requestPath, searchParams, search, hash } = url
  const pathname = searchParams.get('bundleEntry') || requestPath
  const kind = pathname.endsWith('.bundle') ? 'bundle' : pathname.endsWith('.map') ? 'map' : null
  if (kind === null) return null
  const entryFile = pathname.split('/').map((segment) => decodeURIComponent(segment)).join('/').replace(/^(?:\.?\/)?/u, './').replace(/\.[^/.]+$/u, '')
  const named = /\.([^./]+)\.[^./]+$/u.exec(pathname)?.[1]
  const platform = searchParams.get('platform') || (PLATFORMS.has(named) ? named : null)
  const bundlePath = requestPath.replace(/\.map$/u, '.bundle')
  return {
    kind,
    entryFile,
    platform,
    dev: flag(searchParams, 'dev', true),
    minify: flag(searchParams, 'minify', false),
    shallow: flag(searchParams, 'shallow', false),
    modulesOnly: flag(searchParams, 'modulesOnly', false),
    sourceUrl: toJscSafeUrl(`${origin}${bundlePath}${search}${hash}`),
    sourceMapUrl: `${origin}${requestPath.replace(/\.bundle$/u, '.map')}${search}${hash}`,
  }
}
