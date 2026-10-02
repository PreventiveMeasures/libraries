// A gitignore line as pnpm 12 reads one, by the ignore crate (0.4.32) and
// its glob by globset (0.4.18): matched against a path's UTF-8 bytes, case
// and all, from the directory of the file it is in. Only `*`, `?` and `**`
// are followed of glob syntax, as in minimatch.js.

import { checkGlob } from './minimatch.js'

// What Rust's trim_end takes off: White_Space.
const TRAILING = /[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/u

// A path as its bytes, one character to a byte, which a regexp built of
// the same matches as globset's byte regexp does.
export const bytesOf = (path) => String.fromCodePoint(...new TextEncoder().encode(path))

const escapeByte = (char) => `\\x${char.codePointAt(0).toString(16).padStart(2, '0')}`

// globset's parse of `*`s: `**` is recursive only as a whole part.
function regexpOf(text) {
  const glob = [...text]
  const tokens = []
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char !== '*') {
      tokens.push(char === '?' ? '[^/]' : bytesOf(char).replace(/[\s\S]/gu, escapeByte))
      continue
    }
    if (glob[i + 1] !== '*') {
      tokens.push('[^/]*')
      continue
    }
    i++
    const next = glob[i + 1]
    if (tokens.length === 0) {
      if (next !== undefined && next !== '/') tokens.push('[^/]*', '[^/]*')
      else {
        tokens.push('PREFIX')
        if (next === '/') i++
      }
    } else if (glob[i - 2] !== '/' || (next !== undefined && next !== '/')) tokens.push('[^/]*', '[^/]*')
    else {
      if (next === '/') i++
      const last = tokens.pop()
      tokens.push(last === 'PREFIX' || last === 'SUFFIX' ? last : next === undefined ? 'SUFFIX' : 'BETWEEN')
    }
  }
  if (tokens.length === 1 && tokens[0] === 'PREFIX') return /^[^\n]*$/u
  const source = tokens.map((token) => ({ PREFIX: '(?:/?|[^\\n]*/)', SUFFIX: '/[^\\n]*', BETWEEN: '(?:/|/[^\\n]*/)' }[token] ?? token)).join('')
  return new RegExp(`^${source}$`, 'u')
}

// The glob of one line, or undefined for a blank one or a comment.
export function gitignoreGlob(line, where) {
  if (line.startsWith('#')) return undefined
  let text = line.replace(TRAILING, '')
  if (text === '') return undefined
  const whitelist = text.startsWith('!')
  if (whitelist) text = text.slice(1)
  const absolute = text.startsWith('/')
  if (absolute) text = text.slice(1)
  const onlyDir = text.endsWith('/')
  if (onlyDir) text = text.slice(0, -1)
  checkGlob(text, where, { parent: true })
  let actual = text
  if (!absolute && !text.includes('/') && !actual.startsWith('**/') && actual !== '**') actual = `**/${actual}`
  if (actual.endsWith('/**')) actual = `${actual}/*`
  return { whitelist, onlyDir, regexp: regexpOf(actual) }
}

// The last glob to match `path`, an only-dir one only a directory: whether
// it ignores or whitelists, or undefined where none does.
export function matched(globs, path, isDir) {
  const bytes = bytesOf(path)
  const found = globs.findLast((glob) => (!glob.onlyDir || isDir) && glob.regexp.test(bytes))
  return found === undefined ? undefined : found.whitelist ? 'whitelist' : 'ignore'
}

// That of `path`, or else of the nearest directory above it to match.
export function matchedOrParents(globs, path, isDir) {
  const parts = path.split('/')
  for (let i = parts.length; i >= 0; i--) {
    const found = matched(globs, parts.slice(0, i).join('/'), i === parts.length ? isDir : true)
    if (found !== undefined) return found
  }
  return undefined
}
