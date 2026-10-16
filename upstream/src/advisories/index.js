import assert from 'node:assert/strict'

import { assertArgs, assertBoolean, assertRepo, assertion, isIterable, optional, sameName } from '../args.js'
import { assertCache } from '../cache.js'
import { order } from './common.js'
import { GITHUB, SOLDEER, assertClient } from './github.js'
import { NPM } from './npm.js'
import { CARGO, COMPOSER, first } from './osv.js'

const ECOSYSTEMS = { npm: NPM, cargo: CARGO, composer: COMPOSER, soldeer: SOLDEER, github: GITHUB }
const byNumbers = new Intl.Collator('en', { numeric: true }).compare
const assertEcosystem = assertion(`one of ${Object.keys(ECOSYSTEMS).join(', ')}`, (value) => typeof value === 'string' && Object.hasOwn(ECOSYSTEMS, value))
const assertVersions = assertion('a non-empty array', (value) => Array.isArray(value) && value.length > 0)

// Ecosystem -> name -> { versions, github? }, a name given twice merged.
// Every package is checked before any is used.
function collect(packages) {
  assert.ok(isIterable(packages), 'advisories: packages must be an iterable of { ecosystem, name, github?, versions }')
  const byEcosystem = new Map()
  for (const pkg of packages) {
    assertArgs('advisories', pkg, { ecosystem: assertEcosystem, name: null, github: optional(assertRepo), versions: assertVersions }, 'package')
    const { assertName, assertVersion } = ECOSYSTEMS[pkg.ecosystem]
    assertName('advisories', 'package.name', pkg.name)
    for (const version of pkg.versions) assertVersion('advisories', 'package.versions', version)
    assert.ok(pkg.ecosystem !== 'github' || pkg.github === undefined, 'advisories: a github package is its own repository, and takes no package.github')
    const named = byEcosystem.get(pkg.ecosystem) ?? byEcosystem.set(pkg.ecosystem, new Map()).get(pkg.ecosystem)
    // A repository's name is GitHub's, in any case: the first spelling stands.
    const name = pkg.ecosystem === 'github' ? [...named.keys()].find((known) => sameName(known, pkg.name)) ?? pkg.name : pkg.name
    const entry = named.get(name) ?? named.set(name, { versions: new Set() }).get(name)
    assert.ok(pkg.github === undefined || entry.github === undefined || sameName(entry.github, pkg.github), `advisories: ${pkg.name} is given two repositories`)
    entry.github ??= pkg.github
    for (const version of pkg.versions) entry.versions.add(version)
  }
  return byEcosystem
}

// Which row of an advisory stands for it: npm's registry's, then OSV's, by
// its records' rank (RustSec's, the GHSA, the rest), then its repository's.
const SOURCES = ['registry', 'osv', 'repository']
const before = (a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || (a.source === 'osv' && b.source === 'osv' ? first(a, b) : 0)
const sameAdvisory = (a, b) => a.id === b.id || a.aliases.includes(b.id) || b.aliases.includes(a.id)
const FILLED = ['title', 'details', 'severity', 'informational']

// Rows of one advisory as one: the first's, what it lacks from the first of
// the rest that has it (a CVSS score and its vector together), the others'
// ids among its aliases, and all their ranges (` || `), CWEs and versions
// (in the order `asked` has them).
function joinRows([head, ...rest], asked) {
  const all = [head, ...rest]
  const aliases = new Set([...head.aliases, ...rest.flatMap((row) => [row.id, ...row.aliases])])
  aliases.delete(head.id)
  const ranges = [...new Set(all.map((row) => row.range).filter((range) => range !== undefined))]
  const versions = new Set(all.flatMap((row) => row.versions))
  const joined = { ...head, aliases: [...aliases], cwe: [...new Set(all.flatMap((row) => row.cwe))], versions: asked.filter((version) => versions.has(version)) }
  for (const key of FILLED) {
    const from = joined[key] === undefined && rest.find((row) => row[key] !== undefined)
    if (from) joined[key] = from[key]
  }
  // A score with its own vector, never another's: the first row's that has
  // a score, else the first vector (OSV's records have no score).
  const scored = all.find((row) => row.cvss !== undefined) ?? all.find((row) => row.cvssVector !== undefined)
  delete joined.cvss
  delete joined.cvssVector
  if (scored?.cvss !== undefined) joined.cvss = scored.cvss
  if (scored?.cvssVector !== undefined) joined.cvssVector = scored.cvssVector
  // A range of none ('') covers every version, as they then do together.
  if (ranges.length > 0) joined.range = ranges.includes('') ? '' : ranges.join(' || ')
  return joined
}

// One row for each advisory on a package, where its sources answer more than
// one: npm's registry one per range, and OSV's record of it, or its
// repository, another for the versions they cover beyond that. A package's
// rows are one advisory where they have the same id, or one's id is among
// the other's aliases, directly or through others; the row standing for
// them is the first `before`, and they keep the place of the first answered.
function oneRowPerAdvisory(rows, asked) {
  return [...Map.groupBy(rows, (row) => row.name).values()].flatMap((named) => {
    const groups = []
    for (const row of named) {
      const [group, ...others] = groups.filter((known) => known.some((other) => sameAdvisory(row, other)))
      if (!group) {
        groups.push([row])
        continue
      }
      for (const other of others) groups.splice(groups.indexOf(other), 1)
      group.push(...others.flat(), row)
    }
    return groups.map((group) => (group.length === 1 ? group[0] : joinRows(group.toSorted(before), asked.get(group[0].name))))
  })
}

export async function advisories(packages, options = {}) {
  assertArgs('advisories', options, { github: optional(assertClient), repoAdvisories: optional(assertBoolean), details: optional(assertBoolean), osv: optional(assertBoolean), cache: optional(assertCache) })
  assert.ok(!options.repoAdvisories || options.github, 'advisories: repoAdvisories needs a github client')
  const byEcosystem = collect(packages)
  for (const ecosystem of byEcosystem.keys()) assert.ok(!ECOSYSTEMS[ecosystem].repositoryOnly || options.github, `advisories: ${ecosystem} packages need a github client`)
  const found = await Promise.all([...byEcosystem].map(async ([ecosystem, named]) => {
    const { compare = byNumbers, advisories: find } = ECOSYSTEMS[ecosystem]
    const names = [...named.keys()].toSorted()
    const asked = new Map(names.map((name) => [name, [...named.get(name).versions].toSorted(compare)]))
    const known = new Map(names.filter((name) => named.get(name).github).map((name) => [name, named.get(name).github]))
    const rows = await find(asked, { github: options.github, repoAdvisories: options.repoAdvisories === true, details: options.details === true, osv: options.osv === true, known, cache: options.cache })
    return oneRowPerAdvisory(rows.filter((row) => row.versions.length > 0), asked).map((row) => ({ ecosystem, ...row }))
  }))
  return found.flat().toSorted((a, b) => order(a.ecosystem, b.ecosystem) || order(a.name, b.name))
}
