#!/usr/bin/env node
// Development CLI with one command, `compare`: read what a project's
// package manager installed from disk into memory — its node_modules, or
// Soldeer's dependencies — build the tree its lockfile installs in a Vfs,
// and list where the two differ, by path, type, bytes, mode and link
// target. Not part of the published package; run it as
// `bin/deptree.js compare <dir>`.

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'
import { buildNpmTree, findNpmWorkspaces } from '@preventive/deptree/npm.js'
import { DeptreeError, LockfileError, YamlError, buildPnpmTree, findPnpmProjects } from '@preventive/deptree/pnpm.js'
import { TomlError, buildSoldeerTree } from '@preventive/deptree/soldeer.js'
import { buildYarn1Tree, findYarn1Workspaces } from '@preventive/deptree/yarn1.js'
import { diffLineStyles } from '@preventive/diff/color.js'
import { defaultCacheDir, setCacheDir } from '@preventive/upstream/npm.js'
import { join } from '@preventive/vfs/path.js'
import { escaped } from '../src/error.js'
import { typeOf } from '../src/project.js'
import { difference, emptyDirs, leftBehind, notBuilt, projectView, readDisk, readTree } from './compare.js'
import { userToken } from './npmrc.js'
import { patchOf } from './patch.js'

const USAGE = `Usage: bin/deptree.js compare [options] [<dir>]

Reads what the package manager of the project in <dir> (the current
directory by default) installed into memory — every node_modules of it for
pnpm-lock.yaml, package-lock.json or yarn.lock, its dependencies folder for
soldeer.lock — builds the tree the lockfile installs, and lists where the
two differ, as an install from the lockfile would change what is on disk:

  + <path>   only in the tree: the install would add it
  - <path>   only on disk: the install would not have made it
  ~ <path>   in both, but another type, other bytes, another mode or
             another link target

A directory only one side has is one line, with a trailing slash. A file's
bytes are compared whole, never line by line, unless --diff is given. Left
out unless --all is given: the .bin directories and the package manager's
own state files, which deptree never builds, and empty directories on disk
alone, holding nothing but those, such as a node_modules pnpm leaves behind.

Each tarball or zip fetched is kept for the next run in ${defaultCacheDir ?? 'no cache, as no home directory is known'}.
A scoped package is fetched with NPM_TOKEN, or where that is unset, with the
token of a line of ~/.npmrc that is nothing but
//registry.npmjs.org/:_authToken=npm_…, the last of them.

Exits 0 where the two are the same, 1 where they differ, 2 on trouble.

  --pnpm <version>   the pnpm that installed; by default the one the root
                     package.json's packageManager pins
  --yarn <version>   the yarn 1.22 that installed; likewise
  --npm <version>    the npm that installed, which nothing pins, so it is
                     needed for a package-lock.json
  --soldeer <version>
                     the Soldeer that installed; by default 0.12.0, the
                     one deptree builds for
  --node <version>   the Node it installed with; by default this one
  --all              list the .bin directories, state files and empty
                     directories too
  --diff             follow a file of other content with a unified diff
                     from disk to the tree, which \`patch -p1\` in <dir>
                     would apply, or \`Binary files … differ\` where either
                     is no UTF-8 text
  -h, --help         show this message
`

const OPTIONS = {
  pnpm: { type: 'string' },
  yarn: { type: 'string' },
  npm: { type: 'string' },
  soldeer: { type: 'string' },
  node: { type: 'string' },
  all: { type: 'boolean' },
  diff: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

const given = (key, version) => (version === undefined ? {} : { [key]: version })

// Each package manager by the flag naming its version: the lockfile it
// installs from; the folder it installs into, in each project it finds;
// whether its version has to be given, as npm's, which nothing pins; the
// host it installs on, from this machine; the projects; and the tree it
// makes. npm takes a libc only where it finds one, yarn 1 none at all, and
// Soldeer an os alone; Soldeer installs into its project's root alone.
const MANAGERS = {
  pnpm: {
    lockfile: 'pnpm-lock.yaml',
    folder: 'node_modules',
    host: (version, machine, libc) => ({ ...given('pnpm', version), ...machine, libc }),
    projects: findPnpmProjects,
    build: buildPnpmTree,
  },
  yarn: {
    lockfile: 'yarn.lock',
    folder: 'node_modules',
    host: (version, machine) => ({ ...given('yarn', version), ...machine }),
    projects: findYarn1Workspaces,
    build: buildYarn1Tree,
  },
  npm: {
    lockfile: 'package-lock.json',
    folder: 'node_modules',
    versionRequired: true,
    host: (version, machine, libc) => ({ npm: version, ...machine, ...(libc === 'unknown' ? {} : { libc }) }),
    projects: ({ project, host }) => findNpmWorkspaces({ project, os: host.os }),
    build: buildNpmTree,
  },
  // 0.12.0 is the one Soldeer deptree builds for, and nothing pins one.
  soldeer: {
    lockfile: 'soldeer.lock',
    folder: 'dependencies',
    host: (version, machine) => ({ soldeer: version ?? '0.12.0', os: machine.os }),
    projects: () => ['.'],
    build: buildSoldeerTree,
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
  const project = projectView(directoryAt(dir))
  const name = managerOf(project, dir, values)
  const manager = MANAGERS[name]
  // There is none where no home directory is known, and then nothing is kept.
  if (defaultCacheDir !== undefined) setCacheDir()
  // Read by upstream for each request, and sent for a scoped package alone.
  const token = process.env.NPM_TOKEN ? undefined : userToken()
  if (token !== undefined) process.env.NPM_TOKEN = token
  // This machine, which is the one that installed what is on disk.
  const host = manager.host(values[name], { node: values.node ?? process.versions.node, os: process.platform, cpu: process.arch }, libcOf())
  // The disk first, as it is before anything is fetched.
  const disk = readDisk(project, manager.projects({ project, host }).map((at) => join(at, manager.folder)))
  note(`${manager.folder} on disk: ${sizeOf(disk)}`)
  const tree = await manager.build({ project, host })
  note(`${manager.lockfile}: ${tree.stats.files} files, ${size(tree.stats.bytes)} built`)
  const built = readTree(tree.vfs, manager.folder)
  const changes = difference(disk, built)
  const empty = emptyDirs(changes, disk)
  const left = (change) => !values.all && (notBuilt(change) || empty.has(change.path))
  const [shown, hidden] = [changes.filter((change) => !left(change)), changes.filter(left)]
  const patch = ({ path, content }) => (values.diff && content ? painted(patchOf(path, disk.get(path).data, built.get(path).data)) : '')
  process.stdout.write(shown.map((change) => line(change) + patch(change)).join(''))
  note(summary(shown, hidden, empty))
  if (name === 'pnpm') pruneHint(shown)
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
function managerOf(project, dir, values) {
  const names = Object.keys(MANAGERS)
  const named = names.filter((name) => values[name] !== undefined)
  if (named.length > 1) fail(`deptree.js: ${named.map((name) => `--${name}`).join(' and ')}: one package manager installed, so give one\n`)
  const there = names.filter((name) => typeOf(project, MANAGERS[name].lockfile) === 'file')
  const name = named[0] ?? (there.length === 1 ? there[0] : undefined)
  if (name === undefined && there.length === 0) fail(`deptree.js: ${dir}: no ${names.map((n) => MANAGERS[n].lockfile).join(', ')}\n`)
  if (name === undefined) fail(`deptree.js: ${dir}: ${there.map((n) => MANAGERS[n].lockfile).join(' and ')} are both there: give --${there.join(' or --')} for the one that installed\n`)
  if (MANAGERS[name].versionRequired && values[name] === undefined) fail(`deptree.js: ${MANAGERS[name].lockfile}: give --${name} <version>, the ${name} that installed, which no file pins\n`)
  return name
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
// terminal or break a line, and a backslash doubled first, so that an escape
// reads as one.
const shown = (text) => escaped(text.replaceAll('\\', '\\\\'))

function line({ mark, path, type, what }) {
  const slash = mark !== '~' && type === 'directory' ? '/' : ''
  const why = what === undefined ? '' : `  (${shown(what)})`
  return `${styleText(MARKS[mark], `${mark} ${shown(path)}${slash}`, { stream: process.stdout })}${why}\n`
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

// A diff's lines are whatever a tarball holds. Where stdout is a terminal,
// each is escaped as a name is, but for a tab and a backslash, so that code
// reads as written, and painted in diff's own colours; elsewhere they are
// left byte for byte, so that patch applies what it is handed.
function painted(patch) {
  if (!process.stdout.isTTY) return patch
  const styles = diffLineStyles(patch)
  return patch.split('\n').map((text, i) => {
    const plain = text.split('\t').map(escaped).join('\t')
    return styles?.[i] ? styleText(styles[i], plain, { stream: process.stdout }) : plain
  }).join('\n')
}

function summary(changes, hidden, empty) {
  const count = (mark) => changes.filter((change) => change.mark === mark).length
  const counts = changes.length === 0 ? 'the same' : `${count('+')} only in the tree, ${count('-')} only on disk, ${count('~')} different`
  const vacant = hidden.filter((change) => empty.has(change.path)).length
  const left = [
    ...(hidden.length > vacant ? [`${hidden.length - vacant} that deptree never builds`] : []),
    ...(vacant > 0 ? [plural(vacant, 'empty directory', 'empty directories')] : []),
  ]
  return left.length === 0 ? counts : `${counts}; left out ${left.join(' and ')} (--all lists them)`
}

// pnpm keeps a package an install drops in node_modules/.pnpm for
// modulesCacheMaxAge minutes, a week by default, and each install with it 0
// removes it at once; `pnpm store prune` leaves it.
function pruneHint(changes) {
  const count = changes.filter(leftBehind).length
  if (count === 0) return
  const [what, them] = count === 1 ? ['a package', 'it'] : [`${count} packages`, 'them']
  note(`${what} in node_modules/.pnpm that the lockfile no longer installs, as pnpm keeps for a while: \`pnpm prune\` removes ${them}, and so does every install with modulesCacheMaxAge: 0 in pnpm-workspace.yaml`)
}

function sizeOf(entries) {
  let [files, bytes] = [0, 0]
  for (const entry of entries.values()) {
    if (entry.type !== 'file') continue
    files++
    bytes += entry.data.length
  }
  return `${files} files, ${size(bytes)}`
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
const REFUSALS = [DeptreeError, LockfileError, YamlError, TomlError]
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
