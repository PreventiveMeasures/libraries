#!/usr/bin/env node
// The deptree command: `compare` sets what a package manager installed
// beside the tree deptree builds; see USAGE.

import { resolve } from 'node:path'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'
import { CompareError, formatPatch } from '@preventive/compare'
import { diffLineStyles } from '@preventive/diff/color.js'
import { createClient } from '@preventive/upstream/github.js'
import { defaultCacheDir, setCacheDir } from '@preventive/upstream/npm.js'
import { join } from '@preventive/vfs/path.js'
import { buildCargoTree } from '../cargo.js'
import { buildCocoaPodsTree } from '../cocoapods.js'
import { buildNpmTree, findNpmWorkspaces } from '../npm.js'
import { DeptreeError, LockfileError, buildPnpmTree, findPnpmProjects } from '../pnpm.js'
import { TomlError, buildSoldeerTree } from '../soldeer.js'
import { buildYarn1Tree, findYarn1Workspaces } from '../yarn1.js'
import { escaped } from '../src/error.js'
import { readText, typeOf } from '../src/project.js'
import { difference, leftBehind, leftOut, projectView, readSide } from './compare.js'
import { userToken } from './npmrc.js'

const USAGE = `Usage: deptree compare [options] [<dir>]

Builds the tree the lockfile in <dir> (by default .) installs, from
pnpm-lock.yaml, package-lock.json, yarn.lock, soldeer.lock, Cargo.lock or
Podfile.lock, and lists where it differs from what is on disk, every
node_modules of the project, Soldeer's dependencies, cargo's vendor or the
pods' directories in CocoaPods' Pods:

  + <path>   only in the tree
  - <path>   only on disk
  ~ <path>   in both, but of another type, content, mode or link target

A directory one side has alone is one line, ending in /. Left out unless
--all: .bin directories, state files, Soldeer's .git, what CocoaPods
generates in Pods, and directories on disk holding nothing else. Exits 0
where the two are the same, 1 where they differ, 2 on trouble.

Tarballs, zips, crates and podspecs are kept in ${defaultCacheDir ?? 'no cache, as no home directory is known'}.
A scoped package is fetched with PREVENTIVE_MEASURES_NPM_TOKEN,
STASIS_NPM_TOKEN or NPM_TOKEN, else with a ~/.npmrc line of nothing but
//registry.npmjs.org/:_authToken=npm_\u2026; a Soldeer git dependency or a
pod with GITHUB_TOKEN or GH_TOKEN, else anonymously.

  --pnpm, --yarn, --npm, --soldeer, --cargo, --cocoapods <version>
                     the one that installed: by default the one
                     packageManager pins, Soldeer 0.12.0, or the
                     CocoaPods Podfile.lock names; npm's and cargo's are
                     needed
  --platform <name>  a platform the Podfile's targets are for, ios, osx,
                     tvos, visionos or watchos, once for each; needed
                     where a pod names other files on another
  --node <version>   the Node it installed with; by default this one
  --production       devDependencies were left out, as by pnpm install
                     --prod, npm ci --omit=dev or yarn install --production
  --metadata         fetch each package's version document from npm's
                     registry too, and hold its tarball's dist to it
  --all              list what is left out too
  --diff             follow each file of other content with its patch, as
                     git diff writes it, for patch -p1 or git apply in <dir>
  -h, --help         show this message
`

const OPTIONS = {
  pnpm: { type: 'string' },
  yarn: { type: 'string' },
  npm: { type: 'string' },
  soldeer: { type: 'string' },
  cargo: { type: 'string' },
  cocoapods: { type: 'string' },
  platform: { type: 'string', multiple: true },
  node: { type: 'string' },
  metadata: { type: 'boolean', default: false },
  production: { type: 'boolean', default: false },
  all: { type: 'boolean' },
  diff: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

// Each package manager by its version flag: its lockfile, the folder it
// installs into in each project it finds, and the version where the flag is
// left out and nothing pins one, or, `pinned`, what the project pins, or,
// `unpinned`, that the flag is needed; `development`, that it installs every
// dependency, there being no other kind.
const github = () => createClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null })

const MANAGERS = {
  pnpm: { lockfile: 'pnpm-lock.yaml', folder: 'node_modules', projects: findPnpmProjects, build: buildPnpmTree },
  yarn: { lockfile: 'yarn.lock', folder: 'node_modules', projects: findYarn1Workspaces, build: buildYarn1Tree },
  npm: { lockfile: 'package-lock.json', folder: 'node_modules', unpinned: true, projects: findNpmWorkspaces, build: buildNpmTree },
  soldeer: {
    lockfile: 'soldeer.lock',
    folder: 'dependencies',
    version: '0.12.0',
    development: true,
    projects: () => ['.'],
    build: (options) => buildSoldeerTree({ ...options, github: github() }),
  },
  cargo: { lockfile: 'Cargo.lock', folder: 'vendor', unpinned: true, development: true, projects: () => ['.'], build: buildCargoTree },
  // The pods' directories alone: what else is in Pods, CocoaPods generates.
  cocoapods: {
    lockfile: 'Podfile.lock',
    folder: 'Pods',
    pinned: (project) => /^COCOAPODS: (\S+)$/mu.exec(readText(project, '/Podfile.lock', 'Podfile.lock') ?? '')?.[1],
    development: true,
    projects: () => ['.'],
    build: ({ platform, ...options }) => buildCocoaPodsTree({ ...options, github: github(), ...platform === undefined ? {} : { platforms: platform } }),
  },
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const [command, dir = '.', ...rest] = positionals
  if (command !== 'compare' || rest.length > 0) return fail(USAGE)
  const project = projectView(resolve(dir))
  const name = managerOf(project, dir, values)
  const manager = MANAGERS[name]
  if (values.production && manager.development) fail(`deptree: ${manager.lockfile}: --production is not taken: ${DEVELOPMENT[name]}\n`)
  if (values.platform !== undefined && name !== 'cocoapods') fail(`deptree: ${manager.lockfile}: --platform is taken for CocoaPods alone\n`)
  if (defaultCacheDir !== undefined) setCacheDir()
  // upstream reads it for each request, and sends it for a scoped package.
  process.env.NPM_TOKEN ||= userToken() ?? ''
  // This machine, which installed what is on disk; npm takes no libc where
  // there is none to find.
  const libc = libcOf()
  const host = { [name]: values[name] ?? manager.version ?? manager.pinned?.(project), node: values.node ?? process.versions.node, os: process.platform, cpu: process.arch, ...(name === 'npm' && libc === 'unknown' ? {} : { libc }) }
  // The disk first, as it is before anything is fetched.
  const dirs = manager.projects({ project, host, os: host.os }).map((at) => join(at, manager.folder))
  const disk = readSide(project, dirs)
  const files = [...disk.values()].filter((entry) => entry.type === 'file')
  note(`${manager.folder} on disk: ${files.length} files, ${size(files.reduce((sum, file) => sum + file.data.length, 0))}`)
  const tree = await manager.build({ project, host, metadata: values.metadata, ...values.production ? { production: true } : {}, ...values.platform === undefined ? {} : { platform: values.platform } })
  note(`${manager.lockfile}: ${tree.stats.files} files, ${size(tree.stats.bytes)} built`)
  const built = readSide(tree.vfs, dirs)
  const changes = difference(disk, built)
  const left = values.all ? new Set() : leftOut(changes, disk)
  const listed = changes.filter((change) => !left.has(change.path))
  // A file of other content, with its mode lines where those differ too, as
  // patch -p1 carries out no link's. A name that ends in a space git apply
  // reads, and patch does not.
  const patch = ({ content, status }) => (values.diff && content ? painted(formatPatch([status])) : '')
  process.stdout.write(listed.map((change) => line(change) + patch(change)).join(''))
  note(summary(listed, left.size))
  if (name === 'pnpm') pruneHint(listed)
  return listed.length === 0 ? 0 : 1
}

// Why --production means nothing to each manager that installs everything.
const DEVELOPMENT = {
  soldeer: 'Soldeer has no devDependencies to leave out',
  cargo: 'cargo vendor vendors dev-dependencies too',
  cocoapods: 'CocoaPods installs every pod the Podfile asks for',
}

// The one a version flag names, or else the one whose lockfile is there.
function managerOf(project, dir, values) {
  const names = Object.keys(MANAGERS)
  const named = names.filter((name) => values[name] !== undefined)
  const [name, ...others] = named.length > 0 ? named : names.filter((n) => typeOf(project, MANAGERS[n].lockfile) === 'file')
  if (name === undefined) fail(`deptree: ${dir}: no ${names.map((n) => MANAGERS[n].lockfile).join(', ')}\n`)
  if (others.length > 0) fail(`deptree: ${dir}: give one of --${[name, ...others].join(', --')}, for the package manager that installed\n`)
  if (MANAGERS[name].unpinned && values[name] === undefined) fail(`deptree: ${MANAGERS[name].lockfile}: give --${name} <version>, the ${name} that installed, which no file pins\n`)
  return name
}

// As pnpm's detect-libc tells it, from Node's report, which leaves out the
// network, whose reverse DNS can stall.
function libcOf() {
  if (process.platform !== 'linux') return 'unknown'
  process.report.excludeNetwork = true
  const { header, sharedObjects } = process.report.getReport()
  if (header.glibcVersionRuntime) return 'glibc'
  return sharedObjects.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-')) ? 'musl' : 'unknown'
}

const MARKS = { '+': 'green', '-': 'red', '~': 'yellow' }

// A path is whatever a tarball spells: escaped, so that no name can act on a
// terminal or break a line, a backslash doubled first so an escape reads as one.
const shown = (text) => escaped(text.replaceAll('\\', '\\\\'))

function line({ mark, path, type, what }) {
  const slash = mark !== '~' && type === 'directory' ? '/' : ''
  const why = what === undefined ? '' : `  (${shown(what)})`
  return `${styleText(MARKS[mark], `${mark} ${shown(path)}${slash}`, { stream: process.stdout })}${why}\n`
}

// On a terminal, a diff's lines escaped as names are, but for tabs and
// backslashes, and painted; elsewhere byte for byte, for patch to apply.
function painted(patch) {
  if (!process.stdout.isTTY) return patch
  const styles = diffLineStyles(patch)
  return patch.split('\n').map((text, i) => {
    const plain = text.split('\t').map(escaped).join('\t')
    return styles?.[i] ? styleText(styles[i], plain, { stream: process.stdout }) : plain
  }).join('\n')
}

function summary(changes, left) {
  const count = (mark) => changes.filter((change) => change.mark === mark).length
  const counts = changes.length === 0 ? 'the same' : `${count('+')} only in the tree, ${count('-')} only on disk, ${count('~')} different`
  return left === 0 ? counts : `${counts}; ${left} left out (--all lists them)`
}

function pruneHint(changes) {
  const count = changes.filter(leftBehind).length
  if (count === 0) return
  const [what, them] = count === 1 ? ['a package', 'it'] : [`${count} packages`, 'them']
  note(`${what} in node_modules/.pnpm that the lockfile no longer installs, as pnpm keeps for a while: \`pnpm prune\` removes ${them}, and so does every install with modulesCacheMaxAge: 0 in pnpm-workspace.yaml`)
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB']
function size(bytes) {
  const unit = Math.max(0, UNITS.findLastIndex((_, i) => bytes >= 1024 ** i))
  return unit === 0 ? `${bytes} B` : `${(bytes / 1024 ** unit).toFixed(1)} ${UNITS[unit]}`
}

// A refusal says what and where: deptree's or its lockfile reader's,
// compare's of a side that is no tree it can hold (a link to nothing, say),
// the system's on a call it names, parseArgs's of an option, or a host
// deptree takes no version of from what is there. Anything else is a bug,
// and shows its stack, though Node gave it a code.
const REFUSALS = [DeptreeError, LockfileError, TomlError, CompareError]
const refused = (error) => REFUSALS.some((type) => error instanceof type) || typeof error?.syscall === 'string' || String(error?.code).startsWith('ERR_PARSE_ARGS_') || (error instanceof TypeError && error.message.startsWith('host.'))
function describe(error) {
  if (!refused(error)) return error?.stack ?? String(error)
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
  note(`deptree: ${describe(error)}`)
  process.exitCode = 2
}
