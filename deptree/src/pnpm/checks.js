// Checks of a lockfile and of the tree built from it that pnpm does not
// make, each of something a lockfile pnpm writes always holds to, or a
// tree it installs always is: where one fails, the lockfile was not
// written by pnpm as it stands, or the tree would not be one tree
// everywhere it is installed.

import { DeptreeError, quote } from '../error.js'

// A snapshot is optional exactly where no importer reaches it through
// dependencies alone, its devDependencies counted among them, as pnpm
// marks it: one marked otherwise would be left out, or kept, where it
// should not be.
export function checkOptional(lockfile) {
  const required = new Set()
  const queue = []
  const reach = (targets) => {
    for (const target of Object.values(targets)) {
      if (target.startsWith('link:') || required.has(target)) continue
      required.add(target)
      queue.push(target)
    }
  }
  for (const importer of Object.values(lockfile.importers)) {
    reach(importer.dependencies)
    reach(importer.devDependencies)
  }
  while (queue.length > 0) reach(lockfile.packages[queue.pop()].dependencies)
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    if (pkg.optional === required.has(key)) {
      throw new DeptreeError(`marked ${pkg.optional ? 'optional where an importer requires it' : 'required where only optional dependencies reach it'}, which pnpm never writes`, `snapshots[${quote(key)}]`)
    }
  }
}

// Every link into node_modules leads to a directory in the tree; a link
// out of it leads to a project or a `link:` directory, which the tree
// does not hold.
export function checkLinks(vfs, links) {
  for (const [path, target] of links) {
    if (!target.startsWith('node_modules/') && !target.includes('/node_modules/')) continue
    if (!vfs.isDirectory(`/${path}`)) throw new DeptreeError(`leads to ${quote(target)}, which the tree does not hold`, quote(path))
  }
}
