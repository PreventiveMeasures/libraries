// pnpm's name patterns (@pnpm/matcher), as `hoist-pattern` and
// `public-hoist-pattern` read them: `*` for any run of characters and
// nothing else special, `!` in front to exclude. One pattern is that
// pattern or its negation; several are read in order, where an exclusion
// cancels what matched before it and nothing after it matches again but a
// later inclusion, and a list of exclusions alone matches what none of them
// does. And the walk of a path through a glob that pnpm's workspace globs
// and yarn's share (pnpm/workspace.js, yarn1/glob.js), each its own way of
// reading a name's pattern.

// Text as a regular expression that matches it alone.
export const escape = (text) => text.replace(/[$()+.?[\\\]^{|}]/gu, '\\$&')

// Which places in a glob the path of `names` leads to: for each index,
// whether the glob's names before it take the path, a name at a time, in
// time the glob's length for each and with no recursion, however many
// `**` it has. `glob` is each name's pattern, or `**`, which may take no
// name, so reaching one reaches the next, and takes none with a leading
// dot unless `dot`.
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
