// How each list of scripts/accounts.js would label packages' versions as
// published by a known account, from the data dir scripts/fetch.js wrote:
// every account that published a version of a package (not trusted
// publishing's CI), once per package and by its versions, among the packages
// with MIN_DOWNLOADS or more downloads a month, which the lists are made of,
// and among the rest fetched, which they never saw, so how they would do on
// other packages; for 1,000 of each list, and for other cutoffs, printed as
// Markdown:
//
//     node publishers/scripts/score.js <data dir>

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LISTS, MIN_DOWNLOADS, accountsOf, ranked } from './accounts.js'

const [dataDir] = process.argv.slice(2)
if (!dataDir) throw new Error('usage: score.js <data dir>')
const CUTOFFS = [500, 1000, 1500, 2000, Infinity]

const packages = JSON.parse(await readFile(join(dataDir, 'packages.json'), 'utf8'))
const accounts = accountsOf(packages)

// Each package and account that published a version of it, with how many.
const pairs = packages.flatMap((p) => p.publishers.filter((u) => !u.trusted).map((u) => ({ downloads: p.downloads, publisher: u.name, versions: u.versions })))
const seen = pairs.filter((v) => v.downloads >= MIN_DOWNLOADS)
const unseen = pairs.filter((v) => v.downloads < MIN_DOWNLOADS)

const format = (n) => n.toLocaleString('en-US')
const percent = (part, all) => `${((100 * part) / all).toFixed(1)}%`
const sum = (of) => of.reduce((total, v) => total + v.versions, 0)
const byPairs = (of, names) => percent(of.filter((v) => names.has(v.publisher)).length, of.length)
const byVersions = (of, names) => percent(sum(of.filter((v) => names.has(v.publisher))), sum(of))
// Each list's accounts in order, ranked once for every cutoff.
const rankedNames = new Map(LISTS.map((list) => [list, ranked(accounts, list).map((a) => a.name)]))
const known = (list, n) => new Set(rankedNames.get(list).slice(0, n))
const table = (head, body) => [`| ${head.join(' | ')} |`, `| :--- |${' ---: |'.repeat(head.length - 1)}`, ...body.map((row) => `| ${row.join(' | ')} |`)].join('\n')

const bar = format(MIN_DOWNLOADS)
const out = [
  `Packages with ${bar}+ downloads a month, the lists' own: ${format(packages.filter((p) => p.downloads >= MIN_DOWNLOADS).length)}, with ${format(seen.length)} packages and accounts, ${format(sum(seen))} versions; the rest fetched: ${format(packages.filter((p) => p.downloads < MIN_DOWNLOADS).length)}, with ${format(unseen.length)} and ${format(sum(unseen))}.`,
  table(['List (1,000)', 'Own: packages and accounts', 'Own: versions', 'Rest: packages and accounts', 'Rest: versions'], LISTS.map((list) => {
    const names = known(list, 1000)
    return [`${list.label}: ${list.title}`, byPairs(seen, names), byVersions(seen, names), byPairs(unseen, names), byVersions(unseen, names)]
  })),
  table(['Packages and accounts, own · rest', ...CUTOFFS.map((n) => (n === Infinity ? 'All' : format(n)))], LISTS.map((list) => [
    `${list.label}: ${list.title}`,
    ...CUTOFFS.map((n) => {
      const names = known(list, n)
      return `${byPairs(seen, names)} · ${byPairs(unseen, names)}${n === Infinity ? ` (${format(names.size)})` : ''}`
    }),
  ])),
]

console.log(out.join('\n\n'))
