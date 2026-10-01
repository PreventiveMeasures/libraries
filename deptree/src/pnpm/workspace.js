// Which directories pnpm 10 takes for a workspace's projects, all of them
// under one lockfile: the root, always, and each directory whose
// package.json a glob of pnpm-workspace.yaml's `packages` takes, as
// @pnpm/fs.find-packages globs for them with tinyglobby — `<glob>/
// package.{json,yaml,json5}`, less anything under node_modules or
// bower_components. Without `packages`, or without pnpm-workspace.yaml,
// the root is the only project. pnpm finds them on disk: findProjects
// finds them so in the directories it is given, and checkWorkspace holds
// the lockfile's importers to them.
//
// A glob is read as tinyglobby reads it, normalized as a path first, as
// far as `*` and `**` go: `*` any run of characters in one directory's
// name, `**` a whole name for any number of directories, neither taking a
// name that starts with a dot, which only a glob that spells it takes; `!`
// in front leaves out what it takes, wherever it is in the list. Anything
// else a glob can say — `?`, a class, a brace, an extglob, an escape — is
// refused, and so is a glob reaching outside the workspace's directory.
// pnpm 11 leaves out what a `!` glob takes with micromatch too, a name
// starting with a dot and all.
//
// pnpm 12 finds them its own way (its projects walk, with wax), and the
// same but in four places: a `**` may take no name before one a glob
// spells with a leading dot; nothing under a node_modules or a
// bower_components is walked into or taken, wherever it is; where a glob
// with a `*` takes a directory, the first of its manifests that is there
// is read, which fails where it is not a file; and the projects come in
// the order of their paths by name.

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { escape } from '../matcher.js'
import { byBytes } from './order.js'
import { typeOf } from './project.js'

const UNSUPPORTED = /[?[\]{}()\\]/u

// A name's pattern: `*` any run of characters, line terminators among
// them, but not a leading dot unless `dot`.
const NAME = (name, dot) => new RegExp(`^${name.startsWith('*') && !dot ? '(?!\\.)' : ''}${name.split('*').map(escape).join('[^/]*')}$`, 'u')

// A glob as the names of the paths it takes, normalized as tinyglobby
// does: each `**`, or the pattern of one name; `dot` whether `**` takes a
// name with a leading dot.
function compile(glob, where, dot) {
  const path = normalize(`./${glob}/package.json`)
  if (path.startsWith('../')) throw new DeptreeError(`${quote(glob)} reaches outside the workspace's directory, which is not supported`, where)
  const names = path.split('/')
  if (glob === '' || glob.startsWith('/') || UNSUPPORTED.test(glob) || glob.includes('!') || names.some((name) => name !== '**' && name.includes('**'))) {
    throw new DeptreeError(`${quote(glob)} is not supported: only \`*\`, \`**\` as a whole name and a leading \`!\` are`, where)
  }
  return { names: names.map((name) => (name === '**' ? name : NAME(name, dot))), dot }
}

// Which places in a glob the path of `names` leads to: for each index,
// whether the glob's names before it take the path, a name at a time, in
// time the glob's length for each and with no recursion, however many
// `**` it has. A `**` may take no name, so reaching one reaches the next.
function reach({ names: glob, dot }, names) {
  let here = Array.from({ length: glob.length + 1 }, (_, g) => g === 0)
  let next = Array.from({ length: glob.length + 1 }, () => false)
  const onward = (places) => {
    for (let g = 0; g < glob.length; g++) if (places[g] && glob[g] === '**') places[g + 1] = true
  }
  onward(here)
  for (const name of names) {
    next.fill(false)
    for (let g = 0; g < glob.length; g++) {
      if (!here[g]) continue
      if (glob[g] !== '**') next[g + 1] ||= glob[g].test(name)
      else if (dot || !name.startsWith('.')) next[g] = true
    }
    onward(next)
    ;[here, next] = [next, here]
  }
  return here
}

// Whether a glob takes the path of `names`.
const takes = (glob, names) => reach(glob, names)[glob.names.length]

// Whether tinyglobby walks into the directory at `names` for a glob, as
// its partial matcher has it: name by name, each has to be taken by the
// glob's name in the same place, until a `**` there takes one, which
// takes whatever is below it. A `**` that takes none is not tried, so a
// name with a leading dot a `**` stands before is never walked into.
function enters({ names: glob, dot }, names) {
  for (const [i, name] of names.entries()) {
    if (i === glob.length) return false
    if (glob[i] === '**') return dot || !name.startsWith('.')
    if (!glob[i].test(name)) return false
  }
  return true
}

// `packages`, the globs or undefined, as the globs that take and those
// that leave out; `major` pnpm's major version.
function compileAll(packages, major) {
  const globs = { include: [], exclude: [], major }
  for (const glob of packages ?? []) {
    const exclude = glob.startsWith('!')
    const compiled = compile(exclude ? glob.slice(1) : glob, 'pnpm-workspace.yaml: packages', exclude && major >= 11)
    globs[exclude ? 'exclude' : 'include'].push({ ...compiled, wild: glob.includes('*') })
  }
  return globs
}

// The manifest pnpm reads of the directory at `names`, given the names in
// it: the first of them there that is a file, a link that leads nowhere
// passed over. pnpm 12 reads the first there, where a glob with a `*`
// takes the directory, and fails where that is not a file.
function manifestOf(project, globs, names, entries) {
  const wild = globs.major >= 12 && globs.include.some((glob) => glob.wild && takes(glob, [...names, 'package.json']))
  for (const name of MANIFESTS) {
    if (!entries.includes(name)) continue
    const type = typeOf(project, `/${[...names, name].join('/')}`)
    if (type === 'file') return name
    if (type !== undefined && wild) throw new DeptreeError(`pnpm 12 reads this as a manifest, and fails on it as a ${type}`, quote([...names, name].join('/')))
  }
  return undefined
}

// Two paths in the order of their names, as pnpm 12 has them.
function byNames(a, b) {
  const x = a.split('/')
  const y = b.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return byBytes(x[i], y[i])
  return x.length - y.length
}

// What find-packages leaves out, as tinyglobby reads it, which does not
// take a name with a leading dot for `**`: what is under node_modules or
// bower_components.
const IGNORED = ['node_modules', 'bower_components'].map((name) => ({ names: ['**', NAME(name, false), '**'], dot: false }))
const ignored = (names) => IGNORED.some((glob) => takes(glob, names))

// What pnpm 12 never walks into or takes: anything with a node_modules or
// bower_components in its path.
const ignored12 = (names) => names.some((name) => name === 'node_modules' || name === 'bower_components')

// Whether pnpm 12 walks into the directory at `names` for a glob: where
// the glob's names before its last may take it.
const enters12 = (glob, names) => reach(glob, names).slice(0, glob.names.length).some(Boolean)

// Whether the globs take the manifest at `names`. What find-packages
// ignores it is not ignored for, in a directory tinyglobby walks into.
const taken = ({ include, exclude, major }, names) => include.some((glob) => takes(glob, names)) && !exclude.some((glob) => takes(glob, names)) && !(major >= 12 && ignored12(names))

// Whether tinyglobby walks into the directory at `names`, which it does
// through a link to one too; or pnpm 12.
const walked = ({ include, major }, names) => (major >= 12
  ? include.some((glob) => enters12(glob, names)) && !ignored12(names)
  : include.some((glob) => enters(glob, names)) && !ignored(names))

// `ids` are the projects' directories, `.` the root; `packages` the globs,
// or undefined; `major` pnpm's major version. pnpm finds a project where
// tinyglobby walks into each directory down to it, and the globs take its
// manifest.
export function checkWorkspace(ids, packages, major = 10) {
  const globs = compileAll(packages, major)
  for (const id of ids) {
    if (id === '.') continue
    const names = id.split('/')
    if (!names.every((_, i) => walked(globs, names.slice(0, i + 1))) || !taken(globs, [...names, 'package.json'])) {
      throw new DeptreeError(`pnpm-workspace.yaml's packages ${packages === undefined ? 'are not set' : 'do not take this directory'}, so pnpm would not install it as a project`, `importers[${quote(id)}]`)
    }
  }
}

// Of what @preventive/lockfile holds an importer's key to, what a project
// under the lockfile's directory has to be: its path from there, in normal
// form, with no drive letter, and no control, bidirectional or backslash
// character, which the lockfile could not name it by.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u
export function checkProjectId(id, where) {
  if (id.split('/').some((name) => name === '' || name === '.' || name === '..' || UNSAFE.test(name)) || /^[A-Za-z]:/u.test(id)) {
    throw new DeptreeError('expected a directory under the lockfile\'s, by its path from there in normal form, as a lockfile can key an importer', where)
  }
}

// A manifest pnpm would read through a link, the root's among them, is
// refused before it is read.
export const linkedManifest = (file) => new DeptreeError('a link pnpm would read a project\'s manifest through is not supported', quote(file))

// The names pnpm reads a project's manifest by, the first of them there
// winning.
const MANIFESTS = ['package.json', 'package.json5', 'package.yaml']

// The directories of the projects pnpm `major` finds by the globs of
// `packages` in `project` (project.js): `.`, the root, then the rest in
// order. Every directory tinyglobby walks into is read, and no other, a
// link to one followed as it follows it. A manifest is a file, or a link
// to one; a link that leads nowhere, or to a directory, is none.
// Refused, as not read here: a root with no manifest, which pnpm takes
// for no project; a project, the root among them, whose manifest is
// package.json5, package.yaml or a link; a project found
// through a link, and a link to a directory in one followed, which is not
// followed; a project in a directory a lockfile could not key its
// importer by; and a node_modules tinyglobby walks into, which it does
// only under a directory with a leading dot, as what is installed there
// is no project buildPnpmTree builds.
export function findProjects(project, packages, major = 10) {
  const globs = compileAll(packages, major)
  const ids = []
  // The directories left to read, by their names, and the link each is
  // reached through, if any: a stack, not recursion, however deep the tree.
  const pending = [{ names: [] }]
  while (pending.length > 0) {
    const { names, link } = pending.pop()
    const dir = names.join('/')
    const entries = project.readdir(`/${dir}`)
    const found = names.length === 0 || taken(globs, [...names, 'package.json']) ? manifestOf(project, globs, names, entries) : undefined
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
      if (!walked(globs, at)) continue
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
  return ['.', ...globs.major >= 12 ? ids.sort(byNames) : ids.sort()]
}
