// Bundle and source map URLs as Metro 0.87 reads them (parseBundleOptionsFromBundleRequestUrl,
// jsc-safe-url; MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

const TRUE = new Set(['true', '1'])
const PLATFORMS = new Set(['ios', 'android', 'windows', 'web'])
const MARKER = '//&'
// A URL's path, query and hash.
const PARTS = /^([^#?]*)(?:\?([^#]*))?(#.*)?$/su

// JSC drops the query of a script's URL, so Metro's sourceURL moves it into the path.
export function toJscSafeUrl(url) {
  const [, path, query, hash = ''] = PARTS.exec(url)
  return query ? `${path}${MARKER}${query}${hash}` : url
}

export function toNormalUrl(url) {
  const [, path, query, hash = ''] = PARTS.exec(url)
  const scheme = path.indexOf('://')
  const at = path.indexOf(MARKER, scheme === -1 ? 0 : scheme + 3)
  if (at === -1) return url
  return `${path.slice(0, at)}?${[path.slice(at + MARKER.length), query].filter(Boolean).join('&')}${hash}`
}

// What `url` (a request's, with its origin) asks for, or null if no bundle or source map; throws a
// URIError if its path doesn't decode. `dev` defaults on, `minify` off; `shallow` is the module alone,
// as an update's URLs ask; `sourcePaths` is Metro's SourcePathsMode ('url-server', else 'absolute').
export function bundleRequest(url) {
  const { origin, pathname: requestPath, searchParams, search, hash } = url
  const pathname = searchParams.get('bundleEntry') || requestPath
  const kind = pathname.endsWith('.bundle') ? 'bundle' : pathname.endsWith('.map') ? 'map' : null
  if (kind === null) return null
  const flag = (name, fallback) => (searchParams.has(name) ? TRUE.has(searchParams.get(name)) : fallback)
  const named = /\.([^./]+)\.[^./]+$/u.exec(pathname)?.[1]
  return {
    kind,
    entryFile: pathname.split('/').map(decodeURIComponent).join('/').replace(/^(?:\.?\/)?/u, './').replace(/\.[^/.]+$/u, ''),
    platform: searchParams.get('platform') || (PLATFORMS.has(named) ? named : null),
    dev: flag('dev', true),
    minify: flag('minify', false),
    shallow: flag('shallow', false),
    modulesOnly: flag('modulesOnly', false),
    sourcePaths: searchParams.get('sourcePaths') === 'url-server' ? 'url-server' : 'absolute',
    excludeSource: flag('excludeSource', false),
    sourceUrl: toJscSafeUrl(`${origin}${requestPath.replace(/\.map$/u, '.bundle')}${search}${hash}`),
    sourceMapUrl: `${origin}${requestPath.replace(/\.bundle$/u, '.map')}${search}${hash}`,
  }
}
