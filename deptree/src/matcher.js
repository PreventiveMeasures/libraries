// pnpm's name patterns (@pnpm/matcher), as `hoist-pattern` and
// `public-hoist-pattern` read them: `*` for any run of characters and
// nothing else special, `!` in front to exclude. One pattern is that
// pattern or its negation; several are read in order, where an exclusion
// cancels what matched before it and nothing after it matches again but a
// later inclusion, and a list of exclusions alone matches what none of them
// does.

const escape = (text) => text.replace(/[$()+.?[\\\]^{|}]/gu, '\\$&')

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
