// Two trees taken from different roots lined up: the directory one's files sit
// under in the other (`root`), and each old path as the new tree lays it out.

export function throughRoot(root, path) {
  if (!root) return path
  if (root.base === '') return `${root.other}${path}`
  return path.startsWith(root.base) ? path.slice(root.base.length) : null
}

// Each old path as the new tree lays it out: through the root where the new
// tree has it there, else as it is where it has that, else through the root,
// one outside it a `../` further out, clear of every path taken.
function rootPaths(base, other, root) {
  const paths = new Map(), taken = new Set()
  let moved = 0
  for (const path of base) {
    const to = throughRoot(root, path)
    if (to === null || !other.has(to)) continue
    paths.set(path, to)
    taken.add(to)
    if (to !== path) moved++
  }
  for (const path of base) {
    if (paths.has(path) || !other.has(path) || taken.has(path)) continue
    paths.set(path, path)
    taken.add(path)
  }
  const paired = paths.size
  for (const path of base) {
    if (paths.has(path)) continue
    let to = throughRoot(root, path) ?? `${'../'.repeat(root.base.split('/').length - 1)}${path}`
    while (other.has(to) || taken.has(to)) to = `../${to}`
    paths.set(path, to)
    taken.add(to)
  }
  return { paths, paired, moved }
}

export function detectRoot(basePaths, otherPaths) {
  const base = new Set(basePaths), other = new Set(otherPaths)
  const likeliest = (within, from) => {
    const counts = new Map()
    for (const path of within) {
      for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
        if (from.has(path.slice(at + 1))) counts.set(path.slice(0, at + 1), (counts.get(path.slice(0, at + 1)) ?? 0) + 1)
      }
    }
    let best = null, tied = false
    for (const [dir, count] of counts) {
      if (count > (counts.get(best) ?? 0)) [best, tied] = [dir, false]
      else if (count === counts.get(best)) tied = true
    }
    return tied ? null : best
  }
  const same = rootPaths(base, other, null).paired
  const found = [[{ base: '', other: likeliest(other, base) }, base], [{ base: likeliest(base, other), other: '' }, other]]
    .filter(([root]) => root.base !== null && root.other !== null)
    .map(([root, side]) => ({ root, side, ...rootPaths(base, other, root) }))
    .filter(({ side, paired, moved }) => paired > same && moved * 2 >= side.size)
  if (found.length === 2 && found[0].paired === found[1].paired) return null
  return found.toSorted((a, b) => b.paired - a.paired)[0]?.root ?? null
}

export function treeLayout(basePaths, otherPaths) {
  const base = [...basePaths], other = new Set(otherPaths)
  const root = detectRoot(base, other)
  return { root, paths: rootPaths(base, other, root).paths }
}

export function rootDir(root, dir) {
  if (!root || dir === '.') return dir
  const to = throughRoot(root, `${dir}/`)
  if (to === null) return `${'../'.repeat(root.base.split('/').length - 1)}${dir}`
  return to.slice(0, -1) || '.'
}

export function layoutDir({ root, paths }, dir, files) {
  if (!root || dir === '.') return dir
  for (const file of files) {
    const to = paths.get(`${dir}/${file}`)
    if (to?.endsWith(`/${file}`)) return to.slice(0, -file.length - 1)
  }
  return rootDir(root, dir)
}

export function layoutPackageDirs(baseDirs, otherDirs, layout) {
  if (!baseDirs && !otherDirs) return null
  const files = Map.groupBy([...baseDirs ?? []], ([, dir]) => dir)
  const dirs = new Map([...files].map(([dir, entries]) => [dir, layoutDir(layout, dir, entries.map(([path]) => path.slice(dir.length + 1)))]))
  return new Map([...[...baseDirs ?? []].map(([path, dir]) => [layout.paths.get(path) ?? path, dirs.get(dir)]), ...otherDirs ?? []])
}

export function rootLabel(root, prefix) {
  if (!root) return { prefix, from: null, to: null }
  const kept = prefix.startsWith(root.other) ? prefix : ''
  return { prefix: kept, from: `./${root.base}${kept.slice(root.other.length)}`, to: `./${kept || root.other}` }
}
