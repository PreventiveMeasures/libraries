// The files pnpm's bin linking fixes (@pnpm/link-bins, bin-links' fixBin):
// no .bin is written, but the file of each command it links by a name is
// made executable and a CRLF ending its `#!` line made LF. pnpm 10 sets
// 0o755 and pnpm 11 adds 0o111, as pnpm 12 (its cmd-shim crate) does, which
// rewrites no `#!` line.
// Where any patch is configured, pnpm 10 and 11 build each package patched
// or with an install script, which links its own bins beside its children's
// before the patch; pnpm 12 links them together, with no build pass. pnpm 9
// links as pnpm 10 does, but fails on a bin that is a directory.

import { DeptreeError, quote } from '../error.js'
import { crlfShebang, fixShebang } from '../tarball.js'
import { UNKNOWN, binsOf, bundledCommands, commandsOf, compare, normalized, parseManifest } from './commands.js'
import { reachable } from './nm-hoist.js'

// The peers whose bins pnpm 11 links into a project's .bin.
function peersOf(children, nodes) {
  const byPath = new Map()
  for (const dir of children.values()) {
    const node = nodes.get(dir)
    if (node === undefined) continue
    const { peerDependencies, peerDependenciesMeta, dependencies, optionalDependencies } = node.pkg
    for (const name of Object.keys(peerDependencies)) {
      if (peerDependenciesMeta[name]?.optional || (dependencies[name] === undefined && optionalDependencies[name] === undefined)) continue
      const peer = name === node.name ? node.dir : node.children.get(name)
      if (peer !== undefined) byPath.set(`${node.modules}/${name}`, peer)
    }
  }
  return [...byPath.keys()].sort().map((path) => byPath.get(path))
}

// pnpm's pkgRequiresBuild.
export const requiresBuild = (manifest, files, major) => Boolean((manifest.scripts != null && (manifest.scripts.preinstall || manifest.scripts.install || manifest.scripts.postinstall))
  || (files.has('binding.gyp') && !(major >= 11 && manifest.gypfile === false)) || files.keys().some((path) => /^\.hooks[\\/]/u.test(path)))

// `contested` holds the files that may be fixed or not, and why; `ordered`
// is whether pnpm always comes to the commands in this order; `fixNode`
// whether pnpm 12 links a project's bins again, which fixes a direct
// dependency's `node` already linked.
function linker(major) {
  const fixed = new Map()
  const contested = new Map()
  const link = (commands, { ordered, where, fixNode = false }) => {
    const unknown = commands.some((command) => command.unknown)
    const best = new Map()
    for (const command of commands) {
      if (command.unknown) continue
      const tied = best.get(command.name)
      const order = tied === undefined ? 1 : compare(command, tied[0], where, major)
      if (order > 0) best.set(command.name, [command])
      else if (order === 0) tied.push(command)
    }
    for (const tied of best.values()) {
      // pnpm 11 and 12 link `node` with no fix of its file.
      if (major >= 11 && tied[0].name === 'node' && !(fixNode && tied.every((command) => command.direct !== false))) continue
      const unordered = new Set(tied.map(({ target }) => target)).size > 1 && (!ordered || tied.some((command) => command.unordered))
      for (const { target, owner } of unknown || unordered ? tied : tied.slice(0, 1)) {
        if (owner === undefined) continue
        if (unknown) contested.set(target, { owner, why: 'the bins of a directory outside the tree, which are not known here' })
        else if (unordered) contested.set(target, { owner, why: 'the order it reads a directory in, which varies' })
        else fixed.set(target, owner)
      }
    }
    return { names: new Set(best.keys()), unknown }
  }
  return { fixed, contested, link }
}

// The commands of a directory, read once for each package of `nodes`. A
// project or `link:` target, outside the tree: its bins may take any name
// where its package.json is not given (local.js).
function commandReader(nodes, projects, major) {
  const cache = new Map()
  return (dir, { normalize = false } = {}) => {
    const node = nodes.get(dir)
    if (node !== undefined) {
      if (!cache.has(dir)) cache.set(dir, commandsOf(dir, node.manifest, node.files, dir, quote(node.key), major))
      return cache.get(dir)
    }
    const manifest = projects.get(dir)
    if (manifest === undefined) return [UNKNOWN]
    const where = `manifests[${quote(dir)}]`
    return commandsOf(dir, normalize ? normalized(manifest, where) : manifest, undefined, undefined, where, major)
  }
}

// pnpm's preferDirectCmds for a project of `manifest`: of the commands of
// `entries`, [alias, directory], those of its own dependencies, then of the
// others those whose names none of them has.
function preferOwn(entries, manifest, commandsOfDir) {
  const own = new Set(Object.keys({ ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }))
  const commands = entries.flatMap(([alias, dir]) => commandsOfDir(dir).map((command) => ({ ...command, direct: own.has(alias) })))
  const names = new Set(commands.filter((command) => command.direct).map(({ name }) => name))
  return [...commands.filter((command) => command.direct), ...commands.filter((command) => !names.has(command.name))]
}

// The files pnpm runs fixBin on, as sets of paths by package directory.
// `building` is whether any patch is configured, `peers` autoInstallPeers.
export function binTargets({ nodes, projects, direct, links, publicHoist, building, peers, major }) {
  const commandsOfDir = commandReader(nodes, projects, major)
  // The lockfile has no hasBin for a directory, whose bins pnpm 12 reads.
  const mayHaveBin = (dir) => nodes.get(dir)?.pkg.hasBin === true || nodes.get(dir)?.pkg.resolution.type === 'directory'

  const { fixed, contested, link } = linker(major)

  for (const node of nodes.values()) {
    const where = quote(node.key)
    const children = [...node.children.values()]
    if (major >= 12) {
      // The order its children come in is a map's, which varies.
      const commands = children.filter(mayHaveBin).flatMap((dir) => commandsOfDir(dir))
      if (node.pkg.bundledDependencies !== undefined) commands.push(...bundledCommands(node, where, major))
      if (mayHaveBin(node.dir)) commands.push(...commandsOfDir(node.dir))
      link(commands, { ordered: false, where })
      continue
    }
    const withBins = children.filter((dir) => nodes.get(dir)?.pkg.hasBin).flatMap((dir) => commandsOfDir(dir))
    if (children.every((dir) => nodes.has(dir))) link(withBins, { ordered: true, where })
    else link(children.flatMap((dir) => commandsOfDir(dir, { normalize: true })), { ordered: false, where })
    if (node.pkg.bundledDependencies !== undefined) link(bundledCommands(node, where, major), { ordered: false, where })
    if (building && (node.pkg.patchHash !== undefined || requiresBuild(node.manifest, node.files, major))) {
      link([...withBins, ...commandsOfDir(node.dir)], { ordered: true, where })
    }
  }

  const PRIVATE = 'node_modules/.pnpm/node_modules/'
  const hoisted = [...links].filter(([path, dir]) => path.startsWith(PRIVATE) && nodes.get(dir)?.pkg.hasBin)
  link(hoisted.flatMap(([, dir]) => commandsOfDir(dir)), { ordered: true, where: quote(PRIVATE.slice(0, -1)) })

  const patched = [...nodes.values()].some((node) => node.pkg.patchHash !== undefined)
  for (const [id, children] of direct) {
    const where = `importers[${quote(id)}]`
    const peerDirs = major >= 11 && peers ? peersOf(children, nodes) : []
    let relink = major >= 12 && (patched || peerDirs.some(mayHaveBin))
    let linked
    if (id === '.' && publicHoist) {
      const manifest = projects.get('.')
      const own = new Set(Object.keys({ ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }))
      const isOwn = (path) => own.has(path.slice('node_modules/'.length))
      // pnpm 12 links what it hoists of the projects apart, before.
      const entries = [...links].filter(([path, dir]) => /^node_modules\/(?:@[^/]+\/)?[^/@.][^/]*$/u.test(path)
        && (major < 12 || isOwn(path) || mayHaveBin(dir)))
      relink ||= major >= 12 && entries.some(([path, dir]) => !isOwn(path) && mayHaveBin(dir))
      linked = link(preferOwn(entries.map(([path, dir]) => [path.slice('node_modules/'.length), dir]), manifest, commandsOfDir), { ordered: false, where, fixNode: relink })
    } else {
      const dirs = [...children.values()].filter((dir) => major < 11 || !nodes.has(dir) || (major >= 12 ? mayHaveBin(dir) : nodes.get(dir).pkg.hasBin))
      // pnpm 12 comes to them in the order of a map, which varies.
      linked = link(dirs.flatMap((dir) => commandsOfDir(dir)), { ordered: major < 12, where, fixNode: relink })
    }
    if (major >= 11 && peers) {
      // Where the names linked are not all known, neither are those left.
      const commands = peerDirs.flatMap((dir) => commandsOfDir(dir))
      link([...commands.filter(({ name }) => !linked.names.has(name)), ...linked.unknown ? [UNKNOWN] : []], { ordered: true, where })
    }
  }

  return fixedFiles(nodes, fixed, contested, major)
}

// The copies of one package pnpm's build pass makes hardlinks of the one it
// builds (hoisted.js): what is fixed in that one before, as each copy's own
// bins are where pnpm fills its node_modules, is in all; and so is what is
// fixed in any after. Where the copies it may build differ in what is fixed
// before, so may the outcome. A phase's marks are `before` that, or not, or
// a function of the package's build saying which. pnpm 11 links no file
// under a node_modules (`keepsModules`), which each copy keeps its own of.
function linkCopies(builds, phases, fixed, contested, { keepsModules, major }) {
  const ownerOf = new Map()
  for (const build of builds) {
    if (build.copies.length > 1) for (const copy of build.copies) ownerOf.set(copy, build)
  }
  const groups = new Map()
  const mark = (target, owner, before, why) => {
    const build = ownerOf.get(owner)
    if (build === undefined || (keepsModules && target.slice(owner.length + 1).split('/').includes('node_modules'))) {
      if (why === undefined) fixed.set(target, owner)
      else contested.set(target, { owner, why })
      return
    }
    if (!groups.has(build)) groups.set(build, [])
    groups.get(build).push({ rel: target.slice(owner.length + 1), owner, before: typeof before === 'function' ? before(build) : before, why })
  }
  for (const { fixed: phaseFixed, contested: phaseContested, before } of phases) {
    for (const [target, owner] of phaseFixed) mark(target, owner, before, undefined)
    for (const [target, { owner, why }] of phaseContested) mark(target, owner, before, why)
  }
  for (const [build, marks] of groups) {
    for (const rel of new Set(marks.map((item) => item.rel))) {
      const mine = marks.filter((item) => item.rel === rel && (!item.before || build.candidates.includes(item.owner)))
      const after = mine.filter((item) => !item.before)
      const before = mine.filter((item) => item.before)
      const beforeFixed = new Set(before.filter((item) => item.why === undefined).map(({ owner }) => owner))
      let why
      if (!after.some((item) => item.why === undefined)) {
        why = after.find((item) => item.why !== undefined)?.why ?? before.find((item) => item.why !== undefined)?.why
        if (why === undefined && beforeFixed.size === 0) continue
        if (why === undefined && beforeFixed.size < build.candidates.length) why = `which of its copies pnpm ${major} builds, which turns on its build order and is not followed here`
      }
      for (const copy of build.copies) {
        if (why === undefined) fixed.set(`${copy}/${rel}`, copy)
        else contested.set(`${copy}/${rel}`, { owner: copy, why })
      }
    }
  }
}

// pnpm's hoisted linker links the bins of each node_modules it fills, by
// what it reads there, as it fills it; then each project's again, with its
// links in, a command of its own dependencies over any other. `modules` are
// those node_modules, each with its packages by alias, and its project's
// package.json where it is a project's. Between the two, where any patch is
// configured, each package of `builds` links its dependencies' bins and its
// own (hoisted.js), as the isolated linker's build does.
export function hoistedBinTargets({ nodes, projects, modules, builds = [], hardlinks = true, keepsModules = false, idOf = (key) => key, major }) {
  const commandsOfDir = commandReader(nodes, projects, major)
  const filling = linker(major)
  const projectsAgain = linker(major)
  for (const { dir, entries, manifest } of modules) {
    const where = quote(dir)
    if (manifest === undefined) {
      filling.link(entries.flatMap(([, target]) => commandsOfDir(target)), { ordered: false, where })
      continue
    }
    projectsAgain.link(preferOwn(entries, manifest, commandsOfDir), { ordered: false, where })
  }
  // A package's dependencies are built first, but for those it is built
  // before or after as they depend on each other.
  // What each snapshot reaches through the copies' dependencies, each taken
  // for the copies of its id.
  const pkgs = new Map([...nodes.values()].map((node) => [idOf(node.key), node.pkg]))
  const edges = (id) => Object.values({ ...pkgs.get(id)?.dependencies, ...pkgs.get(id)?.optionalDependencies }).map(idOf)
  const building = builds.map((build) => {
    const where = quote(build.key)
    const node = nodes.get(build.candidates[0])
    const { fixed, contested, link } = linker(major)
    link([...build.children.filter(([, dir]) => nodes.get(dir)?.pkg.hasBin).flatMap(([, dir]) => commandsOfDir(dir)), ...commandsOfDir(node.dir)], { ordered: true, where })
    if (node.pkg.bundledDependencies !== undefined) link(bundledCommands(node, where, major), { ordered: false, where })
    // Not linked to the others, the copy built alone has its own bins fixed.
    if (!hardlinks && build.candidates.length > 1) {
      for (const [target, owner] of fixed) {
        if (owner !== node.dir) continue
        fixed.delete(target)
        for (const copy of build.candidates) contested.set(`${copy}${target.slice(owner.length)}`, { owner: copy, why: 'which of its copies pnpm 10 builds, which turns on its build order and is not followed here' })
      }
    }
    return { fixed, contested, before: (other) => other !== build && reachable(edges(idOf(other.key)), edges).has(idOf(build.key)) }
  })
  const fixed = new Map()
  const contested = new Map()
  linkCopies(hardlinks ? builds : [], [{ ...filling, before: true }, ...building, { ...projectsAgain, before: false }], fixed, contested, { keepsModules, major })
  return fixedFiles(nodes, fixed, contested, major)
}

function fixedFiles(nodes, fixed, contested, major) {
  // pnpm 9 and 12 read each linked file's `#!` line. '' is the package.
  const checkDirectory = (node, path) => {
    if (major >= 10 && major < 12) return
    const prefix = `${path}/`
    if (path === '' || node.files.keys().some((name) => name.startsWith(prefix))) {
      throw new DeptreeError(`its bin ${quote(path === '' ? '.' : path)} is a directory, which pnpm ${major} fails on`, quote(node.key))
    }
  }
  for (const [target, { owner, why }] of contested) {
    const node = nodes.get(owner)
    const path = target.slice(owner.length + 1)
    checkDirectory(node, path)
    const file = node.files.get(path)
    if (fixed.has(target) || file?.data === undefined) continue
    if (executableMode(file.mode, major) === file.mode && (major >= 12 || (crlfShebang(file.data) === -1 && node.pkg.patchHash === undefined))) continue
    throw new DeptreeError(`whether pnpm makes ${quote(path)} executable turns on ${why}`, quote(node.key))
  }
  const byNode = new Map()
  for (const [target, owner] of fixed) {
    const path = target.slice(owner.length + 1)
    checkDirectory(nodes.get(owner), path)
    if (nodes.get(owner).files.get(path)?.data === undefined) continue
    if (!byNode.has(owner)) byNode.set(owner, new Set())
    byNode.get(owner).add(path)
  }
  return byNode
}

export const executableMode = (mode, major) => (major >= 11 ? mode | 0o111 : 0o755)

// pnpm reads and writes the file as UTF-8, which changes one that is not.
export function fixBin(file, where, major) {
  const mode = executableMode(file.mode, major)
  return { data: major >= 12 ? file.data : fixShebang(file.data, 'a bin with a CRLF `#!` line is not UTF-8, which pnpm would rewrite', where), mode }
}

const BIN_FIELDS = (manifest) => JSON.stringify([manifest.name, manifest.version, manifest.bin, manifest.directories?.bin])

// A patch is applied between two links of its package's bins, so it may not
// change what either does. It gives back the patched package.json.
export function checkPatchOfBins(node, patched, targets, where, major) {
  const file = patched.get('package.json')
  if (file?.data === undefined) throw new DeptreeError('the patch removes package.json', where)
  const manifest = file.data === node.files.get('package.json').data ? node.manifest : parseManifest(file, where)
  if (BIN_FIELDS(manifest) !== BIN_FIELDS(node.manifest)) throw new DeptreeError('the patch changes the name, version or bins package.json gives, which pnpm reads both before and after it', where)
  const was = binsOf(node, node.manifest, node.files, major)
  const is = binsOf(node, manifest, patched, major)
  for (const path of new Set([...was.keys(), ...is.keys()])) {
    if (was.has(path) !== is.has(path)) throw new DeptreeError(`the patch changes whether ${quote(path)} is a bin, which pnpm reads both before and after it`, where)
    if (JSON.stringify(was.get(path)) !== JSON.stringify(is.get(path))) throw new DeptreeError(`the patch changes the commands that name ${quote(path)}, or the name or version they are ranked by, which pnpm reads both before and after it`, where)
    if ((node.files.get(path)?.data !== undefined) !== (patched.get(path)?.data !== undefined)) {
      throw new DeptreeError(`the patch makes or removes ${quote(path)}, which a bin names, and which pnpm links before and after it`, where)
    }
  }
  if (major >= 12) return manifest
  for (const path of targets) {
    const before = node.files.get(path).data
    const after = patched.get(path).data
    if (before !== after && (crlfShebang(before) !== -1 || crlfShebang(after) !== -1)) throw new DeptreeError(`the patch changes ${quote(path)}, a bin with a CRLF \`#!\` line, which pnpm rewrites before and after it`, where)
  }
  return manifest
}
