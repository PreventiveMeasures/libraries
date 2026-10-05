#!/usr/bin/env node
// Development CLI with one command, `compare`: read a project's node_modules
// from disk into memory, build the tree its lockfile installs in a Vfs, and
// list where the two differ — by path, type, bytes, mode and link target,
// never inside a file. Not part of the published package; run it as
// `bin/deptree.js compare <dir>`.

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'
import { buildNpmTree, findNpmWorkspaces } from '@preventive/deptree/npm.js'
import { DeptreeError, LockfileError, YamlError, buildPnpmTree, findPnpmProjects, setCacheDir } from '@preventive/deptree/pnpm.js'
import { buildYarn1Tree, findYarn1Workspaces } from '@preventive/deptree/yarn1.js'
import { defaultCacheDir } from '@preventive/upstream/npm.js'
import { difference, modulesOf, notBuilt, projectView, readDisk, readTree } from './compare.js'

const USAGE = `Usage: bin/deptree.js compare [options] [<dir>]

Reads every node_modules of the project in <dir> (the current directory by
default) into memory, builds the tree its lockfile installs — pnpm-lock.yaml,
package-lock.json or yarn.lock — and lists where the two differ, as an
install from the lockfile would change what is on disk:

  + <path>   only in the tree: the install would add it
  - <path>   only on disk: the install would not have made it
  ~ <path>   in both, but another type, other bytes, another mode or
             another link target

A directory only one side has is one line, with a trailing slash. A file's
bytes are compared whole, never line by line. The .bin directories and the
package manager's own state files, which deptree never builds, are left out
unless --all is given.

Each tarball fetched is kept for the next run in the user's cache
directory: ~/Library/Caches/PreventiveMeasures on macOS,
%LOCALAPPDATA%\\PreventiveMeasures\\Cache on Windows, and
$XDG_CACHE_HOME/PreventiveMeasures or ~/.cache/PreventiveMeasures elsewhere.

Exits 0 where the two are the same, 1 where they differ, 2 on trouble.

  --pnpm <version>   the pnpm that installed; by default the one the root
                     package.json's packageManager pins
  --yarn <version>   the yarn 1.22 that installed; likewise
  --npm <version>    the npm that installed, which nothing pins, so it is
                     needed for a package-lock.json
  --node <version>   the Node it installed with; by default this one
  --all              list the .bin directories and state files too
  -h, --help         show this message
`

const OPTIONS = {
  pnpm: { type: 'string' },
  yarn: { type: 'string' },
  npm: { type: 'string' },
  node: { type: 'string' },
  all: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

const given = (key, version) => (version === undefined ? {} : { [key]: version })

// Each package manager by the flag naming its version: the lockfile it
// installs from, the projects it finds, whose node_modules are its, and the
// tree it makes.
const MANAGERS = {
  pnpm: {
    lockfile: 'pnpm-lock.yaml',
    projects: (project, host) => findPnpmProjects({ project, host: given('pnpm', host.pnpm) }),
    build: buildPnpmTree,
  },
  yarn: {
    lockfile: 'yarn.lock',
    projects: (project) => findYarn1Workspaces({ project }),
    build: buildYarn1Tree,
  },
  npm: {
    lockfile: 'package-lock.json',
    projects: (project, host) => findNpmWorkspaces({ project, os: host.os }),
    build: buildNpmTree,
  },
}

async function main(argv) {
  const { values, positionals } = parse(argv)
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const [command, dir = '.', ...rest] = positionals
  if (command !== 'compare' || rest.length > 0) return fail(USAGE)
  const root = directoryAt(dir)
  const manager = managerOf(root, dir, values)
  // There is none where no home directory is known, and then nothing is kept.
  if (defaultCacheDir !== undefined) setCacheDir()
  const project = projectView(root)
  const host = hostOf(manager, values)
  // The disk first, as it is before anything is fetched.
  const disk = readDisk(root, manager.projects(project, host).map((at) => (at === '.' ? 'node_modules' : `${at}/node_modules`)))
  note(`node_modules on disk: ${sizeOf(disk)}`)
  const tree = await manager.build({ project, host })
  note(`${manager.lockfile}: ${tree.stats.files} files, ${size(tree.stats.bytes)} built`)
  const built = readTree(tree.vfs)
  // A node_modules of the tree's that no project has, should there be one.
  readDisk(root, [...built.keys()].filter((path) => modulesOf(path) === path), disk)
  const changes = difference(disk, built)
  const shown = values.all ? changes : changes.filter((change) => !notBuilt(change))
  process.stdout.write(shown.map(line).join(''))
  note(summary(shown, changes.length - shown.length))
  return shown.length === 0 ? 0 : 1
}

function parse(argv) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (error) {
    return fail(`deptree.js: ${error.message}\n\n${USAGE}`)
  }
}

function directoryAt(dir) {
  let path
  try {
    path = realpathSync(resolve(dir))
  } catch (error) {
    return fail(`deptree.js: ${dir}: ${error.code === 'ENOENT' ? 'no such file or directory' : error.message}\n`)
  }
  if (!statSync(path).isDirectory()) return fail(`deptree.js: ${dir}: not a directory\n`)
  return path
}

// The one a version flag names, or else the one whose lockfile is there.
function managerOf(root, dir, values) {
  const names = Object.keys(MANAGERS)
  const named = names.filter((name) => values[name] !== undefined)
  if (named.length > 1) fail(`deptree.js: ${named.map((name) => `--${name}`).join(' and ')}: one package manager installed, so give one\n`)
  const there = names.filter((name) => isFile(resolve(root, MANAGERS[name].lockfile)))
  const name = named[0] ?? (there.length === 1 ? there[0] : undefined)
  if (name === undefined && there.length === 0) fail(`deptree.js: ${dir}: no ${names.map((n) => MANAGERS[n].lockfile).join(', ')}\n`)
  if (name === undefined) fail(`deptree.js: ${dir}: ${there.map((n) => MANAGERS[n].lockfile).join(' and ')} are both there: give --${there.join(' or --')} for the one that installed\n`)
  if (name === 'npm' && values.npm === undefined) fail('deptree.js: package-lock.json: give --npm <version>, the npm that installed, which no file pins\n')
  return { name, ...MANAGERS[name] }
}

const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// This machine, which is the one that installed what is on disk; npm takes
// a libc only where it finds one, and yarn 1 none at all.
function hostOf({ name }, values) {
  const machine = { node: values.node ?? process.versions.node, os: process.platform, cpu: process.arch }
  const libc = libcOf()
  if (name === 'pnpm') return { ...given('pnpm', values.pnpm), ...machine, libc }
  if (name === 'npm') return { npm: values.npm, ...machine, ...(libc === 'unknown' ? {} : { libc }) }
  return { ...given('yarn', values.yarn), ...machine }
}

// As pnpm's detect-libc tells it from Node's own report: unknown where that
// cannot tell. The report leaves out the network, whose reverse DNS can stall.
function libcOf() {
  if (process.platform !== 'linux' || !process.report) return 'unknown'
  const { excludeNetwork } = process.report
  try {
    process.report.excludeNetwork = true
    const report = process.report.getReport()
    if (report.header?.glibcVersionRuntime) return 'glibc'
    if (report.sharedObjects?.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-'))) return 'musl'
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    process.report.excludeNetwork = excludeNetwork
  }
}

const MARKS = { '+': 'green', '-': 'red', '~': 'yellow' }

// A path is whatever a tarball spells: escaped, so that no name can act on a
// terminal or break a line.
const UNSHOWN = /[\\\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
const shown = (text) => text.replaceAll(UNSHOWN, (char) => (char === '\\' ? '\\\\' : `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`))

function line({ mark, path, type, what }) {
  const slash = mark !== '~' && type === 'directory' ? '/' : ''
  const why = what === undefined ? '' : `  (${shown(what)})`
  return `${styleText(MARKS[mark], `${mark} ${shown(path)}${slash}`, { stream: process.stdout })}${why}\n`
}

function summary(changes, left) {
  const count = (mark) => changes.filter((change) => change.mark === mark).length
  const counts = changes.length === 0 ? 'the same' : `${count('+')} only in the tree, ${count('-')} only on disk, ${count('~')} different`
  return left === 0 ? counts : `${counts}; ${left} left out that deptree never builds (--all lists them)`
}

function sizeOf(entries) {
  const files = [...entries.values()].filter((entry) => entry.type === 'file')
  return `${files.length} files, ${size(files.reduce((sum, entry) => sum + entry.data.length, 0))}`
}

function size(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${unit === 0 ? n : n.toFixed(1)} ${units[unit]}`
}

// A refusal, deptree's or its lockfile reader's, and a filesystem's error
// say what and where; anything else is a bug, and shows its stack.
const REFUSALS = [DeptreeError, LockfileError, YamlError]
function describe(error) {
  if (!REFUSALS.some((type) => error instanceof type) && typeof error?.code !== 'string') return error?.stack ?? String(error)
  const lines = [error.message]
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) {
    if (!lines.some((text) => text.includes(cause.message))) lines.push(`  ${cause.message}`)
  }
  return lines.join('\n')
}

const note = (text) => process.stderr.write(`${text}\n`)
const fail = (message) => {
  process.stderr.write(message)
  process.exit(2)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  note(`deptree.js: ${describe(error)}`)
  process.exitCode = 2
}
