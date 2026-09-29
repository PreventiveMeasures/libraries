// Hand-written against pnpm.js; a change to either belongs with the other.

import type { Vfs } from '@preventive/vfs'

export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js'

// The machine pnpm would install on, which a tree depends on: `pnpm` is
// the version that installs, and has to be a 10.x, the only one built
// for; `node` the Node it runs on, unless the settings name a nodeVersion;
// `os`, `cpu` and `libc` as Node and pnpm name them — `linux`, `x64`,
// `glibc` — with `unknown` for a libc outside Linux, as pnpm has it.
// Windows is refused: pnpm links there with junctions to absolute paths.
// An optional package the machine cannot run is left out, as pnpm leaves
// it out; supportedArchitectures in the settings widens what is taken.
export interface PnpmHost {
  pnpm: string
  node: string
  os: string
  cpu: string
  libc: 'glibc' | 'musl' | 'unknown'
}

// The files an install reads, as text: pnpm-lock.yaml; the package.json
// of every project it installs, by the project's directory relative to the
// lockfile's (`.` for the root, then as its importers are keyed); pnpm-
// workspace.yaml and the .npmrc, where there are any; and every patch file
// the settings' patchedDependencies name, by the path from the lockfile's
// directory they name it by. Settings from anywhere else — another
// .npmrc, the environment, the command line — are not read, and are taken
// to be at their defaults.
//
// A workspace is one lockfile for several projects, each a package.json:
// the root, and every directory pnpm-workspace.yaml's `packages` globs
// take, as pnpm globs for them — `*` and `**`, a leading `!` to leave out,
// and no other glob syntax. Without `packages` the root is the only
// project. Every importer has to have its package.json given, and be a
// project those globs take; and every project pnpm would find has to be
// given, which cannot be checked here, as the directories are not.
//
// Each project is held to its importer as --frozen-lockfile holds it: its
// dependencies, devDependencies, optionalDependencies and, with
// autoInstallPeers, the peers it lists nowhere else, have to be what the
// importer records, and in the ranges they ask for. The projects' names
// are what hoistWorkspacePackages hoists them by.
//
// Settings are read as `pnpm install` 10 reads them, each source over the
// one before: the .npmrc, then pnpm-workspace.yaml, then what the
// package.json's `pnpm` field sets, which pnpm's install spreads over the
// rest. Overrides are the package.json's Yarn-style `resolutions` and
// `pnpm.overrides`, the second winning a selector both name; only where
// those name none are pnpm-workspace.yaml's `overrides` read. `$name` in
// one is the root package.json's own specifier for `name`, and
// `catalog:` what the workspace's catalog gives the package.
export interface PnpmTreeOptions {
  lockfile: string
  manifests: Record<string, string> | Map<string, string>
  workspace?: string
  npmrc?: string
  patches?: Record<string, string> | Map<string, string>
  host: PnpmHost
}

// The node_modules tree `pnpm install --frozen-lockfile --ignore-scripts`
// makes with pnpm 10's isolated linker, and no other install: whatever the
// settings say of frozen lockfiles, the install is frozen, which is also
// the only one that hoists by the lockfile's graph alone. It is rooted at
// the lockfile's directory: each package's
// files at node_modules/.pnpm/<dir>/node_modules/<name>, its dependencies
// linked beside it, the hoisted aliases, and each project's own
// node_modules of links. Links are relative; a `link:` dependency leads
// where the lockfile says, which the tree does not hold. Scripts are
// always ignored, as `--ignore-scripts` has pnpm ignore them, whatever the
// settings would allow to build. Bins, and the executable bit pnpm gives
// the files they run, and pnpm's own state files are not written.
//
// The lockfile is held to what a frozen install holds it to, and refused
// where pnpm would refuse it: the settings that shaped its resolution —
// catalogs, overrides, package extensions, optional dependencies left
// out, patches, autoInstallPeers, dedupePeers, peersSuffixMaxLength —
// and each project's package.json, read through pnpm's read-package hook
// as pnpm reads it. The root package.json's packageManager, where it has
// one, has to be `pnpm@` host.pnpm exactly, as pnpm would switch to the
// one it names; a project's engines.pnpm has to take host.pnpm, and with
// engineStrict its engines.node host.node.
//
// And to more than pnpm holds it to, where a lockfile pnpm writes, or a
// package the registry serves, always holds: each snapshot marked
// optional exactly where only optional dependencies reach it; each patch
// on the package the settings pick it for, and each used; each tarball
// gzipped, every file under one directory, no link or device in it, and
// a package.json for exactly its name and version, whose os, cpu, libc,
// bins and bundled dependencies are what the lockfile recorded and whose
// every dependency the snapshot has. On macOS, two names in one directory
// that differ only in case or normalization are refused, as they would be
// one name there.
//
// Packages come from https://registry.npmjs.org/ alone, fetched through
// @preventive/upstream, and each tarball is held to the lockfile's
// integrity; each patch to the lockfile's hash of it, and applied only
// where every hunk matches exactly where it says.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// setting this does not know or does not build for, overrides pnpm cannot
// read, a lockfile not resolved with these settings, a package from
// anywhere but the registry, a pnpmfile, package extensions, an injected
// dependency, a lockfile not up to date with a package.json, another
// package manager, a runtime to download, two projects of one name, a
// patch that does not hash or apply, a check above that fails, text
// that is not well-formed where it is hashed — each is refused with a
// DeptreeError, a LockfileError or a YamlError that says where. A
// TypeError is thrown for options of the wrong type.
export function buildPnpmTree(options: PnpmTreeOptions): Promise<Vfs>

// `where` is what a refusal is about — `pnpm-workspace.yaml: nodeLinker`,
// `.npmrc:3: node-linker`, a package's key — or undefined for the call as
// a whole; the message leads with it. `cause` is what a package beneath
// refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
