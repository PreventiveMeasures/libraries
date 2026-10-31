// How CocoaPods matches a podspec's file patterns against a pod's files:
// PathList's dir_glob_equivalent_patterns, its own expansion of braces,
// then Ruby's File.fnmatch with FNM_CASEFOLD and FNM_PATHNAME, as dir.c
// has it in Ruby 2.6 to 3.4. Each is followed step for step, quirks and
// all: a `*` stops at a `/`; a leading `.` of a name is matched by a `.`
// alone, and `**/` enters no directory whose name starts with one; case
// is folded for ASCII letters alone; and in a bracket, a character that is
// not one of it byte for byte is folded against the one after it in the
// pattern, so that `[a]` does not take `A` where `[ba]` does.

const NOMATCH = 1

// A character of `chars`, or '' past the end, where C reads the NUL.
const at = (chars, i) => chars[i] ?? ''
const upper = (char) => (char >= 'a' && char <= 'z' ? String.fromCodePoint(char.codePointAt(0) - 32) : char)
const point = (char) => char.codePointAt(0)

// bracket(): `p` is next to the `[`; the index past the `]`, or -1 where
// the bracket does not take the character at `s`, or never closes.
function bracket(P, p, S, s) {
  if (p >= P.length) return -1
  let not = false
  let ok = false
  if (P[p] === '!' || P[p] === '^') {
    not = true
    p++
  }
  while (at(P, p) !== ']') {
    let t1 = p
    if (at(P, t1) === '\\') t1++
    if (at(P, t1) === '') return -1
    p = t1 + 1
    if (p >= P.length) return -1
    if (P[p] === '-' && at(P, p + 1) !== ']') {
      let t2 = p + 1
      if (at(P, t2) === '\\') t2++
      if (at(P, t2) === '') return -1
      p = t2 + 1
      if (ok) continue
      if (P[t1] === S[s] || P[t2] === S[s]) {
        ok = true
        continue
      }
      const c1 = point(upper(S[s]))
      if (c1 < point(upper(P[t1])) || c1 > point(upper(P[t2]))) continue
    } else {
      if (ok) continue
      if (P[t1] === S[s]) {
        ok = true
        continue
      }
      // Ruby's own: against P[p], the character after this one.
      if (upper(S[s]) !== upper(P[p])) continue
    }
    ok = true
  }
  return ok === not ? -1 : p + 1
}

// fnmatch_helper(): one name of the path, up to a `/` or the end of each.
function helper(P, p0, S, s0) {
  let p = p0
  let s = s0
  const end = (chars, i) => at(chars, i) === '' || at(chars, i) === '/'
  const unescape = (i) => (at(P, i) === '\\' ? i + 1 : i)
  let ptmp = -1
  let stmp = -1
  if (at(S, s) === '.' && at(P, unescape(p)) !== '.') return { r: NOMATCH, p, s }
  for (;;) {
    const char = at(P, p)
    let failed = false
    if (char === '*') {
      do p++
      while (at(P, p) === '*')
      if (end(P, unescape(p))) return { r: 0, p: unescape(p), s }
      if (end(S, s)) return { r: NOMATCH, p, s }
      ptmp = p
      stmp = s
      continue
    }
    if (char === '?') {
      if (end(S, s)) return { r: NOMATCH, p, s }
      p++
      s++
      continue
    }
    if (char === '[') {
      if (end(S, s)) return { r: NOMATCH, p, s }
      const t = bracket(P, p + 1, S, s)
      if (t === -1) {
        failed = true
      } else {
        p = t
        s++
        continue
      }
    } else {
      p = unescape(p)
      if (end(S, s)) return { r: end(P, p) ? 0 : NOMATCH, p, s }
      if (!end(P, p) && (P[p] === S[s] || upper(P[p]) === upper(S[s]))) {
        p++
        s++
        continue
      }
      failed = true
    }
    if (failed && ptmp !== -1) {
      p = ptmp
      stmp++
      s = stmp
      continue
    }
    return { r: NOMATCH, p, s }
  }
}

// File.fnmatch(pattern, path, File::FNM_CASEFOLD | File::FNM_PATHNAME).
export function fnmatch(pattern, path) {
  const P = Array.from(pattern)
  const S = Array.from(path)
  let p = 0
  let s = 0
  let ptmp = -1
  let stmp = -1
  const recursive = (i) => at(P, i) === '*' && at(P, i + 1) === '*' && at(P, i + 2) === '/'
  for (;;) {
    if (recursive(p)) {
      do p += 3
      while (recursive(p))
      ptmp = p
      stmp = s
    }
    const result = helper(P, p, S, s)
    p = result.p
    s = result.s
    if (result.r === 0) {
      while (at(S, s) !== '' && at(S, s) !== '/') s++
      if (at(P, p) !== '' && at(S, s) !== '') {
        p++
        s++
        continue
      }
      if (at(P, p) === '' && at(S, s) === '') return true
    }
    if (ptmp !== -1 && at(S, stmp) !== '.') {
      while (at(S, stmp) !== '' && at(S, stmp) !== '/') stmp++
      if (at(S, stmp) !== '') {
        p = ptmp
        stmp++
        s = stmp
        continue
      }
    }
    return false
  }
}

// Ruby's String#split by ',': empty strings at the end dropped, so that
// `{}` and `{,}` stand for no pattern at all.
function splitCommas(text) {
  const values = text.split(',')
  while (values.length > 0 && values.at(-1) === '') values.pop()
  return values
}

// More than this many patterns from one is refused, rather than matched.
export const MAX_EXPANDED = 4096

// dir_glob_equivalent_patterns: each `/**/` as `{/**/,/}`, then each
// `{...}` with no `}` inside, by the text of it, replaced wherever that text
// is with each of the values between its commas, braces dropped from them,
// one set after another in the order each is first found. Ruby's gsub reads
// a backslash in a value as the start of a reference to the match; a
// pattern with one there, and one that comes to more than MAX_EXPANDED,
// is undefined, for the caller to refuse.
export function expandBraces(pattern) {
  const rewritten = pattern.replaceAll('/**/', '{/**/,/}')
  const sets = new Map()
  for (const [set] of rewritten.matchAll(/\{[^}]*\}/gu)) {
    if (!sets.has(set)) sets.set(set, splitCommas(set.replace(/[{}]/gu, '')))
  }
  let patterns = [rewritten]
  for (const [set, values] of sets) {
    if (values.some((value) => value.includes('\\'))) return undefined
    patterns = patterns.flatMap((old) => values.map((value) => old.replaceAll(set, () => value)))
    if (patterns.length > MAX_EXPANDED) return undefined
  }
  return patterns
}
