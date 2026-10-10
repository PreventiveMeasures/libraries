// The minimatch yarn 1 and npm read globs of workspaces with, read here a
// path segment at a time: `**` as null, and `*` and `?` within one, which,
// as `**`, match no segment that starts with `.`.

import { LockfileError, quote } from './error.js'

// Whether the code points of `name` match those of `pattern`, `*` any run
// and `?` any one: the last `*` taken one further at a time, in O(n*m).
function wildcard(pattern, name) {
  let [i, j, star, mark] = [0, 0, -1, 0]
  while (j < name.length) {
    if (pattern[i] === '*') {
      star = i++
      mark = j
    } else if (pattern[i] === '?' || pattern[i] === name[j]) {
      i++
      j++
    } else if (star === -1) {
      return false
    } else {
      i = star + 1
      j = ++mark
    }
  }
  while (pattern[i] === '*') i++
  return i === pattern.length
}

export function compile(glob, where) {
  const segments = glob.split('/')
  if (segments.length > 30 || segments.some((segment) => segment === '' || /[[\]{}()!+\\]/u.test(segment))) {
    throw new LockfileError(`${quote(glob)} is a glob not read here`, where)
  }
  return segments.map((segment) => {
    if (segment === '**') return null
    const dot = !segment.startsWith('.') && /[*?]/u.test(segment)
    const pattern = [...segment]
    return (name) => !(dot && name.startsWith('.')) && wildcard(pattern, [...name])
  })
}

// A bit for each segment of the glob matched; past `**`, the next may match.
export function close(tests, mask) {
  let closed = mask
  for (let i = 0; i < tests.length; i++) if ((closed & (1 << i)) !== 0 && tests[i] === null) closed |= 1 << (i + 1)
  return closed
}

export function step(tests, mask, segment) {
  let next = 0
  for (let i = 0; i < tests.length; i++) {
    if ((mask & (1 << i)) === 0) continue
    if (tests[i] === null) next |= segment.startsWith('.') ? 0 : 1 << i
    else if (tests[i](segment)) next |= 1 << (i + 1)
  }
  return close(tests, next)
}

export const accepts = (tests, mask) => (mask & (1 << tests.length)) !== 0

export const matches = (tests, path) => accepts(tests, path.split('/').reduce((mask, segment) => step(tests, mask, segment), close(tests, 1)))
