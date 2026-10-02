// pnpm's name patterns (@pnpm/matcher), as `hoist-pattern` and
// `public-hoist-pattern` read them: `*` for any run of characters and
// nothing else special, `!` in front to exclude. In a list, an exclusion
// cancels what matched before it, and only a later inclusion matches again;
// a list of exclusions alone matches what none of them does. And the walk
// of a path through a glob, which pnpm's workspace globs and yarn's share
// (pnpm/workspace.js, yarn1/glob.js).

export const escape = (text) => text.replace(/[$()+.?[\\\]^{|}]/gu, '\\$&')

// For each place in `glob`, a regexp per name or `**`, whether the path of
// `names` reaches it, the last being a full match; in time linear in the
// glob's length per name, with no recursion however many `**` it has. A
// `**` may take no name, and takes none with a leading dot unless `dot`.
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

function matcherOf(pattern) {
  if (pattern === '*') return () => true
  if (!pattern.includes('*')) return (input) => input === pattern
  const regexp = new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 'u')
  return (input) => regexp.test(input)
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
