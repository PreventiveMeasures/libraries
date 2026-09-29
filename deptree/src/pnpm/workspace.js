// Which directories pnpm 10 takes for a workspace's projects, all of them
// under one lockfile: the root, always, and each directory whose
// package.json a glob of pnpm-workspace.yaml's `packages` takes, as
// @pnpm/fs.find-packages globs for them with tinyglobby — `<glob>/
// package.json`, less anything under node_modules or bower_components.
// Without `packages`, or without pnpm-workspace.yaml, the root is the only
// project. pnpm finds them on disk; here they are what is given, and each
// has to be one pnpm would find. Those it would find and are not given
// cannot be seen here, and have to be given: pnpm refuses a frozen install
// for one the lockfile has no importer for, and installs every one.
//
// A glob is read as tinyglobby reads it, normalized as a path first, as
// far as `*` and `**` go: `*` any run of characters in one directory's
// name, `**` a whole name for any number of directories, neither taking a
// name that starts with a dot, which only a glob that spells it takes; `!`
// in front leaves out what it takes, wherever it is in the list. Anything
// else a glob can say — `?`, a class, a brace, an extglob, an escape — is
// refused, and so is a glob reaching outside the workspace's directory.

import { DeptreeError, quote } from '../error.js'

const UNSUPPORTED = /[?[\]{}()\\]/u
const escape = (text) => text.replace(/[$()+.?[\\\]^{|}]/gu, '\\$&')

// tinyglobby's path.posix.normalize of a glob: empty and `.` names
// dropped, and `..` taking the name before it with it.
function normalizeGlob(glob, where) {
  const names = []
  for (const name of glob.split('/')) {
    if (name === '' || name === '.') continue
    if (name !== '..') names.push(name)
    else if (names.length === 0) throw new DeptreeError(`${quote(glob)} reaches outside the workspace's directory, which is not supported`, where)
    else names.pop()
  }
  return names
}

// A name's pattern: `*` any run of characters, but not a leading dot.
const NAME = (name) => `${name.startsWith('*') ? '(?!\\.)' : ''}${name.split('*').map(escape).join('[^/]*')}`
// `**`: any number of names, none with a leading dot, each with its `/`.
const GLOBSTAR = '(?:(?!\\.)[^/]+/)*'

function compile(glob, where) {
  const names = normalizeGlob(`${glob}/package.json`, where)
  if (glob === '' || glob.startsWith('/') || UNSUPPORTED.test(glob) || glob.includes('!') || names.some((name) => name !== '**' && name.includes('**'))) {
    throw new DeptreeError(`${quote(glob)} is not supported: only \`*\`, \`**\` as a whole name and a leading \`!\` are`, where)
  }
  // The last name is package.json, which a `/` never follows.
  const source = names.map((name, index) => (name === '**' ? GLOBSTAR : `${NAME(name)}${index === names.length - 1 ? '' : '/'}`)).join('')
  return new RegExp(`^${source}$`, 'u')
}

// `ids` are the projects' directories, `.` the root; `packages` the globs,
// or undefined.
export function checkWorkspace(ids, packages) {
  const where = 'pnpm-workspace.yaml: packages'
  const globs = (packages ?? []).map((glob) => {
    const exclude = glob.startsWith('!')
    return { exclude, regexp: compile(exclude ? glob.slice(1) : glob, where) }
  })
  for (const id of ids) {
    if (id === '.') continue
    const path = `${id}/package.json`
    const taken = globs.some(({ exclude, regexp }) => !exclude && regexp.test(path)) && !globs.some(({ exclude, regexp }) => exclude && regexp.test(path))
    if (!taken || id.split('/').includes('bower_components')) {
      throw new DeptreeError(`pnpm-workspace.yaml's packages ${packages === undefined ? 'are not set' : 'do not take this directory'}, so pnpm would not install it as a project`, `importers[${quote(id)}]`)
    }
  }
}
