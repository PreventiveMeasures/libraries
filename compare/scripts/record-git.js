// Records what git says of the trees in tests/cases.js into
// tests/fixtures/git.js: for each pair, `git diff --raw -z`,
// `git diff --numstat -z` and the patch `git diff` writes, under the options
// the case gives. Needs git 2.44 or later on the PATH, which counts the last
// span of a file for its similarity whether a newline ends it or not:
//
//     node compare/scripts/record-git.js
//
// Each pair is two commits made by fast-import in a repository of its own,
// with no configuration but git's defaults (tests/git.js), so what is
// recorded turns on git's version alone.

import { writeFileSync } from 'node:fs'
import { CASES } from '../tests/cases.js'
import { diffFlags, gitVersion, repository } from '../tests/git.js'

const OUT = new URL('../tests/fixtures/git.js', import.meta.url)

const version = gitVersion()
if (version === null || version[0] < 2 || (version[0] === 2 && version[1] < 44)) throw new Error(`git 2.44 or later is needed, not ${version?.join('.') ?? 'none'}`)

// A string literal in printable ASCII, so the fixture is ASCII too.
const ESCAPES = { '\n': '\\n', '\t': '\\t', '"': '\\"', '\\': '\\\\' }
const literal = (text) => `"${[...text].map((char) => ESCAPES[char] ?? (char >= ' ' && char <= '~' ? char : `\\u{${char.codePointAt(0).toString(16).toUpperCase()}}`)).join('')}"`

const recordings = CASES.map(({ name, options, old, new: fresh }) => {
  const repo = repository(old, fresh)
  try {
    const flags = diffFlags(options)
    return { name, raw: repo.diff([...flags, '--raw', '-z']), numstat: repo.diff([...flags, '--numstat', '-z']), patch: repo.diff(flags) }
  } finally {
    repo.close()
  }
})

const body = recordings.map(({ name, raw, numstat, patch }) => [
  '  {',
  `    name: ${literal(name)},`,
  `    raw: ${literal(raw)},`,
  `    numstat: ${literal(numstat)},`,
  `    patch: ${literal(patch)},`,
  '  },',
].join('\n')).join('\n')

writeFileSync(OUT, `// What git ${version.join('.')} says of the pairs in ../cases.js, by name, as
// scripts/record-git.js recorded it: \`git diff --raw -z\`, \`--numstat -z\`
// and the patch, each under the options the case gives. Not to be edited.

export const RECORDINGS = [
${body}
]
`)
console.log(`recorded ${recordings.length} cases from git ${version.join('.')}`)
