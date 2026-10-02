// The directories pnpm takes for a workspace's projects: the root, and each
// whose package.json a glob of pnpm-workspace.yaml's `packages` takes, as
// @pnpm/fs.find-packages globs for them with tinyglobby (pnpm 9: fast-glob), or
// as pnpm 12 walks (wax). pnpm 11 matches `!` globs with micromatch, dotted
// names and all.

import { compareNames, normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { escape, reach } from '../matcher.js'
import { typeOf } from '../project.js'

const UNSUPPORTED = /[?[\]{}()\\]/u

// `*` takes line terminators too, and a leading dot only with `dot`.
const NAME = (name, dot) => new RegExp(`^${name.startsWith('*') && !dot ? '(?!\\.)' : ''}${name.split('*').map(escape).join('[^/]*')}$`, 'u')

// A glob normalized as tinyglobby does, as `**` or a pattern per name.
function compile(glob, where, dot) {
  const path = normalize(`./${glob}/package.json`)
  if (path.startsWith('../')) throw new DeptreeError(`${quote(glob)} reaches outside the workspace's directory, which is not supported`, where)
  const names = path.split('/')
  if (glob === '' || glob.startsWith('/') || UNSUPPORTED.test(glob) || glob.includes('!') || names.some((name) => name !== '**' && name.includes('**'))) {
    throw new DeptreeError(`${quote(glob)} is not supported: only \`*\`, \`**\` as a whole name and a leading \`!\` are`, where)
  }
  return { names: names.map((name) => (name === '**' ? name : NAME(name, dot))), dot, raw: names }
}

const takes = (glob, names) => reach(glob.names, names, glob.dot).at(-1)

// tinyglobby's partial matcher: a `**` that takes no name is not tried, so a
// name with a leading dot a `**` stands before is never walked into.
function enters({ names: glob, dot }, names) {
  for (const [i, name] of names.entries()) {
    if (i === glob.length) return false
    if (glob[i] === '**') return dot || !name.startsWith('.')
    if (!glob[i].test(name)) return false
  }
  return true
}

// A manifest in a directory tinyglobby walks into is not ignored for what
// find-packages ignores; pnpm 12 drops it whatever the globs say. `wild` is
// whether a glob with a `*` takes it (manifestOf).
function compileAll(packages, major) {
  if (major < 10) return compile9(packages)
  const twelve = major >= 12
  const [enters_, ignored_, dropped] = twelve ? [enters12, underLeftOut, underLeftOut] : [enters, ignored, () => false]
  const include = []
  const exclude = []
  for (const glob of packages ?? []) {
    const negative = glob.startsWith('!')
    const compiled = compile(negative ? glob.slice(1) : glob, 'pnpm-workspace.yaml: packages', negative && major >= 11)
    ;(negative ? exclude : include).push({ ...compiled, wild: twelve && glob.includes('*') })
  }
  return {
    walked: (names) => include.some((glob) => enters_(glob, names)) && !ignored_(names),
    taken: takenBy(include, exclude, dropped),
    wild: (names) => include.some((glob) => glob.wild && takes(glob, names)),
    manifests: MANIFESTS,
    through: [],
  }
}

const takenBy = (include, exclude, dropped) => (names) => include.some((glob) => takes(glob, names)) && !exclude.some((glob) => takes(glob, names)) && !dropped(names)

const startsWith = (names, start) => start.length <= names.length && start.every((name, i) => names[i] === name)

// fast-glob's partial matcher: past the names before its first `**`, any.
function partial({ names: glob, raw }, names) {
  const star = raw.indexOf('**')
  if (star === -1 && glob.length <= names.length) return false
  if (star !== -1 && names.length > star) return true
  return names.every((name, i) => glob[i].test(name))
}

const isDynamic = (glob) => glob.raw.some((name) => name.includes('*'))

// pnpm 9 globs with fast-glob 3: a glob with no `*` it looks up where it
// leads, and one with a `*` it walks for from the names before that
// (`base`), from the top for all of them where one has none there. Under
// a base it walks into every directory its globs may reach (`partial`),
// those with a leading dot among them, but where the ignore globs take it
// with `**` taking no leading dot, or where a `!` glob takes it whole;
// and takes a manifest a glob takes and no `!` glob, nor an ignore glob,
// with `**` and `*` taking leading dots. It reads every manifest a
// directory has, so one but package.json is the one refused (MANIFESTS_9),
// and fails on a glob that leads through a file (`through`).
function compile9(packages) {
  const where = 'pnpm-workspace.yaml: packages'
  const include = []
  const exclude = []
  const excludeWhole = []
  for (const glob of packages ?? []) {
    if (glob.startsWith('!')) {
      exclude.push(compile(glob.slice(1), where, true))
      excludeWhole.push(compile(glob.slice(1), where, false))
    } else include.push(compile(glob, where, false))
  }
  const dynamic = include.filter(isDynamic)
  const baseOf = (glob) => glob.raw.slice(0, glob.raw.findIndex((name) => name.includes('*')))
  const groups = Map.groupBy(dynamic, (glob) => baseOf(glob).join('/'))
  const tasks = groups.has('') ? [{ base: [], globs: dynamic }] : [...groups.values()].map((globs) => ({ base: baseOf(globs[0]), globs }))
  const skipped = (names) => ignored(names) || (MANIFESTS.includes(names.at(-1)) && excludeWhole.some((glob) => takes(glob, [...names.slice(0, -1), 'package.json'])))
  // A task walks into a directory only where it walked into its parent; each
  // answer is kept for the walk.
  const reacher = ({ base, globs }) => {
    const known = new Map()
    const reaches = (names) => {
      if (names.length <= base.length) return names.length === base.length && startsWith(names, base)
      const key = names.join('/')
      if (!known.has(key)) known.set(key, reaches(names.slice(0, -1)) && globs.some((glob) => partial(glob, names)) && !skipped(names))
      return known.get(key)
    }
    return reaches
  }
  const reachers = tasks.map(reacher)
  const through = [...tasks.map((task) => task.base), ...include.filter((glob) => !isDynamic(glob)).map((glob) => glob.raw.slice(0, -1))]
  return {
    walked: (names) => through.some((path) => startsWith(path, names)) || reachers.some((reaches) => reaches(names)),
    taken: takenBy(include, exclude, underLeftOut),
    wild: () => false,
    manifests: MANIFESTS_9,
    through,
  }
}

// The first of `globs.manifests` that is a file; pnpm 12 reads the first there
// where a `wild` glob takes the directory, failing where it is not a file.
function manifestOf(project, globs, names, entries) {
  for (const name of globs.manifests) {
    if (!entries.includes(name)) continue
    const type = typeOf(project, `/${[...names, name].join('/')}`)
    if (type === 'file') return name
    if (type !== undefined && globs.wild([...names, 'package.json'])) throw new DeptreeError(`pnpm 12 reads this as a manifest, and fails on it as a ${type}`, quote([...names, name].join('/')))
  }
  return undefined
}

// Two paths in the order of their names, as pnpm 12 has them.
function byNames(a, b) {
  const x = a.split('/')
  const y = b.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return compareNames(x[i], y[i])
  return x.length - y.length
}

// find-packages leaves out what is under these, by globs whose `**`, as
// tinyglobby reads them, takes no name with a leading dot; as fast-glob
// reads them for a manifest, any (underLeftOut).
const LEFT_OUT = ['node_modules', 'bower_components']
const IGNORED = LEFT_OUT.map((name) => ({ names: ['**', NAME(name, false), '**'], dot: false }))
const ignored = (names) => IGNORED.some((glob) => takes(glob, names))

const underLeftOut = (names) => names.some((name) => LEFT_OUT.includes(name))

// pnpm 12 walks into a directory a glob's names before its last may take.
const enters12 = (glob, names) => reach(glob.names, names, glob.dot).slice(0, -1).some(Boolean)

export function checkWorkspace(ids, packages, major = 10) {
  const globs = compileAll(packages, major)
  for (const id of ids) {
    if (id === '.') continue
    const names = id.split('/')
    if (!names.every((_, i) => globs.walked(names.slice(0, i + 1))) || !globs.taken([...names, 'package.json'])) {
      throw new DeptreeError(`pnpm-workspace.yaml's packages ${packages === undefined ? 'are not set' : 'do not take this directory'}, so pnpm would not install it as a project`, `importers[${quote(id)}]`)
    }
  }
}

// The importer keys @preventive/lockfile takes for a project.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u
export function checkProjectId(id, where) {
  if (id.split('/').some((name) => name === '' || name === '.' || name === '..' || UNSAFE.test(name)) || /^[A-Za-z]:/u.test(id)) {
    throw new DeptreeError('expected a directory under the lockfile\'s, by its path from there in normal form, as a lockfile can key an importer', where)
  }
}

export const linkedManifest = (file) => new DeptreeError('a link pnpm would read a project\'s manifest through is not supported', quote(file))

// pnpm reads the first of these a project has; pnpm 9 each, so one but
// package.json is named first.
const MANIFESTS = ['package.json', 'package.json5', 'package.yaml']
const MANIFESTS_9 = ['package.json5', 'package.yaml', 'package.json']

// Every directory tinyglobby walks into is read, and no other. It walks into
// a node_modules only under a directory with a leading dot, which is
// refused, as what is installed there is no project buildPnpmTree builds.
export function findProjects(project, packages, major = 10) {
  const globs = compileAll(packages, major)
  for (const path of globs.through) {
    const end = path.findIndex((_, i) => typeOf(project, `/${path.slice(0, i + 1).join('/')}`) === 'file')
    if (end !== -1) throw new DeptreeError('a glob leads through this file, which pnpm 9 fails on', quote(path.slice(0, end + 1).join('/')))
  }
  const ids = []
  const pending = [{ names: [] }]
  while (pending.length > 0) {
    const { names, link } = pending.pop()
    const dir = names.join('/')
    const entries = project.readdir(`/${dir}`)
    const found = names.length === 0 || globs.taken([...names, 'package.json']) ? manifestOf(project, globs, names, entries) : undefined
    if (names.length === 0 && found === undefined) throw new DeptreeError('pnpm takes a workspace with no manifest at its root for one with no root project, which is not supported', quote('package.json'))
    if (found !== undefined) {
      const file = [...names, found].join('/')
      if (project.lstat(`/${file}`).type === 'symlink') throw linkedManifest(file)
      if (found !== 'package.json') throw new DeptreeError(`pnpm reads this project's ${found}, which is not supported`, quote(file))
      if (link !== undefined) throw new DeptreeError(`pnpm finds a project through this link, ${quote(dir)}, which is not supported`, quote(link))
      if (names.length > 0) {
        checkProjectId(dir, quote(dir))
        ids.push(dir)
      }
    }
    for (const entry of entries) {
      const at = [...names, entry]
      if (!globs.walked(at)) continue
      const path = at.join('/')
      const { type } = project.lstat(`/${path}`)
      const linked = type === 'symlink' && typeOf(project, `/${path}`) === 'directory'
      if (type !== 'directory' && !linked) continue
      if (entry === 'node_modules') throw new DeptreeError('pnpm-workspace.yaml\'s packages walk into this node_modules, which is not supported', quote(path))
      if (!linked) pending.push({ names: at, link })
      else if (link === undefined) pending.push({ names: at, link: path })
      else throw new DeptreeError(`a link to a directory in one tinyglobby follows, ${quote(path)}, is not supported`, quote(link))
    }
  }
  return ['.', ...major >= 12 ? ids.sort(byNames) : ids.sort()]
}
