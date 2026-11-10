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
import { dirname, join } from '@preventive/vfs/path.js'
import { buildBundlerTree } from '../bundler.js'
import { buildCargoTree } from '../cargo.js'
import { buildCocoaPodsTree } from '../cocoapods.js'
import { buildNpmTree, findNpmWorkspaces } from '../npm.js'
import { DeptreeError, LockfileError, buildPnpmTree, findPnpmProjects } from '../pnpm.js'
import { TomlError, buildSoldeerTree } from '../soldeer.js'
import { buildYarn1Tree, findYarn1Workspaces } from '../yarn1.js'
import { bundlePathOf } from '../src/bundler/inputs.js'
import { escaped } from '../src/error.js'
import { readText, typeOf } from '../src/project.js'
import { bundlerNotBuilt, difference, leftBehind, leftOut, projectView, readSide } from './compare.js'
import { userToken } from './npmrc.js'

const USAGE = `Usage: deptree compare [options] [<dir>]

Builds the tree the lockfile in <dir> (by default .) installs, from
pnpm-lock.yaml, package-lock.json, yarn.lock, soldeer.lock, Cargo.lock,
Podfile.lock, or Gemfile.lock or gems.locked, and lists where it differs
from what is on disk, every node_modules of the project, Soldeer's
dependencies, cargo's vendor, the pods' directories and Manifest.lock in
CocoaPods' Pods, or the gems and their .gem files in Bundler's path, the
BUNDLE_PATH .bundle/config sets or vendor/bundle:

  + <path>   only in the tree
  - <path>   only on disk
  ~ <path>   in both, but of another type, content, mode or link target

A directory one side has alone is one line, ending in /. Left out unless
--all: .bin directories, state files, Soldeer's .git, what CocoaPods
generates in Pods but Manifest.lock, what Bundler generates beside the
gems -- specifications, bin, extensions, build_info, plugins, doc -- and
.bundle/config, and directories on disk holding nothing else. Exits 0
where the two are the same, 1 where they differ, 2 on trouble.

A pod by :podspec is built by its podspec in Pods/Local Podspecs, which
SPEC CHECKSUMS holds, and an archive by :http by the podspec's sha256 of
it. A pod by a git tag, which the lockfile holds no commit for, is not
built.

Tarballs, zips, crates, podspecs, archives and gems are kept in ${defaultCacheDir ?? 'no cache, as no home directory is known'}.
A scoped package is fetched with PREVENTIVE_MEASURES_NPM_TOKEN,
STASIS_NPM_TOKEN or NPM_TOKEN, else with a ~/.npmrc line of nothing but
//registry.npmjs.org/:_authToken=npm_\u2026; a Soldeer git dependency or a
pod with GITHUB_TOKEN or GH_TOKEN, else anonymously.

  --pnpm, --yarn, --npm, --soldeer, --cargo, --cocoapods, --bundler
  <version>          the one that installed: by default the one
                     packageManager pins, Soldeer 0.12.0, or the
                     CocoaPods or Bundler the lockfile names; npm's and
                     cargo's are needed
  --platform <name>  a platform the Podfile's targets are for, ios, osx,
                     tvos, visionos or watchos, once for each; needed
                     where a pod names other files on another
  --ruby, --rubygems <version>
                     the Ruby and RubyGems Bundler ran on, as
                     RUBY_VERSION and Gem::VERSION give them; needed
  --gem-platform <platform>
                     the machine's, as Gem::Platform.local gives it; by
                     default x86_64-linux or aarch64-linux, and -musl
                     after it on musl, and needed elsewhere
  --partial          compare the pods or gems deptree builds alone,
                     leaving out each it does not and saying why: a pod
                     for where it is from -- a spec repo but trunk, an
                     external source but :path and :podspec, a source but
                     git by a commit and :http from GitHub, a
                     prepare_command -- and a gem from git or with
                     extensions to build
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
  bundler: { type: 'string' },
  platform: { type: 'string', multiple: true },
  ruby: { type: 'string' },
  rubygems: { type: 'string' },
  'gem-platform': { type: 'string' },
  partial: { type: 'boolean' },
  node: { type: 'string' },
  metadata: { type: 'boolean', default: false },
  production: { type: 'boolean', default: false },
  all: { type: 'boolean' },
  diff: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

// Each package manager by its version flag: its lockfiles, the folder it
// installs into in each project it finds, and the version where the flag is
// left out and nothing pins one, or, `pinned`, what the lockfile pins, or,
// `unpinned`, that the flag is needed; `development`, that it installs every
// dependency, there being no other kind; `flags`, those it alone takes.
const github = () => createClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null })

const MANAGERS = {
  pnpm: { lockfiles: ['pnpm-lock.yaml'], folder: 'node_modules', projects: findPnpmProjects, build: buildPnpmTree },
  yarn: { lockfiles: ['yarn.lock'], folder: 'node_modules', projects: findYarn1Workspaces, build: buildYarn1Tree },
  npm: { lockfiles: ['package-lock.json'], folder: 'node_modules', unpinned: true, projects: findNpmWorkspaces, build: buildNpmTree },
  soldeer: {
    lockfiles: ['soldeer.lock'],
    folder: 'dependencies',
    version: '0.12.0',
    development: true,
    projects: () => ['.'],
    build: (options) => buildSoldeerTree({ ...options, github: github() }),
  },
  cargo: { lockfiles: ['Cargo.lock'], folder: 'vendor', unpinned: true, development: true, projects: () => ['.'], build: buildCargoTree },
  // The pods' directories and Manifest.lock, a copy of the lockfile: what
  // else is in Pods, CocoaPods generates.
  cocoapods: {
    lockfiles: ['Podfile.lock'],
    title: 'CocoaPods',
    flags: ['platform', 'partial'],
    folder: 'Pods',
    pinned: (text) => /^COCOAPODS: (\S+)$/mu.exec(text)?.[1],
    development: true,
    projects: () => ['.'],
    build: (options) => buildCocoaPodsTree({ ...options, github: github(), manifest: true }),
  },
  // The gems and their .gem files under BUNDLE_PATH: what else Bundler
  // writes there, it generates.
  bundler: {
    lockfiles: ['Gemfile.lock', 'gems.locked'],
    title: 'Bundler',
    flags: ['partial', 'ruby', 'rubygems', 'gem-platform'],
    folder: bundlePathOf,
    notBuilt: bundlerNotBuilt,
    pinned: (text) => /^BUNDLED WITH\n {2,3}(\S+)$/mu.exec(text)?.[1],
    host: rubyOf,
    development: true,
    projects: () => ['.'],
    build: buildBundlerTree,
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
  const { name, lockfile } = managerOf(project, dir, values)
  const manager = MANAGERS[name]
  if (values.production && manager.development) fail(`deptree: ${lockfile}: --production is not taken: ${DEVELOPMENT[name]}\n`)
  for (const flag of new Set(Object.values(MANAGERS).flatMap((m) => m.flags ?? []))) {
    if (values[flag] === undefined || manager.flags?.includes(flag)) continue
    const takers = Object.values(MANAGERS).filter((m) => m.flags?.includes(flag)).map((m) => m.title)
    fail(`deptree: ${lockfile}: --${flag} is taken for ${takers.join(' and ')} alone\n`)
  }
  if (defaultCacheDir !== undefined) setCacheDir()
  // upstream reads it for each request, and sends it for a scoped package.
  process.env.NPM_TOKEN ||= userToken() ?? ''
  // This machine, which installed what is on disk; npm takes no libc where
  // there is none to find.
  const libc = libcOf()
  const pinned = manager.pinned?.(readText(project, `/${lockfile}`, lockfile) ?? '')
  const host = { [name]: values[name] ?? manager.version ?? pinned, node: values.node ?? process.versions.node, os: process.platform, cpu: process.arch, ...(name === 'npm' && libc === 'unknown' ? {} : { libc }) }
  if (manager.pinned !== undefined && host[name] === undefined) fail(`deptree: ${lockfile}: give --${name} <version>, the ${manager.title} that installed, which the lockfile does not name\n`)
  Object.assign(host, manager.host?.(values, libc, lockfile))
  // The disk first, as it is before anything is fetched.
  const folder = typeof manager.folder === 'function' ? manager.folder(project) : manager.folder
  const notBuilt = manager.notBuilt?.(folder)
  const dirs = manager.projects({ project, host, os: host.os }).map((at) => join(at, folder))
  const disk = readSide(project, dirs, notBuilt)
  const files = [...disk.values()].filter((entry) => entry.type === 'file')
  note(`${folder} on disk: ${files.length} files, ${size(files.reduce((sum, file) => sum + file.data.length, 0))}`)
  const tree = await manager.build({ project, host, metadata: values.metadata, platforms: values.platform, partial: values.partial, ...values.production ? { production: true } : {} })
  note(`${lockfile}: ${tree.stats.files} files, ${size(tree.stats.bytes)} built`)
  // A pod or a gem --partial skips is CocoaPods' or Bundler's to install:
  // what it installs for it on disk is not compared. The reason quotes what
  // it names, as a refusal does.
  const skipped = new Set()
  for (const { reason, paths } of tree.skipped ?? []) {
    note(`not compared: ${reason}`)
    for (const path of paths) skipped.add(path)
  }
  if (skipped.size > 0) {
    for (const path of disk.keys()) {
      for (let at = path; at !== '.'; at = dirname(at)) {
        if (!skipped.has(at)) continue
        disk.delete(path)
        break
      }
    }
  }
  const built = readSide(tree.vfs, dirs, notBuilt)
  const changes = difference(disk, built)
  const left = values.all ? new Set() : leftOut(changes, disk, notBuilt)
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
  bundler: 'Bundler leaves groups out by BUNDLE_WITHOUT, of a Gemfile not read',
}

// The one a version flag names, or else the one whose lockfile is there,
// and that lockfile, or its first where none is.
function managerOf(project, dir, values) {
  const names = Object.keys(MANAGERS)
  const found = (n) => MANAGERS[n].lockfiles.find((file) => typeOf(project, file) === 'file')
  const named = names.filter((name) => values[name] !== undefined)
  const [name, ...others] = named.length > 0 ? named : names.filter((n) => found(n) !== undefined)
  if (name === undefined) fail(`deptree: ${dir}: no ${names.flatMap((n) => MANAGERS[n].lockfiles).join(', ')}\n`)
  if (others.length > 0) fail(`deptree: ${dir}: give one of --${[name, ...others].join(', --')}, for the package manager that installed\n`)
  const lockfile = found(name) ?? MANAGERS[name].lockfiles[0]
  if (MANAGERS[name].unpinned && values[name] === undefined) fail(`deptree: ${lockfile}: give --${name} <version>, the ${name} that installed, which no file pins\n`)
  return { name, lockfile }
}

// The Ruby Bundler ran on, which nothing on disk names: its RUBY_VERSION,
// its Gem::VERSION, and Gem::Platform.local, which on Linux is the CPU and
// the libc, CRuby's arch, and is needed elsewhere.
const GEM_CPUS = { x64: 'x86_64', arm64: 'aarch64' }
function rubyOf(values, libc, lockfile) {
  if (values.ruby === undefined || values.rubygems === undefined) fail(`deptree: ${lockfile}: give --ruby <version> and --rubygems <version>, the Ruby and RubyGems Bundler ran on: ruby -e 'puts RUBY_VERSION, Gem::VERSION'\n`)
  const cpu = process.platform === 'linux' && libc !== 'unknown' ? GEM_CPUS[process.arch] : undefined
  const platform = values['gem-platform'] ?? (cpu === undefined ? undefined : `${cpu}-linux${libc === 'musl' ? '-musl' : ''}`)
  if (platform === undefined) fail(`deptree: ${lockfile}: give --gem-platform <platform>, the machine's: ruby -e 'puts Gem::Platform.local'\n`)
  return { ruby: values.ruby, rubygems: values.rubygems, platform }
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
