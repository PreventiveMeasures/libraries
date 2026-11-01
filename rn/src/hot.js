// Fast Refresh's updates, as Metro's HmrServer sends them (hmrJSBundle; MIT,
// Copyright (c) Meta Platforms, Inc. and affiliates): from one build of a
// bundle in the module format (modules.js) to the next, each module added
// or changed, defined anew with its inverse dependencies, which
// metro-runtime's require takes as an update, and each deleted.

import { toJscSafeUrl } from './bundle-url.js'
import { defineCall } from './modules.js'

// A module's path in a URL, each segment encoded; a parent, which a URL
// takes off, as `[..]`, which moduleName() reads back.
const urlPath = (name) => name.split('/').map((segment) => (segment === '..' ? PARENT : encodeURIComponent(segment))).join('/')
const PARENT = '[..]'

// The module a path of moduleUrls() names, `entryFile` as bundleRequest() reads it.
export const moduleName = (entryFile) => entryFile.replace(/^\.\//u, '').split('/').map((segment) => (segment === PARENT ? '..' : segment)).join('/')

// The URLs of a module's code and map, as Metro has them: the client's
// bundle URL, its path the module's, for the module alone; but with the
// module's extension kept, as config.js and config.json are two.
export function moduleUrls(clientUrl, name) {
  const url = new URL(clientUrl)
  url.protocol = 'http:'
  const query = url.searchParams
  query.delete('bundleEntry')
  query.delete('excludeSource')
  query.set('dev', query.get('dev') || 'true')
  query.set('minify', query.get('minify') || 'false')
  query.set('modulesOnly', 'true')
  query.set('runModule', query.get('runModule') || 'false')
  query.set('shallow', 'true')
  const path = (ext) => `/${urlPath(name)}.${ext}`
  url.pathname = path('map')
  const sourceMappingURL = url.toString()
  url.pathname = path('bundle')
  return { sourceURL: toJscSafeUrl(url.toString()), sourceMappingURL }
}

// Each module's, and each of theirs on, up to the entry, as Metro's
// getInverseDependencies has them: { [id]: [ids of its dependents] }.
function inverseDependencies(id, dependents) {
  const out = {}
  const queue = [id]
  while (queue.length > 0) {
    const next = queue.pop()
    if (Object.hasOwn(out, next)) continue
    out[next] = [...(dependents.get(next) ?? [])]
    queue.push(...out[next])
  }
  return out
}

const same = (a, b) => a.factory === b.factory && a.name === b.name && a.deps.length === b.deps.length && a.deps.every((id, i) => id === b.deps[i])

// What changed from `before` to `after`, builds of one bundle. -> the body of
// Metro's `update` message, for the client of `clientUrl`, or null where
// nothing did, unless `always`: then one of nothing, which tells the client
// a build failed no more.
export function hotUpdate(before, after, clientUrl, { always = false } = {}) {
  const added = []
  const modified = []
  for (const [id, record] of after.modules) {
    const was = before.modules.get(id)
    if (was === undefined) added.push(record)
    else if (!same(was, record)) modified.push(record)
  }
  const deleted = [...before.modules.keys()].filter((id) => !after.modules.has(id))
  if (added.length + modified.length + deleted.length === 0 && !always) return null
  const dependents = new Map()
  for (const record of after.modules.values()) {
    for (const dep of record.deps) {
      if (!dependents.has(dep)) dependents.set(dep, new Set())
      dependents.get(dep).add(record.id)
    }
  }
  const update = (record) => {
    const { sourceURL, sourceMappingURL } = moduleUrls(clientUrl, record.name)
    const code = `${defineCall(record, inverseDependencies(record.id, dependents))}//# sourceMappingURL=${sourceMappingURL}\n//# sourceURL=${sourceURL}\n`
    return { module: [record.id, code], sourceMappingURL, sourceURL }
  }
  return { revisionId: String(after.version), isInitialUpdate: false, added: added.map(update), modified: modified.map(update), deleted }
}
