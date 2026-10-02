export { YamlError } from './yaml.js'

// Reads a pnpm-lock.yaml of `lockfileVersion: '9.0'`, as pnpm 9 to 12 write
// it. Throws a YamlError for YAML pnpm would not write, a LockfileError for
// anything this reader does not know or a lockfile that contradicts itself,
// and a TypeError for anything but a string.
export function parsePnpmLockfile(text: string): PnpmLockfileFile

// The key in `packages` of a snapshot key, its patch hash and peers dropped:
// `react-dom@18.2.0(react@18.2.0)` to `react-dom@18.2.0`.
export function packageKeyOf(key: string): string

// `where` is a property path into the result, `packages["q@1.5.1"].resolution`,
// under `env` for the env document; undefined for the file as a whole.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Each Record has a null prototype, and keeps the lockfile's order.

// A key of `packages`, or `link:` and a directory from the lockfile's.
export type Target = string

// `env` is the document pnpm 11 and later write first, for config
// dependencies and the package manager a project pins; `lockfile` the
// project's. Either may be absent.
export interface PnpmLockfileFile {
  lockfile: PnpmLockfile | undefined
  env: PnpmEnvLockfile | undefined
}

export interface PnpmLockfile {
  lockfileVersion: '9.0'
  settings: PnpmSettings
  // By catalog, then by name.
  catalogs: Record<string, Record<string, PnpmCatalogEntry>>
  // By selector (`foo`, `foo@1`, `bar>foo`), what to install instead.
  overrides: Record<string, string>
  // By selector; `path` is from the lockfile's directory, absent from pnpm 11.
  patchedDependencies: Record<string, { hash: string, path: string | undefined }>
  // Set where packageExtensions or a pnpmfile rewrote manifests: then a
  // package's dependencies here may not be what it publishes.
  packageExtensionsChecksum: string | undefined
  pnpmfileChecksum: string | undefined
  ignoredOptionalDependencies: string[]
  // By package key, publish times, with `resolution-mode=time-based`.
  time: Record<string, string>
  // By directory from the lockfile's, `.` for its own.
  importers: Record<string, PnpmImporter>
  // By snapshot key: a package with two sets of peers is two entries.
  packages: Record<string, PnpmPackage>
}

export interface PnpmEnvLockfile {
  lockfileVersion: '9.0'
  importers: { '.': PnpmEnvImporter }
  packages: Record<string, PnpmPackage>
}

// A setting at its default is absent.
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

// `specifiers` is what the manifest asks for, by alias, over every kind.
export interface PnpmImporter {
  specifiers: Record<string, string>
  dependencies: Record<string, Target>
  devDependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
  // `injected`: copied rather than linked; `node`: the Node its bins run on.
  dependenciesMeta: Record<string, { injected: boolean, node: string | undefined }>
  // Linked by this subdirectory, unless `linkDirectory` is false.
  publishDirectory: string | undefined
  linkDirectory: boolean
}

export interface PnpmEnvImporter {
  specifiers: Record<string, string>
  configDependencies: Record<string, Target>
  packageManagerDependencies: Record<string, Target>
}

// Snapshots of one package share its resolution and manifest fields, as the
// same objects.
export interface PnpmPackage {
  name: string
  // Undefined for a directory.
  version: string | undefined
  resolution: PnpmResolution
  // Where patched, one of the hashes in patchedDependencies.
  patchHash: string | undefined
  // By alias, the peers resolved for this snapshot among them.
  dependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
  // Installed only as an optional dependency.
  optional: boolean
  transitivePeerDependencies: string[]
  // As the manifest says: absent `os`, `cpu` or `libc` means any, and
  // `bundledDependencies` true means all.
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

// A registry package's tarball usually has no URL: it comes from the
// registry for its name. Otherwise `tarball` is an http(s) URL, checked
// against the name and version where it is npm's registry's, or `file:` and
// a path from the lockfile's directory. `path` is the package's
// subdirectory, if not the root, which does not climb out of it. `repo` is
// one in which git reads no option or remote helper.
export type PnpmResolution =
  | { type: 'tarball', integrity: string | undefined, tarball: string | undefined, path: string | undefined, gitHosted: boolean }
  | { type: 'git', repo: string, commit: string, path: string | undefined }
  | { type: 'directory', directory: string }
