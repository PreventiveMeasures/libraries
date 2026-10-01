export { TomlError } from './toml.js'

// Reads a soldeer.lock as Soldeer 0.4 to 0.12 write it, laid out as they lay
// it out. Throws a TomlError for what is not TOML, a LockfileError for
// anything Soldeer would not write, or would install otherwise than the
// lockfile says, and a TypeError for bad arguments.
export function parseSoldeerLockfile(text: string, options?: SoldeerOptions): SoldeerLockfile

export interface SoldeerOptions {
  // soldeer.toml, or foundry.toml where Soldeer reads that, parsed with
  // parseToml. Each of its `dependencies` then needs an entry that Soldeer
  // 0.12 would install it from, and each entry a dependency.
  config?: object
}

// `where` is a property path, into the result, `dependencies["forge-std"]
// .checksum`, or into `config`; undefined for the file's layout, whose
// message has the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

export interface SoldeerLockfile {
  // 1 for a lockfile of Soldeer 0.11 and older, whose integrity hashes 0.12
  // recomputes as it installs.
  lockfileVersion: 1 | 2
  // By name, with a null prototype, which lists a name like `9` first.
  // Soldeer installs each in `dependencies/<name>-<version>`, sanitized.
  dependencies: Record<string, SoldeerDependency>
}

// `version` is the registry's, as resolved, or for a git repository or a
// URL the config names, the config's as written. `checksum` is the hex
// sha256 of the zip, `integrity` of the files it extracts to.
export type SoldeerDependency =
  // From the registry, or the config's URL. Soldeer 0.12 asks the registry
  // for the URL again, and 0.11 and older fetch the one here.
  | { type: 'http', name: string, version: string, url: string, checksum: string, integrity: string }
  | { type: 'git', name: string, version: string, git: string, rev: string }
  // From the registry, privately, at a URL it gives at each install.
  | { type: 'private', name: string, version: string, checksum: string, integrity: string }
