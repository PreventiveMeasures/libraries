// What a tree's .gitattributes files say of a path, as git 2.43's attr.c
// reads them for `git archive`: each line's pattern matched as dir.c and
// wildmatch.c match it, and the attributes it sets taken from the deepest
// file's last line up, the first value an attribute is given standing.
// Paths and the files' text are latin1 strings, a char per byte, as git
// compares the bytes; a directory's path ends in `/`.

const BLANK = ' \t\r\n'
const MAX_LINE = 2048
// Git's own ctype, ASCII alone: its space is not \v nor \f.
const between = (low, high) => (char) => char >= low && char <= high
const CLASSES = {
  alnum: (char) => /[\dA-Za-z]/u.test(char),
  alpha: (char) => /[A-Za-z]/u.test(char),
  blank: (char) => char === ' ' || char === '\t',
  cntrl: (char) => char < ' ' || char === '\u007F',
  digit: between('0', '9'),
  graph: between('!', '~'),
  lower: between('a', 'z'),
  print: between(' ', '~'),
  punct: (char) => /[!-/:-@[-`{-~]/u.test(char),
  space: (char) => '\t\n\r '.includes(char),
  upper: between('A', 'Z'),
  xdigit: (char) => /[\dA-Fa-f]/u.test(char),
}
const isGlobSpecial = (char) => '*?[\\'.includes(char)
const [MATCH, NOMATCH, ABORT_ALL, ABORT_TO_STARSTAR] = [0, 1, -1, -2]

// A bracket expression at p[at], `[` just past: where it ends, and whether
// `char` is in it, or ABORT_ALL where it does not end.
function bracket(p, at, char) {
  let i = at
  let pch = p[i]
  if (pch === '^') pch = '!'
  const negated = pch === '!'
  if (negated) pch = p[++i]
  let prev = ''
  let matched = false
  do {
    if (pch === undefined) return ABORT_ALL
    if (pch === '\\') {
      pch = p[++i]
      if (pch === undefined) return ABORT_ALL
      if (char === pch) matched = true
    } else if (pch === '-' && prev && p[i + 1] !== undefined && p[i + 1] !== ']') {
      pch = p[++i]
      if (pch === '\\') pch = p[++i]
      if (pch === undefined) return ABORT_ALL
      if (char <= pch && char >= prev) matched = true
      pch = ''
    } else if (pch === '[' && p[i + 1] === ':') {
      const start = i + 2
      const end = p.indexOf(']', start)
      if (end === -1) return ABORT_ALL
      if (end - start - 1 < 0 || p[end - 1] !== ':') {
        i = start - 2
        pch = '['
        if (char === pch) matched = true
      } else {
        const name = p.slice(start, end - 1)
        if (!Object.hasOwn(CLASSES, name)) return ABORT_ALL
        if (char !== undefined && CLASSES[name](char)) matched = true
        i = end
        pch = ''
      }
    } else if (char === pch) {
      matched = true
    }
    prev = pch
    pch = p[++i]
  } while (pch !== ']')
  return { end: i, matched: matched !== negated }
}

// Where in t from ti `char` is, as a `*` before it skips ahead to it: no
// further than a `/` where the `*` stops at one.
function skipTo(t, ti, char, matchSlash) {
  for (let at = ti; at < t.length; at++) {
    if (t[at] === char || (!matchSlash && t[at] === '/')) return at
  }
  return t.length
}

// The rest of p, from pi, after a `*` that takes up t from `start`, tried
// at each place in t the `*` could end.
function afterStar(p, pi, t, start, pathname, matchSlash) {
  for (let ti = start; ti < t.length; ti++) {
    if (!isGlobSpecial(p[pi])) {
      ti = skipTo(t, ti, p[pi], matchSlash)
      if (t[ti] !== p[pi]) return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR
    }
    const matched = dowild(p, pi, t, ti, pathname)
    if (matched !== NOMATCH) {
      if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched
    } else if (!matchSlash && t[ti] === '/') {
      return ABORT_TO_STARSTAR
    }
  }
  return ABORT_ALL
}

// wildmatch.c's dowild: p from `start` against t from ti. With `pathname`,
// `*` and `?` stop at a `/`, and `**` alone crosses one.
function dowild(p, start, t, ti, pathname) {
  for (let pi = start; pi < p.length; ti++, pi++) {
    let pch = p[pi]
    const tch = t[ti]
    if (tch === undefined && pch !== '*') return ABORT_ALL
    if (pch === '?') {
      if (pathname && tch === '/') return NOMATCH
      continue
    }
    if (pch === '[') {
      const found = bracket(p, pi + 1, tch)
      if (found === ABORT_ALL) return ABORT_ALL
      if (!found.matched || (pathname && tch === '/')) return NOMATCH
      pi = found.end
      continue
    }
    if (pch !== '*') {
      if (pch === '\\') pch = p[++pi]
      if (tch !== pch) return NOMATCH
      continue
    }
    // A `**` crosses a `/` where it is a whole name, or without `pathname`;
    // its place is read from where this call's pattern starts.
    let matchSlash = !pathname
    if (p[++pi] === '*') {
      const second = pi
      while (p[++pi] === '*');
      if (pathname) {
        const whole = (second - start < 2 || p[second - 2] === '/') && (pi === p.length || p[pi] === '/' || (p[pi] === '\\' && p[pi + 1] === '/'))
        if (whole && p[pi] === '/' && dowild(p, pi + 1, t, ti, pathname) === MATCH) return MATCH
        matchSlash = whole
      }
    }
    if (pi === p.length) return !matchSlash && t.includes('/', ti) ? ABORT_TO_STARSTAR : MATCH
    if (!matchSlash && p[pi] === '/') {
      const slash = t.indexOf('/', ti)
      if (slash === -1) return ABORT_ALL
      ti = slash
      continue
    }
    return afterStar(p, pi, t, ti, pathname, matchSlash)
  }
  return ti < t.length ? NOMATCH : MATCH
}

export const wildmatch = (pattern, text, pathname) => dowild(pattern, 0, text, 0, pathname) === MATCH

// quote.c's unquote_c_style of a pattern from its opening `"`: the pattern
// and what follows its closing one, or null where it is not C-quoted.
const ESCAPES = { a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' }
function unquote(text) {
  let out = ''
  for (let i = 1; i < text.length;) {
    const char = text[i++]
    if (char === '"') return { pattern: out, rest: text.slice(i) }
    if (char !== '\\') {
      out += char
      continue
    }
    const next = text[i++]
    if (Object.hasOwn(ESCAPES, next)) {
      out += ESCAPES[next]
    } else if (/^[0-3][0-7]{2}$/u.test(text.slice(i - 1, i + 2))) {
      out += String.fromCodePoint(Number.parseInt(text.slice(i - 1, i + 2), 8))
      i += 2
    } else {
      return null
    }
  }
  return null
}

const span = (text, at, chars) => {
  let end = at
  while (end < text.length && chars.includes(text[end])) end++
  return end
}
const cspan = (text, at, chars) => {
  let end = at
  while (end < text.length && !chars.includes(text[end])) end++
  return end
}
const isAttrName = (name) => /^[\w.][\w.-]*$/u.test(name)

// The attributes a line sets, each { name, value }: true, false, null for
// `!name`, or a string; null where one is not a name git takes, which
// drops the whole line.
function parseStates(text) {
  const states = []
  for (let at = span(text, 0, BLANK); at < text.length;) {
    const end = cspan(text, at, BLANK)
    const word = text.slice(at, end)
    const equals = word.indexOf('=')
    const sign = word[0] === '-' || word[0] === '!' ? word[0] : ''
    const name = word.slice(sign.length, equals === -1 ? word.length : equals)
    if (!isAttrName(name)) return null
    states.push({ name, value: sign === '-' ? false : sign === '!' ? null : equals === -1 ? true : word.slice(equals + 1) })
    at = span(text, end, BLANK)
  }
  return states
}

// dir.c's parse_path_pattern, of a pattern git takes as an attribute's.
function parsePattern(raw) {
  const text = raw.split('\0')[0]
  const mustBeDir = text.endsWith('/')
  const length = text.length - Number(mustBeDir)
  const simple = [...text].findIndex(isGlobSpecial)
  return {
    text: text.slice(0, length),
    mustBeDir,
    noDir: !text.slice(0, length).includes('/'),
    prefix: Math.min(simple === -1 ? text.length : simple, length),
    endsWith: text[0] === '*' && ![...text.slice(1)].some(isGlobSpecial),
  }
}

// One line of a .gitattributes, as attr.c's parse_attr_line reads it, or
// null for one it passes over: blank, a comment, 2048 bytes or longer, a
// negative pattern, an attribute git does not take, or a macro anywhere
// but the top file.
function parseLine(line, macrosAllowed) {
  const start = span(line, 0, BLANK)
  if (start === line.length || line[start] === '#' || line.length >= MAX_LINE) return null
  const quoted = line[start] === '"' ? unquote(line.slice(start)) : null
  const end = quoted === null ? cspan(line, start, BLANK) : null
  const name = quoted?.pattern ?? line.slice(start, end)
  const rest = quoted?.rest ?? line.slice(end)
  if (name.length > '[attr]'.length && name.startsWith('[attr]')) {
    const at = span(name, '[attr]'.length, BLANK)
    const macro = name.slice(at, cspan(name, at, BLANK))
    const states = parseStates(rest)
    return macrosAllowed && isAttrName(macro) && states !== null ? { macro, states } : null
  }
  const states = parseStates(rest)
  if (states === null || name.startsWith('!')) return null
  return { pattern: parsePattern(name), states }
}

// A .gitattributes as read from a blob: lines up to a NUL, and none of a
// file of 100 MiB or more. `macrosAllowed` for the top one alone.
export function parseAttributes(text, macrosAllowed) {
  if (text.length >= 100 * 1024 * 1024) return []
  return text.split('\0')[0].split('\n').map((line) => parseLine(line, macrosAllowed)).filter((line) => line !== null)
}

// dir.c's match_basename and match_pathname, past the directory check.
function matchBasename(name, { text, prefix, endsWith }) {
  if (prefix === text.length) return name === text
  if (endsWith) return name.endsWith(text.slice(1))
  return wildmatch(text, name, false)
}

function matchPathname(path, base, { text, prefix }) {
  let pattern = text
  let fixed = prefix
  if (pattern[0] === '/') {
    pattern = pattern.slice(1)
    fixed--
  }
  if (path.length < base.length + 1 || (base && path[base.length] !== '/') || !path.startsWith(base)) return false
  const name = path.slice(base ? base.length + 1 : 0)
  if (fixed) {
    if (fixed > name.length || pattern.slice(0, fixed) !== name.slice(0, fixed)) return false
    if (pattern.length === fixed && name.length === fixed) return true
  }
  return wildmatch(pattern.slice(fixed), name.slice(fixed), true)
}

function pathMatches(path, basenameAt, pattern, base) {
  const isDir = path.endsWith('/')
  const end = path.length - Number(isDir)
  if (pattern.mustBeDir && !isDir) return false
  return pattern.noDir ? matchBasename(path.slice(basenameAt, end), pattern) : matchPathname(path.slice(0, end), base, pattern)
}

// What `stack` says of `path`: the files of its directory and each above
// it, the top one first, each { base, lines }, `base` its directory, ''
// at the top. A Map of each attribute given a value to the value.
export function attributesOf(stack, path) {
  let slash = -1
  for (let i = 0; i < path.length - 1; i++) if (path[i] === '/') slash = i
  const macros = new Map()
  for (const { lines } of stack.toReversed()) {
    for (const line of lines.toReversed()) if (line.macro !== undefined && !macros.has(line.macro)) macros.set(line.macro, line.states)
  }
  const values = new Map()
  const fill = (states) => {
    for (const { name, value } of states.toReversed()) {
      if (values.has(name)) continue
      values.set(name, value)
      if (value === true && macros.has(name)) fill(macros.get(name))
    }
  }
  for (const { base, lines } of stack.toReversed()) {
    for (const line of lines.toReversed()) if (line.pattern !== undefined && pathMatches(path, slash + 1, line.pattern, base)) fill(line.states)
  }
  return values
}
