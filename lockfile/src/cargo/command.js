// What cargo's command line asks of each member it builds: `-p`, and
// `--features`, `--all-features` and `--no-default-features` handed out as
// cargo's Workspace::members_with_features does. A virtual workspace, or
// resolver 2 or 3, gives each selected member the features it has,
// `member/feature` as its own, and `dependency/feature` where it has that
// dependency. Resolver 1 with a root package gives `--features` to the
// package cargo runs in, which is resolved whether selected or not, and
// `member/feature` to the other members selected, which keep their default
// features.

import { LockfileError, quote } from '../error.js'
import { featureValue } from './featuremap.js'

const SPACE = /\p{White_Space}+/u

function parseFeatures(features) {
  if (!Array.isArray(features) || !features.every((item) => typeof item === 'string')) throw new TypeError('expected the features as strings')
  const texts = [...new Set(features.flatMap((item) => item.split(SPACE)).flatMap((item) => item.split(',')).filter(Boolean))]
  return texts.map((text) => {
    const value = featureValue(text)
    if (value.feature === undefined) throw new LockfileError(`${quote(text)}: \`dep:\` is not taken on the command line`, 'features')
    if (value.dep !== undefined && value.feature.includes('/')) throw new LockfileError(`${quote(text)} has more than one "/"`, 'features')
    return { text, ...value }
  })
}

// A name's dependency as cargo's summary keeps it last: the top tables,
// then each platform's in order, dependencies before build- and
// dev-dependencies there.
function lastDeclared(pkg) {
  const rank = (dep) => (dep.target === undefined ? ['normal', 'dev', 'build'] : ['normal', 'build', 'dev']).indexOf(dep.kind)
  const order = [...pkg.dependencies].sort((a, b) => {
    if ((a.target === undefined) !== (b.target === undefined)) return a.target === undefined ? -1 : 1
    if (a.target !== b.target) return a.target < b.target ? -1 : 1
    return rank(a) - rank(b)
  })
  return new Map(order.map((dep) => [dep.name, dep]))
}

function matching(pkg, values, found) {
  const deps = lastDeclared(pkg)
  const has = (feature) => feature in pkg.features || deps.get(feature)?.optional === true
  const own = []
  for (const value of values) {
    if (value.dep === undefined ? has(value.feature) : deps.has(value.dep)) own.push(value)
    else if (value.dep === pkg.name && has(value.feature)) own.push({ dep: undefined, feature: value.feature, weak: false })
    else continue
    found.add(value.text)
  }
  return own
}

export function membersWithFeatures(graph, options) {
  const { packages, allFeatures = false, noDefaultFeatures = false } = options
  if (!Array.isArray(packages) || packages.length === 0) throw new TypeError('expected the packages built, as keys of members')
  for (const key of packages) {
    if (!graph.members.includes(key)) throw new LockfileError(`${quote(key)} is not a member of the workspace`, 'packages')
  }
  const values = parseFeatures(options.features ?? [])
  const selected = graph.members.filter((key) => packages.includes(key))
  const result = new Map()
  if (graph.root === undefined || graph.resolver >= 2) {
    const found = new Set()
    for (const key of selected) result.set(key, { values: matching(graph.packages[key].manifest, values, found), allFeatures, defaultFeatures: !noDefaultFeatures })
    const unknown = values.filter((value) => !found.has(value.text))
    if (unknown.length > 0) throw new LockfileError(`no package selected has ${unknown.map((value) => quote(value.text)).join(', ')}`, 'features')
    return result
  }
  const current = options.current ?? graph.root
  if (!graph.members.includes(current)) throw new LockfileError(`${quote(current)} is not a member of the workspace`, 'current')
  const nameOf = (key) => graph.packages[key].name
  const specific = new Map()
  const cwd = []
  for (const value of values) {
    const member = value.dep !== undefined && graph.members.some((key) => key !== current && nameOf(key) === value.dep)
    if (member && selected.some((key) => nameOf(key) === value.dep)) {
      specific.set(value.dep, [...(specific.get(value.dep) ?? []), { dep: undefined, feature: value.feature, weak: false }])
    } else {
      cwd.push(value)
    }
  }
  for (const key of graph.members) {
    if (key === current) result.set(key, { values: cwd, allFeatures, defaultFeatures: !noDefaultFeatures })
    else if (selected.includes(key)) result.set(key, { values: specific.get(nameOf(key)) ?? [], allFeatures, defaultFeatures: true })
  }
  return result
}
