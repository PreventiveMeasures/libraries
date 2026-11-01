// The typed contract for host.js, hand-written because the package is plain
// JavaScript. A change to an exported signature belongs in the same commit
// as the change here.

// What the resolver and the asset readers read a tree through, synchronously.
// Paths are absolute, as node:path spells them on the platform; a file and a
// directory are what a link at the path leads to. A Vfs from @preventive/vfs
// is one as it is.
export interface Host {
  // False, not an error, where nothing is there.
  isFile(path: string): boolean
  isDirectory(path: string): boolean
  // The path with every link on it followed; throws where nothing is there.
  realpath(path: string): string
  readFile(path: string): Uint8Array
  // The names in a directory, in any order.
  readdir(path: string): string[]
}

// node:fs's view of the disk.
export const diskHost: Host
