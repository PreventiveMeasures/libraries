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

// The files an install reads, as text: pnpm-lock.yaml; pnpm-workspace.yaml
// and the .npmrc beside it, where there are any; and each patch file its
// patchedDependencies names, by the path the lockfile names it by. Settings
// from anywhere else — another .npmrc, the environment, the root
// package.json — are not read, and are taken to be at their defaults.
export interface PnpmTreeOptions {
  lockfile: string
  workspace?: string
  npmrc?: string
  patches?: Record<string, string> | Map<string, string>
  host: PnpmHost
}

// The node_modules tree pnpm 10 installs from a frozen lockfile with the
// isolated linker, rooted at the lockfile's directory: each package's
// files at node_modules/.pnpm/<dir>/node_modules/<name>, its dependencies
// linked beside it, the hoisted aliases, and each project's own
// node_modules of links. Links are relative; a `link:` dependency leads
// where the lockfile says, which the tree does not hold. Bins, and the
// executable bit pnpm gives the files they run; pnpm's own state files;
// and what lifecycle scripts would build: none of these is written.
//
// Packages come from https://registry.npmjs.org/ alone, fetched through
// @preventive/upstream, and each tarball is held to the lockfile's
// integrity; each patch to the lockfile's hash of it, and applied only
// where every hunk matches exactly where it says.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// setting this does not know or does not build for, a package from
// anywhere but the registry, a pnpmfile, an injected or unnamed-workspace
// case, a patch that does not hash or apply — each is refused with a
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
