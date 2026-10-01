// Cargo refuses two sources for one dependency name. Without a filesystem,
// two paths are refused only where they cannot be one directory.

import { ANY_REGISTRY, sourceIdentity } from './lock.js'

// A Windows path's prefix as cargo's file URL has it: a server's share, or
// an upper-cased drive. Device paths and drive-relative ones are not read.
function windowsRoot(path) {
  const share = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]+([^\\/]+)/u.exec(path)
  if (share !== null) return { prefix: `//${share[1]}/${share[2]}`.toLowerCase(), rest: `/${path.slice(share[0].length)}` }
  const drive = /^([A-Za-z]):(?=[\\/])/u.exec(path)
  if (drive !== null) return { prefix: drive[1].toUpperCase(), rest: path.slice(2) }
  return /^(?:[\\/]{2}|[A-Za-z]:)/u.test(path) ? undefined : { prefix: undefined, rest: path }
}

// As cargo's normalize_path: `..` stops at the root; `up` counts those left.
function readPath(path, windows) {
  const from = windows ? windowsRoot(path) : { prefix: undefined, rest: path }
  if (from === undefined) return undefined
  const parts = []
  let up = 0
  for (const part of from.rest.split(windows ? /[\\/]/u : '/')) {
    if (part === '..' && parts.length > 0) parts.pop()
    else if (part === '..') up++
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return { prefix: from.prefix, absolute: windows ? /^[\\/]/u.test(from.rest) : from.rest.startsWith('/'), up, parts }
}

// An `inherited` path is relative to the workspace root, not the manifest.
export function sourceOf(source, inherited) {
  if (source.type !== 'path') {
    const identity = sourceIdentity(source, 'path')
    return { key: identity === ANY_REGISTRY ? `${identity} ${source.registry}` : identity }
  }
  return { key: 'path', readings: [false, true].map((windows) => readPath(source.path, windows)), inherited }
}

const endsWith = (long, short) => short.length <= long.length && short.every((part, index) => part === long[long.length - short.length + index])

// Whether two paths cannot be one directory, whatever the directories are
// named. From one directory, the one climbing further must come back down
// through no more names than it climbed further, then go on as the other;
// from unrelated directories, they must end alike.
function apart(a, b, unrelated) {
  if (a.absolute && b.absolute) return (a.prefix !== undefined && b.prefix !== undefined && a.prefix !== b.prefix) || a.parts.join('/') !== b.parts.join('/')
  if (a.absolute || b.absolute) return !endsWith((a.absolute ? a : b).parts, (a.absolute ? b : a).parts)
  if (unrelated) return !endsWith(a.parts, b.parts) && !endsWith(b.parts, a.parts)
  const [far, near] = a.up >= b.up ? [a, b] : [b, a]
  const down = far.parts.length - near.parts.length
  return down < 0 || down > far.up - near.up || !endsWith(far.parts, near.parts)
}

// Paths are apart only where both the Unix and the Windows readings are.
export function differ(a, b) {
  if (a.key !== 'path' || b.key !== 'path') return a.key !== b.key
  return a.readings.every((x, index) => {
    const y = b.readings[index]
    return x !== undefined && y !== undefined && apart(x, y, a.inherited !== b.inherited)
  })
}
