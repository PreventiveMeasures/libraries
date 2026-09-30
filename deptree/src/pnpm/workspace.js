// Which directories pnpm 10 takes for a workspace's projects, all of them
// under one lockfile: the root, always, and each directory whose
// package.json a glob of pnpm-workspace.yaml's `packages` takes, as
// @pnpm/fs.find-packages globs for them with tinyglobby — `<glob>/
// package.{json,yaml,json5}`, less anything under node_modules or
// bower_components. Without `packages`, or without pnpm-workspace.yaml,
// the root is the only project. pnpm finds them on disk: findProjects
// finds them so in the directories it is given, and checkWorkspace holds
// the lockfile's importers to them. pnpm refuses a frozen install for a
// project the lockfile has no importer for, and installs every one.
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

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { escape } from '../matcher.js'

const UNSUPPORTED = /[?[\]{}()\\]/u

// tinyglobby's path.posix.normalize of a glob, from the workspace's
// directory, by its names.
function normalizeGlob(glob, where) {
  const path = normalize(`./${glob}`)
  if (path === '..' || path.startsWith('../')) throw new DeptreeError(`${quote(glob)} reaches outside the workspace's directory, which is not supported`, where)
  return path.split('/')
}

// A name's pattern: `*` any run of characters, but not a leading dot
// unless `dot`.
const NAME = (name, dot) => new RegExp(`^${name.startsWith('*') && !dot ? '(?!\\.)' : ''}${name.split('*').map(escape).join('.*')}$`, 'u')

// A glob as the names of the paths it takes: each `**`, or the pattern of
// one name; `dot` whether `**` takes a name with a leading dot.
function compile(glob, where, dot) {
  const names = normalizeGlob(`${glob}/package.json`, where)
  if (glob === '' || glob.startsWith('/') || UNSUPPORTED.test(glob) || glob.includes('!') || names.some((name) => name !== '**' && name.includes('**'))) {
    throw new DeptreeError(`${quote(glob)} is not supported: only \`*\`, \`**\` as a whole name and a leading \`!\` are`, where)
  }
  return { names: names.map((name) => (name === '**' ? name : NAME(name, dot))), dot }
}

// Whether a glob takes the path of `names`, or, where `partial`, a path
// under it: tinyglobby walks only the directories one could.
function takes({ names: glob, dot }, names, partial = false) {
  const from = (g, n) => {
    if (n === names.length) return partial ? g < glob.length : glob.slice(g).every((name) => name === '**')
    if (g === glob.length) return false
    if (glob[g] === '**') return from(g + 1, n) || ((dot || !names[n].startsWith('.')) && from(g, n + 1))
    return glob[g].test(names[n]) && from(g + 1, n + 1)
  }
  return from(0, 0)
}

// `packages` the globs, or undefined; `major` pnpm's major version.
function compileAll(packages, major) {
  const where = 'pnpm-workspace.yaml: packages'
  return (packages ?? []).map((glob) => {
    const exclude = glob.startsWith('!')
    return { exclude, ...compile(exclude ? glob.slice(1) : glob, where, exclude && major >= 11) }
  })
}

// Whether the globs take the project whose package.json is at `names`.
const taken = (globs, names) => globs.some((glob) => !glob.exclude && takes(glob, names)) && !globs.some((glob) => glob.exclude && takes(glob, names))

// `ids` are the projects' directories, `.` the root; `packages` the globs,
// or undefined; `major` pnpm's major version.
export function checkWorkspace(ids, packages, major = 10) {
  const globs = compileAll(packages, major)
  for (const id of ids) {
    if (id === '.') continue
    if (!taken(globs, [...id.split('/'), 'package.json']) || id.split('/').includes('bower_components')) {
      throw new DeptreeError(`pnpm-workspace.yaml's packages ${packages === undefined ? 'are not set' : 'do not take this directory'}, so pnpm would not install it as a project`, `importers[${quote(id)}]`)
    }
  }
}

// What find-packages leaves out, as tinyglobby reads it, which does not
// take a name with a leading dot for `**`: what is under node_modules or
// bower_components.
const IGNORED = ['node_modules', 'bower_components'].map((name) => ({ names: ['**', NAME(name, false), '**'], dot: false }))

// The names pnpm reads a project's manifest by, the first of them there
// winning.
const MANIFESTS = ['package.json', 'package.json5', 'package.yaml']

// The directories of the projects pnpm finds in the workspace at the root
// of `vfs`, `.` the root first and the rest in order, by the globs of
// `packages` as pnpm `major` finds them. Every directory a glob could take
// a project under is read. A project whose manifest is package.json5 or
// package.yaml is refused, the root among them, which is not read here; so
// is a link pnpm would read a manifest through, or one to a directory a
// glob could take a project under, which tinyglobby follows.
export function findProjects(vfs, packages, major = 10) {
  const globs = compileAll(packages, major)
  const ignored = (names) => IGNORED.some((glob) => takes(glob, names))
  const under = (names) => globs.some((glob) => !glob.exclude && takes(glob, names, true)) && !ignored(names)
  const ids = ['.']
  const visit = (names) => {
    const entries = vfs.readdir(`/${names.join('/')}`)
    const manifest = [...names, 'package.json']
    const root = names.length === 0
    const found = root || (taken(globs, manifest) && !ignored(manifest))
      ? MANIFESTS.find((name) => entries.includes(name) && vfs.lstat(`/${[...names, name].join('/')}`).type !== 'directory')
      : undefined
    if (found !== undefined) {
      const where = quote([...names, found].join('/'))
      if (vfs.lstat(`/${[...names, found].join('/')}`).type === 'symlink') throw new DeptreeError('a link pnpm would read a project\'s manifest through is not supported', where)
      if (found !== 'package.json') throw new DeptreeError(`pnpm reads this project's ${found}, which is not supported`, where)
      if (!root) ids.push(names.join('/'))
    }
    for (const entry of entries) {
      const at = [...names, entry]
      const path = `/${at.join('/')}`
      if (!under(at)) continue
      const { type } = vfs.lstat(path)
      if (type === 'directory') visit(at)
      else if (type === 'symlink' && isDirectory(vfs, path)) throw new DeptreeError('a link to a directory pnpm-workspace.yaml\'s packages could find a project in is not supported: tinyglobby follows it', quote(at.join('/')))
    }
  }
  visit([])
  return [ids[0], ...ids.slice(1).sort()]
}

// Whether `path` leads to a directory; not, where it leads nowhere.
function isDirectory(vfs, path) {
  try {
    return vfs.stat(path).type === 'directory'
  } catch {
    return false
  }
}
