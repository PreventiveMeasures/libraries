// The minimatch read here, a path segment at a time: `**` as null, and `*`
// and `?` within one, which, as `**`, match no segment that starts with `.`.

import { LockfileError, quote } from '../error.js'

const WILD = { '*': '[^/]*', '?': '[^/]' }

export function compile(glob, where) {
  const segments = glob.split('/')
  if (segments.length > 30 || segments.some((segment) => segment === '' || /[[\]{}()!+\\]/u.test(segment))) {
    throw new LockfileError(`${quote(glob)} is a glob not read here`, where)
  }
  return segments.map((segment) => {
    if (segment === '**') return null
    const dot = segment.startsWith('.') || !/[*?]/u.test(segment) ? '' : '(?!\\.)'
    return new RegExp(`^${dot}${segment.replaceAll(/[$.*?^|]/gu, (char) => WILD[char] ?? `\\${char}`)}$`, 'u')
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
    else if (tests[i].test(segment)) next |= 1 << (i + 1)
  }
  return close(tests, next)
}

export const accepts = (tests, mask) => (mask & (1 << tests.length)) !== 0

export const matches = (tests, path) => accepts(tests, path.split('/').reduce((mask, segment) => step(tests, mask, segment), close(tests, 1)))
