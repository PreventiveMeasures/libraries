// Hand-written against pnpm.js; a change to either belongs with the other.

export { YamlError } from '@preventive/yaml'

// Reads a pnpm-lock.yaml of `lockfileVersion: '9.0'`, as pnpm 9 to 12 write
// it, the two-document form pnpm 12 writes when a project pins its package
// manager included. Nothing is dropped: an older format is refused, and so
// is anything in this one the reader does not know the meaning of — a
// field, at any depth, a resolution `type` (`binary`, `variations`, a
// `custom:` one), a tarball `revision`, a named registry, a runtime.
//
// So is a lockfile that contradicts itself or could be read two ways: a
// snapshot without its package or a package without a snapshot, a
// reference to a snapshot that is not there, a snapshot no importer
// reaches, a key that disagrees with its resolution, a patch hash
// patchedDependencies does not hold, an alias listed under two kinds.
//
// Throws a TypeError for anything but a string, a YamlError where the text
// is not the YAML pnpm writes, and a LockfileError where it is but is not a
// lockfile read here.
export function parsePnpmLockfile(text: string): PnpmLockfile

// `where` is the place in the lockfile a refusal is about, as a property
// path from its top — `packages["q@1.5.1"].resolution`, and under `env` for
// the env document — or undefined for the file as a whole; the message
// leads with it.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Every Record below has a null prototype: a key is only ever a key, and an
// absent one reads as undefined. Each is in the order the lockfile has it.

// What a dependency leads to: the key of one of `packages`, or `link:` and
// a directory linked in place, which the lockfile does not hold, as a path
// from the lockfile's directory (`.` for that one). An importer writes a
// link from its own directory and a snapshot from the lockfile's, as pnpm's
// installer reads them; both come back from the lockfile's.
export type Target = string

export interface PnpmLockfile {
  lockfileVersion: '9.0'
  settings: PnpmSettings
  // By catalog, `default` among them, then by name.
  catalogs: Record<string, Record<string, PnpmCatalogEntry>>
  // By selector (`foo`, `foo@1`, `bar>foo`), what to install instead.
  overrides: Record<string, string>
  // By selector, the patch: `path` is its file, relative to the lockfile's
  // directory, which pnpm 11 and later leave out.
  patchedDependencies: Record<string, { hash: string, path: string | undefined }>
  // By project directory relative to the lockfile's, `.` for its own.
  importers: Record<string, PnpmImporter>
  // By snapshot key: `name@version`, or `name@` and a source, then the
  // patch hash and the peers in parentheses. One package resolved with two
  // sets of peers is two entries.
  packages: Record<string, PnpmPackage>
  // pnpm 12's first document: the package manager and config dependencies.
  env: PnpmEnvLockfile | undefined
}

export interface PnpmEnvLockfile {
  lockfileVersion: '9.0'
  importers: { '.': PnpmEnvImporter }
  packages: Record<string, PnpmPackage>
}

// As written; pnpm leaves out a setting at its default.
export interface PnpmSettings {
  autoInstallPeers?: boolean
  dedupePeers?: boolean
  excludeLinksFromLockfile?: boolean
  injectWorkspacePackages?: boolean
  peersSuffixMaxLength?: number
}

export interface PnpmCatalogEntry {
  specifier: string
  version: string
}

// `specifiers` is what the manifest asks for, by alias, over every kind;
// each kind maps the aliases listed under it to their targets.
export interface PnpmImporter {
  specifiers: Record<string, string>
  dependencies: Record<string, Target>
  devDependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
  // `injected`: installed as a copy, a `file:` package, not linked.
  dependenciesMeta: Record<string, { injected: boolean }>
  // Linked by this subdirectory of the project rather than the project,
  // unless linkDirectory is false.
  publishDirectory: string | undefined
  linkDirectory: boolean
}

export interface PnpmEnvImporter {
  specifiers: Record<string, string>
  configDependencies: Record<string, Target>
  packageManagerDependencies: Record<string, Target>
}

// Two snapshots of one package, peers apart, share what its entry in
// `packages` says: the resolution, the engines and the like are the same
// objects in both.
export interface PnpmPackage {
  name: string
  // SemVer, always, but for a directory, which has none in the lockfile.
  version: string | undefined
  resolution: PnpmResolution
  // From the snapshot key, when the package is patched; one of the hashes
  // in patchedDependencies.
  patchHash: string | undefined
  // By alias. A peer resolved for this snapshot is among these.
  dependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
  // Installed only as an optional dependency.
  optional: boolean
  transitivePeerDependencies: string[]
  // What the package's manifest says, as pnpm records it. Absent `os`,
  // `cpu` and `libc` mean any; `bundledDependencies` true means all.
  engines: Record<string, string>
  os: string[] | undefined
  cpu: string[] | undefined
  libc: string[] | undefined
  deprecated: string | undefined
  hasBin: boolean
  bundledDependencies: string[] | true | undefined
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional: boolean }>
}

// A registry package is a tarball with an integrity and, unless the
// lockfile was written with `lockfileIncludeTarballUrl`, no URL: it comes
// from the registry configured for its name, at its version. Otherwise
// `tarball` is an http(s) URL or `file:` and a path from the lockfile's
// directory; a URL is what an install fetches, and is not checked against
// the name and version here. `path` is the package's subdirectory, where
// it is not the root; `gitHosted` is what pnpm 11 and later mark a tarball
// of a git host's with, which earlier versions leave to the URL.
export type PnpmResolution =
  | { type: 'tarball', integrity: string | undefined, tarball: string | undefined, path: string | undefined, gitHosted: boolean }
  | { type: 'git', repo: string, commit: string, path: string | undefined }
  | { type: 'directory', directory: string }
