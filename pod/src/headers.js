// Pods/Headers: the headers of each pod that is not built as a framework, linked under Private/<pod> for its own
// build and Public/<pod> for those that depend on it, by header_dir and header_mappings_dir.

import { posix } from 'node:path'

// PodTarget#header_mappings: the headers by the directory each is linked in, from Headers/Private or Public.
function mappingsOf(target, pick) {
  const mappings = new Map()
  for (const accessor of target.accessors) {
    const { header_dir: headerDir, header_mappings_dir: mappingsDir } = accessor.consumer
    const base = headerDir ? posix.join(target.name, headerDir) : target.name
    for (const header of pick(accessor)) {
      if (header.includes('.framework/')) continue
      const dir = mappingsDir ? posix.join(base, posix.dirname(posix.relative(mappingsDir, header))) : base
      if (!mappings.has(dir)) mappings.set(dir, [])
      mappings.get(dir).push(header)
    }
  }
  return mappings
}

// What SandboxHeaderPathsInstaller and link_headers make of a pod target: its links, each `[directory, header]`,
// and whether each store has a search path for it. A pod built as a framework carries its headers itself.
export function headersOf(target) {
  if (target.framework && target.shouldBuild) return { private: new Map(), public: new Map() }
  return { private: mappingsOf(target, (accessor) => accessor.headers), public: mappingsOf(target, (accessor) => accessor.publicHeaders) }
}

// HeadersStore#search_paths of the public store, for one pod or, with no name, for every pod that has an entry.
export function publicSearchPaths(targets, name, modular) {
  const paths = []
  for (const target of targets) {
    if (target.headerLinks.public.size === 0 || (name !== undefined && target.name !== name)) continue
    paths.push('${PODS_ROOT}/Headers/Public')
    if (!modular) paths.push(`\${PODS_ROOT}/Headers/Public/${target.name}`)
  }
  return [...new Set(paths)]
}
export const privateSearchPaths = (target) => (target.headerLinks.private.size === 0 ? [] : ['${PODS_ROOT}/Headers/Private', `\${PODS_ROOT}/Headers/Private/${target.name}`])
