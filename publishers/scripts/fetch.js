// Fetches what scripts/build.js makes npm.js of: download-counts' monthly
// counts ranked, and each of the top packages' packument, for its maintainers
// and the accounts that published its versions:
//
//     node publishers/scripts/fetch.js <counts.json> <cache dir> <data dir> [top]
//
// counts.json is download-counts' (`npm pack download-counts`, then its
// package/counts.json), the package.json beside it naming its version; top is
// how many packages to fetch, 10,000 unless given, more than npm.js counts
// (scripts/accounts.js), so that scripts/score.js has packages the lists never
// saw. Each packument is cached in the cache dir, gzipped, as the registry
// served it (null for a package it doesn't have), with the time it was
// fetched: a rerun reads it from there, so that what is made of it can change
// without fetching again; empty the dir to refresh.
//
// Writes, in the data dir, none of it committed: packages.json (each package,
// by rank: its monthly downloads, its maintainers, its latest version and that
// one's publisher, the latest version an account published, not trusted
// publishing's CI, and every account that published a version, the latest to
// publish first, with the versions it published first and last, when, and how
// many) and source.json (download-counts' version, and the day the oldest of
// the packuments was fetched). A version published with trusted publishing (OIDC) has npm's
// name for the CI as its publisher ("GitHub Actions"), and its provider as
// trusted.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gunzipSync, gzipSync } from 'node:zlib'

const [countsPath, cacheDir, dataDir, topArg = '10000'] = process.argv.slice(2)
if (!countsPath || !cacheDir || !dataDir) throw new Error('usage: fetch.js <counts.json> <cache dir> <data dir> [top]')
await mkdir(cacheDir, { recursive: true })
await mkdir(dataDir, { recursive: true })
const TOP = Number(topArg)
const CONCURRENCY = 24

const counts = JSON.parse(await readFile(countsPath, 'utf8'))
const ranked = Object.entries(counts).toSorted(([, a], [, b]) => b - a).slice(0, TOP)
const countsVersion = await readFile(join(dirname(countsPath), 'package.json'), 'utf8').then((text) => JSON.parse(text).version, () => null)

async function fetchPackument(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (res.status === 404) return 'null'
      if (res.ok) return await res.text()
      if (attempt >= 5 || (res.status !== 429 && res.status < 500)) throw new Error(`${name}: HTTP ${res.status}`)
    } catch (error) {
      if (attempt >= 5) throw error
    }
    await sleep(1000 * 2 ** attempt)
  }
}

// A package's packument and when it was fetched, from the cache if there: each
// entry holds both, `{"fetched":…,"packument":…}` with the registry's answer as
// it served it, so that the time goes wherever the entry is copied.
async function packument(name) {
  const file = join(cacheDir, `${name.replace('/', '%2F')}.json.gz`)
  const cached = await readFile(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (cached) {
    const entry = JSON.parse(gunzipSync(cached))
    if (typeof entry?.fetched !== 'string') throw new Error(`${file}: a cache entry without the time it was fetched; empty the cache dir`)
    return entry
  }
  const fetched = new Date().toISOString()
  const body = await fetchPackument(name)
  await writeFile(file, gzipSync(`{"fetched":${JSON.stringify(fetched)},"packument":${body}}`))
  return { fetched, packument: JSON.parse(body) }
}

// Every account that published a version, the latest to publish first: the
// version it published last, when, the one it published first, when, and how
// many it published.
function publishers(doc) {
  const by = new Map()
  for (const [version, meta] of Object.entries(doc?.versions ?? {})) {
    const user = meta?._npmUser
    if (!user?.name) continue
    const trusted = user.trustedPublisher ? (user.trustedPublisher.id ?? true) : undefined
    const key = trusted ? `${user.name}\0${trusted}` : user.name
    const time = doc.time?.[version] ?? null
    if (!by.has(key)) by.set(key, { name: user.name, ...(trusted ? { trusted } : {}), version, time, firstVersion: version, firstTime: time, versions: 0 })
    const entry = by.get(key)
    entry.versions++
    if (time && (!entry.time || time > entry.time)) Object.assign(entry, { version, time })
    if (time && (!entry.firstTime || time < entry.firstTime)) Object.assign(entry, { firstVersion: version, firstTime: time })
  }
  return [...by.values()].toSorted((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
}

// Semver precedence, enough for the registry's versions: below zero when a
// is lower than b.
function compareVersions(a, b) {
  const parse = (version) => {
    const [core, pre] = version.split('+')[0].split(/-(.*)/su)
    return [core.split('.').map(Number), pre ? pre.split('.') : []]
  }
  const [[coreA, preA], [coreB, preB]] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((coreA[i] || 0) !== (coreB[i] || 0)) return (coreA[i] || 0) - (coreB[i] || 0) || a.localeCompare(b)
  if (!preA.length || !preB.length) return preB.length - preA.length
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const [x, y] = [preA[i], preB[i]]
    if (x === y) continue
    const [nx, ny] = [/^\d+$/u.test(x), /^\d+$/u.test(y)]
    if (nx && ny) return Number(x) - Number(y)
    if (nx || ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return preA.length - preB.length
}

// The latest version an account published, not trusted publishing's CI: the
// latest dist-tag's, if an account published it, else the highest below it an
// account published, a release before a prerelease (any, if none is below).
function accountLatest(doc) {
  const latest = doc?.['dist-tags']?.latest
  const own = Object.entries(doc?.versions ?? {}).filter(([, meta]) => meta?._npmUser?.name && !meta._npmUser.trustedPublisher)
  const below = own.filter(([version]) => !latest || compareVersions(version, latest) <= 0)
  const releases = (below.length ? below : own).filter(([version]) => !version.split('+')[0].includes('-'))
  const pool = [releases, below, own].find((list) => list.length)
  const pick = own.find(([version]) => version === latest) ?? pool?.reduce((a, b) => (compareVersions(a[0], b[0]) >= 0 ? a : b))
  if (!pick) return null
  const [version, meta] = pick
  return { version, publisher: meta._npmUser.name, time: doc.time?.[version] ?? null }
}

const names = (list) => (Array.isArray(list) ? list : []).map((user) => user?.name).filter(Boolean)

const packages = Array.from({ length: ranked.length })
let oldest = null
let next = 0
let done = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < ranked.length) {
    const index = next++
    const [name, downloads] = ranked[index]
    const { packument: doc, fetched } = await packument(name)
    if (oldest === null || fetched < oldest) oldest = fetched
    const latest = doc?.['dist-tags']?.latest
    const version = latest && doc.versions?.[latest]
    packages[index] = {
      rank: index + 1,
      name,
      downloads,
      ...(doc ? {} : { missing: true }),
      ...(doc?.time?.unpublished ? { unpublished: true } : {}),
      latest: latest ?? null,
      maintainers: [...new Set(names(doc?.maintainers))].toSorted(),
      publisher: version?._npmUser?.name ?? null,
      ...(version?._npmUser?.trustedPublisher ? { trustedPublisher: version._npmUser.trustedPublisher.id ?? true } : {}),
      ...(version?.dist?.attestations ? { provenance: true } : {}),
      versions: Object.keys(doc?.versions ?? {}).length,
      accountLatest: accountLatest(doc),
      publishers: publishers(doc),
    }
    if (++done % 500 === 0) console.error(`${done}/${ranked.length}`)
  }
}))

await writeFile(join(dataDir, 'packages.json'), `[\n${packages.map((p) => JSON.stringify(p)).join(',\n')}\n]\n`)
await writeFile(join(dataDir, 'source.json'), `${JSON.stringify({ counts: countsVersion && `download-counts@${countsVersion}`, fetched: oldest?.slice(0, 10) ?? null }, null, 2)}\n`)
