// Whether two declarations of one dependency name one source, as cargo
// asks of every declaration of a name in a manifest, without a filesystem.

import { ANY_REGISTRY, sourceIdentity } from './lock.js'

// On Windows, what a path is from, as cargo would write it in a URL: a
// drive's root, a server's share, or the drive of the directory it is read
// from where it names none; a device, or a drive's current directory, is
// not read.
function windowsRoot(path) {
  const share = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]+([^\\/]+)/u.exec(path)
  if (share !== null) return { prefix: `//${share[1]}/${share[2]}`.toLowerCase(), rest: `/${path.slice(share[0].length)}` }
  const drive = /^([A-Za-z]):(?=[\\/])/u.exec(path)
  if (drive !== null) return { prefix: drive[1].toUpperCase(), rest: path.slice(2) }
  return /^(?:[\\/]{2}|[A-Za-z]:)/u.test(path) ? undefined : { prefix: undefined, rest: path }
}

// A path as cargo reads it from a directory, on a host whose separator is
// `/`, or on Windows, whose separators are `/` and `\`: `.` and empty parts
// dropped and `..` taken back, leaving the `..` it climbs out by and the
// parts after, or from the root.
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

// What tells two sources apart without a filesystem: a path's readings, from
// the manifest's directory, or the workspace root's where it is inherited.
export function sourceOf(source, inherited) {
  if (source.type !== 'path') {
    const identity = sourceIdentity(source, 'path')
    return { key: identity === ANY_REGISTRY ? `${identity} ${source.registry}` : identity }
  }
  return { key: 'path', readings: [false, true].map((windows) => readPath(source.path, windows)), inherited }
}

const endsWith = (long, short) => short.length <= long.length && short.every((part, index) => part === long[long.length - short.length + index])

// Whether two paths read alike are other ones whatever the directories are
// named. Two paths from one directory meet only where the one that climbs
// further goes back down through that directory's names, no more of them
// than it climbed, and then as the other; paths from directories not known
// one from the other, `unrelated`, meet only where they end alike.
function apart(a, b, unrelated) {
  if (a.absolute && b.absolute) return (a.prefix !== undefined && b.prefix !== undefined && a.prefix !== b.prefix) || a.parts.join('/') !== b.parts.join('/')
  if (a.absolute || b.absolute) return !endsWith((a.absolute ? a : b).parts, (a.absolute ? b : a).parts)
  if (unrelated) return !endsWith(a.parts, b.parts) && !endsWith(b.parts, a.parts)
  const [far, near] = a.up >= b.up ? [a, b] : [b, a]
  const down = far.parts.length - near.parts.length
  return down < 0 || down > far.up - near.up || !endsWith(far.parts, near.parts)
}

// Whether two sources are other ones whatever the directories are named,
// and whichever host cargo runs on: paths read apart both ways.
export function differ(a, b) {
  if (a.key !== 'path' || b.key !== 'path') return a.key !== b.key
  return a.readings.every((x, index) => {
    const y = b.readings[index]
    return x !== undefined && y !== undefined && apart(x, y, a.inherited !== b.inherited)
  })
}
