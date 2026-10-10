// pnpm's name patterns (@pnpm/matcher), as `hoist-pattern` and
// `public-hoist-pattern` read them; and the walk of a path through a glob,
// which pnpm's workspace globs and yarn's share.

// Whether a text matches `pattern`, `*` any run of what `any` takes and,
// with `one`, `?` any one code point; anything else itself. The places of
// `pattern` a text reaches are kept a code point at a time, in O(n*m) for
// any pattern, where a regexp of k `*`s backtracks in O(n^k): a glob from a
// project's own files is no one's to stall.
export function wildcard(pattern, { one = false, any = () => true } = {}) {
  const parts = [...pattern]
  const end = parts.length
  const onward = (places) => {
    for (let i = 0; i < end; i++) if (places[i] === 1 && parts[i] === '*') places[i + 1] = 1
  }
  let here = new Uint8Array(end + 1)
  let next = new Uint8Array(end + 1)
  return (text) => {
    here.fill(0)
    here[0] = 1
    onward(here)
    for (const char of text) {
      next.fill(0)
      for (let i = 0; i < end; i++) {
        if (here[i] === 0) continue
        if (parts[i] === '*') {
          if (any(char)) next[i] = 1
        } else if (parts[i] === char || (one && parts[i] === '?')) next[i + 1] = 1
      }
      onward(next)
      ;[here, next] = [next, here]
    }
    return here[end] === 1
  }
}

// For each place in `glob`, a regexp per name or `**`, whether `names` reach
// it, the last being a full match; linear per name, with no recursion however
// many `**`. A `**` takes no name with a leading dot unless `dot`.
export function reach(glob, names, dot = false) {
  let here = Array.from({ length: glob.length + 1 }, (_, g) => g === 0)
  let next = Array.from({ length: glob.length + 1 }, () => false)
  const onward = (places) => {
    for (let g = 0; g < glob.length; g++) if (places[g] && glob[g] === '**') places[g + 1] = true
  }
  onward(here)
  for (const name of names) {
    next.fill(false)
    for (let g = 0; g < glob.length; g++) {
      if (!here[g]) continue
      if (glob[g] !== '**') next[g + 1] ||= glob[g].test(name)
      else if (dot || !name.startsWith('.')) next[g] = true
    }
    onward(next)
    ;[here, next] = [next, here]
  }
  return here
}

// pnpm's `*` is a regexp's `.*`, which takes no line terminator.
const LINE = new Set(['\n', '\r', '\u2028', '\u2029'])

function matcherOf(pattern) {
  if (pattern === '*') return () => true
  if (!pattern.includes('*')) return (input) => input === pattern
  return wildcard(pattern, { any: (char) => !LINE.has(char) })
}

export function createMatcher(patterns) {
  if (patterns.length === 0) return () => false
  const matchers = patterns.map((pattern) => {
    const ignore = pattern.startsWith('!')
    return { ignore, match: matcherOf(ignore ? pattern.slice(1) : pattern) }
  })
  if (matchers.every(({ ignore }) => ignore)) return (input) => !matchers.some(({ match }) => match(input))
  return (input) => {
    let matched = false
    for (const { ignore, match } of matchers) {
      if (ignore) { if (match(input)) matched = false }
      else if (!matched && match(input)) matched = true
    }
    return matched
  }
}
