// The npm accounts behind the packages of packages.json (scripts/fetch.js)
// with MIN_DOWNLOADS or more downloads a month, by role: the packages an
// account maintains, those whose latest version it published (the latest an
// account published, not trusted publishing's CI), and those it published any
// version of (not through trusted publishing). A role's rank is its best
// package's; its downloads, its packages' monthly downloads, summed. A package
// counts for an account as a publisher only where it has standing there: it
// is the package's only publisher, trusted publishing's CI aside, or published
// two versions of it STANDING_DAYS or more apart (its first and its last); a
// few versions published in passing (event-stream's by right9ctrl, three in 24
// days) earn it none. npm.js is E·dl, all of it.

// The popularity bar, in download-counts' monthly downloads.
export const MIN_DOWNLOADS = 10_000_000
export const STANDING_DAYS = 90

const standing = (p, user) =>
  p.publishers.filter((u) => !u.trusted).length === 1 ||
  Date.parse(user.time) - Date.parse(user.firstTime) >= STANDING_DAYS * 864e5

export function accountsOf(packages, min = MIN_DOWNLOADS) {
  const accounts = new Map()
  const role = () => ({ rank: null, packages: 0, downloads: 0 })
  const account = (name) => {
    if (!accounts.has(name)) accounts.set(name, { name, maintained: role(), published: role(), ever: role() })
    return accounts.get(name)
  }
  const count = (of, p) => {
    of.rank ??= p.rank
    of.packages++
    of.downloads += p.downloads
  }
  for (const p of packages) {
    if (p.downloads < min) continue
    for (const name of p.maintainers) count(account(name).maintained, p)
    for (const user of p.publishers) {
      if (user.trusted || !standing(p, user)) continue
      count(account(user.name).ever, p)
      if (user.name === p.accountLatest?.publisher) count(account(user.name).published, p)
    }
  }
  return accounts
}

// An account's order by its best package's rank, those sharing it (a package's
// maintainers) by their downloads; or by its packages' downloads.
const byRank = (as) => (a, b) => a[as].rank - b[as].rank || b[as].downloads - a[as].downloads || a.name.localeCompare(b.name)
const byDownloads = (as) => (a, b) => b[as].downloads - a[as].downloads || a[as].rank - b[as].rank || a.name.localeCompare(b.name)

export const LISTS = [
  { key: 'maintainers-by-rank', label: 'M·rank', title: 'Maintainers, top packages first', as: 'maintained', order: byRank },
  { key: 'maintainers-by-downloads', label: 'M·dl', title: 'Maintainers, most downloads', as: 'maintained', order: byDownloads },
  { key: 'publishers-by-rank', label: 'P·rank', title: 'Latest publishers, top packages first', as: 'published', order: byRank },
  { key: 'publishers-by-downloads', label: 'P·dl', title: 'Latest publishers, most downloads', as: 'published', order: byDownloads },
  { key: 'ever-published-by-rank', label: 'E·rank', title: 'Ever published, top packages first', as: 'ever', order: byRank },
  { key: 'ever-published-by-downloads', label: 'E·dl', title: 'Ever published, most downloads', as: 'ever', order: byDownloads },
]

// A list's accounts, all in order.
export const ranked = (accounts, list) => [...accounts.values()].filter((a) => a[list.as].packages).toSorted(list.order(list.as))
