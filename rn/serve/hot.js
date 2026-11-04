// Fast Refresh updates from one build of a module-format bundle (modules.js) to the next: each module added
// or changed, defined anew with its inverse dependencies as metro-runtime's require takes them, and each deleted.
// Ported from Metro's HmrServer (hmrJSBundle; MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { toJscSafeUrl } from './bundle-url.js'
import { defineCall } from './modules.js'

// A URL drops `..` segments, so a parent is written `[..]`, which moduleName() reads back.
const PARENT = '[..]'
const urlPath = (name) => name.split('/').map((segment) => (segment === '..' ? PARENT : encodeURIComponent(segment))).join('/')

// The module a path of moduleUrls() names, `entryFile` as bundleRequest() reads it.
export const moduleName = (entryFile) => entryFile.replace(/^\.\//u, '').split('/').map((segment) => (segment === PARENT ? '..' : segment)).join('/')

// A module's code and map URLs, as Metro has them: the client's bundle URL for the module alone, but
// keeping the module's extension, as config.js and config.json are two modules.
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

// The module's dependents, and theirs, up to the entry, as Metro's getInverseDependencies: { [id]: [ids] }.
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

const same = (a, b) => a === b || (a.factory === b.factory && a.name === b.name && a.deps.length === b.deps.length && a.deps.every((id, i) => id === b.deps[i]))

// What changed from `before` to `after`, as the body of Metro's `update` message for the client of
// `clientUrl`; null where nothing did, unless `always`, giving an empty one to tell a build failed no more.
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
