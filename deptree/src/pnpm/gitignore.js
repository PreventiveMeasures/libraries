// A gitignore line as pnpm 12 reads one, by the ignore crate (0.4.32) and
// its glob by globset (0.4.18): matched against a path's UTF-8 bytes, case
// and all, from the directory of the file it is in. Only `*`, `?` and `**`
// are followed of glob syntax, as in minimatch.js.

import { checkGlob, checkLength } from './minimatch.js'

// What Rust's trim_end takes off: White_Space.
const TRAILING = /[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/u

const encoder = new TextEncoder()

// A path as its UTF-8 bytes, as globset matches it.
export const bytesOf = (path) => encoder.encode(path)

const SLASH = 0x2F
const NEWLINE = 0x0A
const notSlash = (byte) => byte !== SLASH
const notNewline = (byte) => byte !== NEWLINE
const isSlash = (byte) => byte === SLASH

// globset's parse of a glob into tokens: a byte, `?` (ANY), `*` (STAR), and
// a `**` part, recursive only as a whole part: at the start (PREFIX), the
// end (SUFFIX), or between two (BETWEEN); a lone `**` is ALL.
function tokensOf(text) {
  const glob = [...text]
  const tokens = []
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char !== '*') {
      tokens.push(...(char === '?' ? ['ANY'] : bytesOf(char)))
      continue
    }
    if (glob[i + 1] !== '*') {
      tokens.push('STAR')
      continue
    }
    i++
    const next = glob[i + 1]
    if (tokens.length === 0) {
      if (next !== undefined && next !== '/') tokens.push('STAR', 'STAR')
      else {
        tokens.push('PREFIX')
        if (next === '/') i++
      }
    } else if (glob[i - 2] !== '/' || (next !== undefined && next !== '/')) tokens.push('STAR', 'STAR')
    else {
      if (next === '/') i++
      const last = tokens.pop()
      tokens.push(last === 'PREFIX' || last === 'SUFFIX' ? last : next === undefined ? 'SUFFIX' : 'BETWEEN')
    }
  }
  return tokens.length === 1 && tokens[0] === 'PREFIX' ? ['ALL'] : tokens
}

// The regexp globset makes of the tokens, `.` taking any byte but a newline,
// as an automaton, which matches in time linear in the path and the glob:
// each state its steps, by what byte to where, and where it goes by none.
function automatonOf(tokens) {
  const states = [{ steps: [], free: [] }]
  const state = () => states.push({ steps: [], free: [] }) - 1
  let at = 0
  for (const token of tokens) {
    const to = state()
    const { steps, free } = states[at]
    if (typeof token === 'number') steps.push([(byte) => byte === token, to])
    else if (token === 'ANY') steps.push([notSlash, to])
    else if (token === 'STAR' || token === 'ALL') {
      steps.push([token === 'STAR' ? notSlash : notNewline, at])
      free.push(to)
    } else {
      // `/.*` to the end, `/` or `/.*/` between, and `/?` or `.*/` first.
      const loop = state()
      states[loop].steps.push([notNewline, loop])
      if (token === 'SUFFIX') {
        steps.push([isSlash, loop])
        states[loop].free.push(to)
      } else {
        states[loop].steps.push([isSlash, to])
        steps.push([isSlash, to])
        if (token === 'PREFIX') free.push(to, loop)
        else steps.push([isSlash, loop])
      }
    }
    at = to
  }
  const accept = at
  const close = (set) => {
    for (const index of set) for (const to of states[index].free) set.add(to)
    return set
  }
  return (bytes) => {
    let here = close(new Set([0]))
    for (const byte of bytes) {
      const next = new Set()
      for (const index of here) for (const [take, to] of states[index].steps) if (take(byte)) next.add(to)
      if (next.size === 0) return false
      here = close(next)
    }
    return here.has(accept)
  }
}

// The glob of one line, or undefined for a blank one or a comment.
export function gitignoreGlob(line, where) {
  if (line.startsWith('#')) return undefined
  let text = line.replace(TRAILING, '')
  if (text === '') return undefined
  checkLength(text, where)
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
  return { whitelist, onlyDir, matches: automatonOf(tokensOf(actual)) }
}

// The last glob to match `path`, an only-dir one only a directory: whether
// it ignores or whitelists, or undefined where none does.
export function matched(globs, path, isDir) {
  const bytes = bytesOf(path)
  const found = globs.findLast((glob) => (!glob.onlyDir || isDir) && glob.matches(bytes))
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
