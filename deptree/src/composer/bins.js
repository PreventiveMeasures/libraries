// What Composer's BinaryInstaller does to a package's own files as it
// proxies its bins into vendor/bin: each bin's file, its links followed,
// made 0o777 less the umask, 0o755. A bin that leads to nothing, to a
// directory, or after one of its name already proxied, is passed over, as
// Composer passes it over; one that leads out of the package is refused,
// which Composer 2.10 passes over and others before it follow.

import { DeptreeError, quote } from '../error.js'
import { OUT, realpathIn } from './extract.js'
import { about } from './packages.js'

// PHP's basename, of a path with `/` alone between its names.
const basenameOf = (bin) => bin.replace(/\/+$/u, '').split('/').at(-1)

// `trees` by each plan's key. Two packages' bins of one name are proxied in
// the order Composer installs them in, the first alone, and only it made
// executable; unless every one is already, that is refused.
export function makeBinsExecutable(plans, trees) {
  const claims = new Map()
  for (const { key, path, bin } of plans) {
    if (path === null) continue
    const tree = trees.get(key)
    const proxied = new Set()
    for (const each of bin) {
      const real = realpathIn(tree, each)
      if (real === OUT) throw new DeptreeError(`bin ${quote(each)} leads out of the package, which is not supported`, about(key))
      const name = basenameOf(each)
      if (real === undefined || !tree.files.has(real) || proxied.has(name)) continue
      proxied.add(name)
      claims.set(name, [...claims.get(name) ?? [], { key, file: tree.files.get(real) }])
    }
  }
  for (const [name, files] of claims) {
    if (files.length > 1 && files.some(({ file }) => file.mode !== 0o755)) {
      throw new DeptreeError(`${files.map(({ key }) => quote(key)).join(' and ')} each have a bin named ${quote(name)}, of which Composer makes the first it installs executable alone`, about(files[0].key))
    }
    for (const { file } of files) file.mode = 0o755
  }
}
