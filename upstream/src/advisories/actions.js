import { assertRepo, assertion, isRefName, isSha } from '../args.js'
import { valid, validRange } from '../semver.js'
import { inRange, overlap } from './common.js'
import { bySemver, coversPlaceholder, repositoryAdvisories } from './github.js'
import { packageRecords, toAdvisory } from './osv.js'

const ACTIONS = 'GitHub Actions'

// OSV's `1.2` is 1.2.0, not semver's 1.2.x.
const full = (version) => (/^\d+(?:\.\d+)?$/u.test(version) ? `${version}.0.0`.split('.').slice(0, 3).join('.') : version)

// OSV can't match these versions itself: its records' ECOSYSTEM ranges, as
// semver's, and whether one is still open, no release having fixed it.
function readAffected(entry) {
  const ranges = []
  let open = false
  for (const { type, events } of entry.ranges ?? []) {
    if (type !== 'ECOSYSTEM' || !Array.isArray(events)) continue
    let from
    for (const event of events) {
      if (typeof event?.introduced === 'string') from = full(event.introduced)
      else if (from !== undefined && (typeof event?.fixed === 'string' || typeof event?.last_affected === 'string')) {
        ranges.push(event.fixed === undefined ? `>=${from} <=${full(event.last_affected)}` : `>=${from} <${full(event.fixed)}`)
        from = undefined
      }
    }
    if (from !== undefined) ranges.push(`>=${from}`)
    open ||= from !== undefined
  }
  const listed = new Set((Array.isArray(entry.versions) ? entry.versions : []).map((version) => full(String(version).replace(/^v/iu, ''))))
  // Listed versions alone, or with neither, every version.
  if (ranges.length === 0) return { listed, range: null, open: listed.size === 0, all: listed.size === 0 }
  const range = ranges.join(' || ')
  // A range semver can't read covers every version.
  return { listed, range, open, all: validRange(range, { loose: true }) === null }
}

const isPartial = (tag) => /^\d+(?:\.\d+)?$/u.test(tag)

// A commit may be of any release. A branch, or stasis's 0.0.0, is at its
// newest, so only what no release has fixed covers it. A moving tag, `v4`
// or `v4.1`, may be anywhere in its line.
function covers(version, { listed, range, open, all }) {
  if (isSha(version)) return true
  const tag = version.replace(/^v/iu, '')
  if (version === '0.0.0' || (!isPartial(tag) && valid(tag, { loose: true }) === null)) return open
  if (all) return true
  if (isPartial(tag)) return [...listed].some((listedVersion) => inRange(listedVersion, `${tag}.x`)) || (range !== null && overlap(range, `${tag}.x`))
  return listed.has(tag) || (range !== null && inRange(tag, range))
}

async function actionRows(asked, details) {
  const rows = []
  for (const { record, names } of await packageRecords(ACTIONS, [...asked.keys()])) {
    for (const name of names) {
      const entries = (record.affected ?? []).filter((entry) => entry?.package?.ecosystem === ACTIONS && entry.package.name === name).map(readAffected)
      const versions = asked.get(name).filter((version) => entries.some((entry) => covers(version, entry)))
      if (versions.length > 0) rows.push(toAdvisory(ACTIONS, name, versions, record, details))
    }
  }
  return rows
}

// GitHub repositories as dependencies: OSV's records of them as Actions,
// but of those `internal`, and every range their own advisories list,
// whichever package it names.
export const GITHUB = {
  repositoryOnly: true,
  assertName: assertRepo,
  nameKey: (repo) => repo.toLowerCase(),
  assertVersion: assertion('a version or a branch name', isRefName),
  advisories: async (asked, { github, details, cache, internal }) => {
    const external = new Map(asked)
    for (const name of internal) external.delete(name)
    return (await Promise.all([
      actionRows(external, details),
      repositoryAdvisories(github, asked, { repoOf: (repo) => repo, versionsIn: bySemver(coversPlaceholder), details, cache }),
    ])).flat()
  },
}
