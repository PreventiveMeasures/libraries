import assert from 'node:assert/strict'

import { assertArgs, assertBoolean, assertRepo, assertion, optional } from '../args.js'
import { byNumbers, order } from './common.js'
import { GITHUB, assertClient } from './github.js'
import { NPM } from './npm.js'
import { CARGO, COMPOSER } from './osv.js'

const ECOSYSTEMS = { npm: NPM, cargo: CARGO, composer: COMPOSER, github: GITHUB }
const assertEcosystem = assertion(`one of ${Object.keys(ECOSYSTEMS).join(', ')}`, (value) => typeof value === 'string' && Object.hasOwn(ECOSYSTEMS, value))
const assertVersions = assertion('a non-empty array', (value) => Array.isArray(value) && value.length > 0)

// Ecosystem → name → { versions, github? }, a name given twice merged.
// Every package is checked before any is used.
function collect(packages) {
  assert.ok(typeof packages?.[Symbol.iterator] === 'function' && typeof packages !== 'string', 'advisories: packages must be an iterable of { ecosystem, name, github?, versions }')
  const byEcosystem = new Map()
  for (const pkg of packages) {
    assertArgs('advisories', pkg, { ecosystem: assertEcosystem, name: null, github: optional(assertRepo), versions: assertVersions }, 'package')
    const { assertName, assertVersion } = ECOSYSTEMS[pkg.ecosystem]
    assertName('advisories', 'package.name', pkg.name)
    for (const version of pkg.versions) assertVersion('advisories', 'package.versions', version)
    assert.ok(pkg.ecosystem !== 'github' || pkg.github === undefined, 'advisories: a github package is its own repository, and takes no package.github')
    const named = byEcosystem.get(pkg.ecosystem) ?? byEcosystem.set(pkg.ecosystem, new Map()).get(pkg.ecosystem)
    const entry = named.get(pkg.name) ?? named.set(pkg.name, { versions: new Set() }).get(pkg.name)
    assert.ok(pkg.github === undefined || entry.github === undefined || entry.github === pkg.github, `advisories: ${pkg.name} is given two repositories`)
    entry.github ??= pkg.github
    for (const version of pkg.versions) entry.versions.add(version)
  }
  return byEcosystem
}

export async function advisories(packages, options = {}) {
  assertArgs('advisories', options, { github: optional(assertClient), repoAdvisories: optional(assertBoolean) })
  assert.ok(!options.repoAdvisories || options.github, 'advisories: repoAdvisories needs a github client')
  const byEcosystem = collect(packages)
  assert.ok(!byEcosystem.has('github') || options.github, 'advisories: github packages need a github client')
  const found = await Promise.all([...byEcosystem].map(async ([ecosystem, named]) => {
    const { compare = byNumbers, advisories: lookUp } = ECOSYSTEMS[ecosystem]
    const names = [...named.keys()].toSorted()
    const asked = new Map(names.map((name) => [name, [...named.get(name).versions].toSorted(compare)]))
    const known = new Map(names.filter((name) => named.get(name).github).map((name) => [name, named.get(name).github]))
    const rows = await lookUp(asked, { github: options.github, repoAdvisories: options.repoAdvisories === true, known })
    return rows.map((row) => ({ ecosystem, ...row }))
  }))
  return found.flat().filter((row) => row.versions.length > 0).toSorted((a, b) => order(a.ecosystem, b.ecosystem) || order(a.name, b.name))
}
