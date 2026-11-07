// The directories pnpm takes for a workspace's projects: the root, and each
// whose package.json a glob of pnpm-workspace.yaml's `packages` takes, as
// @pnpm/fs.find-packages globs for them with tinyglobby, or
// as pnpm 12 walks (wax). pnpm 11 matches `!` globs with micromatch, dotted
// names and all.

import { compareNames, normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { reach, wildcard } from '../matcher.js'
import { UNSAFE, isInside } from '../mount.js'
import { typeOf } from '../project.js'

const UNSUPPORTED = /[?[\]{}()\\]/u

// `*` takes line terminators too, and a leading dot only with `dot`.
function compileName(name, dot) {
  const matches = wildcard(name)
  const undotted = name.startsWith('*') && !dot
  return { test: (entry) => !(undotted && entry.startsWith('.')) && matches(entry) }
}

// A glob normalized as tinyglobby does, as `**` or a pattern per name.
function compile(glob, where, dot) {
  const path = normalize(`./${glob}/package.json`)
  if (path.startsWith('../')) throw new DeptreeError(`${quote(glob)} reaches outside the workspace's directory, which is not supported`, where)
  const names = path.split('/')
  if (glob === '' || glob.startsWith('/') || UNSUPPORTED.test(glob) || glob.includes('!') || names.some((name) => name !== '**' && name.includes('**'))) {
    throw new DeptreeError(`${quote(glob)} is not supported: only \`*\`, \`**\` as a whole name and a leading \`!\` are`, where)
  }
  return { names: names.map((name) => (name === '**' ? name : compileName(name, dot))), dot, raw: names }
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
  }
}

const takenBy = (include, exclude, dropped) => (names) => include.some((glob) => takes(glob, names)) && !exclude.some((glob) => takes(glob, names)) && !dropped(names)

// The first of MANIFESTS that is a file; pnpm 12 reads the first there
// where a `wild` glob takes the directory, failing where it is not a file.
function manifestOf(project, globs, names, entries) {
  for (const name of MANIFESTS) {
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
// tinyglobby reads them, takes no name with a leading dot; pnpm 12 drops
// whatever is under them (underLeftOut).
const LEFT_OUT = ['node_modules', 'bower_components']
const IGNORED = LEFT_OUT.map((name) => ({ names: ['**', compileName(name, false), '**'], dot: false }))
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
export function checkProjectId(id, where) {
  if (!isInside(id) || UNSAFE.test(id) || /^[A-Za-z]:/u.test(id)) {
    throw new DeptreeError('expected a directory under the lockfile\'s, by its path from there in normal form, as a lockfile can key an importer', where)
  }
}

export const linkedManifest = (file) => new DeptreeError('a link pnpm would read a project\'s manifest through is not supported', quote(file))

// pnpm reads the first of these a project has.
const MANIFESTS = ['package.json', 'package.json5', 'package.yaml']

// Every directory tinyglobby walks into is read, and no other. It walks into
// a node_modules only under a directory with a leading dot, which is
// refused, as what is installed there is no project buildPnpmTree builds.
export function findProjects(project, packages, major = 10) {
  const globs = compileAll(packages, major)
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
      if (linked && link !== undefined) throw new DeptreeError(`a link to a directory in one tinyglobby follows, ${quote(path)}, is not supported`, quote(link))
      pending.push({ names: at, link: linked ? path : link })
    }
  }
  return ['.', ...major >= 12 ? ids.sort(byNames) : ids.sort()]
}
