// Writes npm.js from the data dir scripts/fetch.js wrote: the npm accounts
// known to publish, E·dl of scripts/accounts.js, all of it, each that published
// one of the packages with MIN_DOWNLOADS or more downloads a month with
// standing there:
//
//     node publishers/scripts/build.js <data dir>
//
// The accounts in E·dl's order, the most downloads first, as many to a line as
// fit in MAX_LINE, of one string literal split on commas, each line ended by a
// line continuation, which adds nothing to the string: of the forms measured
// on Node 24, loading some 2,000 names took 0.3 ms over an empty module's this
// way (or on one line), 0.4 ms as a template literal of one per line, 0.7 ms
// as JSON.parse of a string literal and 1.5 ms as an array literal; for ten
// times as many, 3.4 ms, 5.1, 6.9 and 13.5.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LISTS, MIN_DOWNLOADS, accountsOf, ranked } from './accounts.js'

const [dataDir] = process.argv.slice(2)
if (!dataDir) throw new Error('usage: build.js <data dir>')
const OUT = new URL('../npm.js', import.meta.url)
const MAX_LINE = 100
const END = "'.split(',')"

const packages = JSON.parse(await readFile(join(dataDir, 'packages.json'), 'utf8'))
const source = JSON.parse(await readFile(join(dataDir, 'source.json'), 'utf8'))
const list = LISTS.find(({ key }) => key === 'ever-published-by-downloads')
const names = ranked(accountsOf(packages), list).map(({ name }) => name)

// npm's account names, old ones among them with capitals, and nothing that
// would end the literal or the split.
for (const name of names) if (!/^[\w.-]+$/u.test(name)) throw new Error(`An account name to quote: ${name}`)

// The names packed into lines of MAX_LINE or less, each ended by `,\` but the
// last, which END ends: its last name on a line of its own, where it would not
// fit there.
const lines = []
for (const name of names) {
  if (lines.length && `${lines.at(-1)},${name},\\`.length <= MAX_LINE) lines[lines.length - 1] += `,${name}`
  else lines.push(name)
}
if (`${lines.at(-1)}${END}`.length > MAX_LINE) {
  const last = lines.pop()
  const cut = last.lastIndexOf(',')
  lines.push(last.slice(0, cut), last.slice(cut + 1))
}
await writeFile(OUT, `// The npm accounts known to publish, ${names.length.toLocaleString('en-US')}: each with standing on one of
// npm's packages with ${MIN_DOWNLOADS.toLocaleString('en-US')} or more downloads a month, as its only
// publisher (trusted publishing's CI aside) or the publisher of two of its
// versions 90 days or more apart; by the monthly downloads of those packages,
// summed, the most first. From ${source.counts} and the packuments
// as of ${source.fetched}, by scripts/build.js; typed in npm.d.ts.

export default '\\
${lines.join(',\\\n')}${END}
`)
console.error(`${names.length} accounts`)
