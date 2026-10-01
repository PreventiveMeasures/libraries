// Reads a package-lock.json of `lockfileVersion: 3`, as npm 9 to 12 write it
// by default. Throws a LockfileError for anything npm would not write, would
// read otherwise than other parsers, or would install otherwise than the
// lockfile says; and a TypeError for bad arguments. An older version, which
// carries the tree again as npm 6 reads it, and npm 12's version 4, for
// patches and package extensions, are refused; so is a package with a
// shrinkwrap of its own, and one the lockfile does not say where it comes
// from, which npm fetches by its name and version, unchecked.
//
// What npm reads beside the lockfile is not: the overrides of package.json,
// which change what a dependency asks for, and npm's config, of which only
// legacy-peer-deps is taken, below. A dependency an override explains is
// refused where versions are checked. Nor is the host: whether a package's
// os, cpu, libc and engines take it is for the caller to say.
export function parseNpmLockfile(text: string, options?: NpmOptions): NpmLockfile

export interface NpmOptions {
  // Checks versions against ranges with `semver`, which it then requires.
  // On by default. Without it, a version, a range and a tag of the registry
  // all go unchecked.
  checkVersions?: boolean
  // The semver package npm reads ranges with, which another release may
  // read otherwise at the edges.
  semver?: NpmSemver
  // npm's legacy-peer-deps, with which npm loads no peer dependency.
  legacyPeerDeps?: boolean
}

export interface NpmSemver {
  valid(version: string, loose: boolean): string | null
  validRange(range: string, loose: boolean): string | null
  satisfies(version: string, range: string, loose: boolean): boolean
}

// `where` is a property path into the lockfile,
// `packages["node_modules/q"].resolved`; undefined for a syntax error,
// whose message has the line, or the file as a whole.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Each Record has a null prototype, and keeps the order of the lockfile.

// A key of `packages`, or `link:` and where a link leads: a key of
// `importers`, or, now and then, of `packages`.
export type Target = string

export interface NpmLockfile {
  lockfileVersion: 3
  // The project's, or, where its package.json has no name, its directory's.
  name: string
  version: string | undefined
  // By directory from the lockfile's, `.` for its own: the project, and
  // each directory a link leads to, its workspaces among them.
  importers: Record<string, NpmImporter>
  // By location from the lockfile's directory, `node_modules/q` and
  // `node_modules/a/node_modules/q`: what npm installs there.
  packages: Record<string, NpmPackage>
  // By location, where each link there leads: a key of `importers`, or of
  // `packages`, which npm links a package to now and then.
  links: Record<string, string>
}

// A dependency as npm reads it off a manifest: one a name, of the last
// list that has it, of peerDependencies, dependencies, optionalDependencies
// and, for an importer, devDependencies; the root's workspaces before all.
export interface NpmEdge {
  type: 'workspace' | 'peer' | 'peerOptional' | 'prod' | 'optional' | 'dev'
  // As the manifest has it; a workspace's `file:` and its directory.
  spec: string
  // acceptDependencies': a second spec that does too.
  accept: string | undefined
  // Where npm finds it from the node that asks: undefined for an optional
  // peer it finds nowhere, for one a package bundles, which its tarball
  // has, and for whatever a directory out of the project asks for, which
  // npm leaves to it. An optional peer may be one it does not take, which
  // npm ci installs as the lockfile has it; any other is met. A range is
  // met by what is in the folder of its name, an alias of another package
  // too; an alias by the package it names.
  target: Target | undefined
}

// As the manifest has them, but for the flags, which npm works out from
// what depends on each: under --omit, `dev` and `optional` leave a node
// out, and `devOptional` where both are omitted. `devOptional` is set
// where either other is.
export interface NpmManifest {
  // The name a package is published under: an alias's is not its folder's.
  name: string
  version: string
  // By name.
  edges: Record<string, NpmEdge>
  bundleDependencies: string[]
  // Old packages list engines in a sequence, in which npm finds none.
  engines: Record<string, string> | string[]
  // Absent means any.
  os: string[] | undefined
  cpu: string[] | undefined
  libc: string[] | undefined
  bin: Record<string, string>
  license: string | undefined
  funding: NpmFunding | NpmFunding[] | undefined
  deprecated: string | undefined
  hasInstallScript: boolean
  dev: boolean
  optional: boolean
  devOptional: boolean
  peer: boolean
}

export type NpmFunding = string | Record<string, string>

export interface NpmImporter extends Omit<NpmManifest, 'name' | 'version'> {
  // The project's may have none; any other's is its folder's where npm
  // writes none.
  name: string | undefined
  version: string | undefined
  // One of the project's workspaces.
  workspace: boolean
  // Its globs of workspaces, as written; npm reads the project's alone.
  workspaces: string[]
}

export interface NpmPackage extends NpmManifest {
  // Undefined for a package npm takes from the tarball of another, which
  // bundles it.
  resolution: NpmResolution | undefined
  // Bundled by the project or by a package it is under.
  inBundle: boolean
}

// `tarball` is an http(s) URL or `file:` and a path from the lockfile's
// directory; undefined for one from the registry for its name and version,
// as npm writes it when set to. `repo` is the URL npm clones from.
export type NpmResolution =
  | { type: 'tarball', tarball: string | undefined, integrity: string }
  | { type: 'git', repo: string, commit: string }
