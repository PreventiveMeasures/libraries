// The vendor directory `composer install --no-plugins --no-scripts` makes
// from a composer.lock.

import { parseComposerLock } from '@preventive/lockfile/composer.js'
import { getDist } from '@preventive/upstream/composer.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { fold, makeDirs, mount, writeFiles } from '../mount.js'
import { makeBinsExecutable } from './bins.js'
import { configOf } from './config.js'
import { fromArchive, fromZip } from './extract.js'
import { checkHost, inputsOf } from './inputs.js'
import { about, planOf } from './packages.js'

// A vendor directory there already, as Composer would keep what is in it,
// or on macOS a name that is one there with it, is refused.
function noVendor(vendorDir, folded) {
  const same = (a, b) => (folded ? fold(a) === fold(b) : a === b)
  return (vfs) => {
    let at = ''
    for (const segment of vendorDir.split('/')) {
      const found = vfs.isDirectory(at || '/') ? vfs.readdir(at || '/').find((name) => same(name, segment)) : undefined
      if (found === undefined) return
      at = `${at}/${found}`
    }
    throw new DeptreeError(`the vendor directory, ${quote(vendorDir)}, is there already, which is neither kept beside the tree nor removed`, `vfs[${quote(at)}]`)
  }
}

async function fetchAll(plans, github) {
  const trees = new Map()
  await eachConcurrently(plans.filter(({ path }) => path !== null), async ({ key, from }) => {
    const where = about(key)
    trees.set(key, from.shasum === undefined
      ? await fromArchive(await github.getRepoTarball({ repo: from.repo, sha: from.commit, exported: true }), where)
      : await fromZip(await getDist(from.url, from.shasum), where))
  }, ({ key }) => about(key))
  return trees
}

export async function buildComposerTree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const inputs = inputsOf(options ?? {})
  const host = checkHost(given)
  const folded = host.os === 'darwin'
  const lock = parseComposerLock(inputs.lockfile, { composerJson: inputs.composerJson })
  const config = configOf(inputs.composerJson)
  const checkVfs = noVendor(config.vendorDir, folded)
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkVfs(into)
  const plans = planOf(lock, config, folded)
  const trees = await fetchAll(plans, inputs.github)
  makeBinsExecutable(plans, trees)
  const vfs = new Vfs()
  makeDirs(vfs, config.vendorDir)
  const stats = { packages: plans.length, installed: 0, metapackages: 0, files: 0, bytes: 0, links: 0 }
  // In the lockfile's order, whatever order the fetches finished in.
  for (const { key, path } of plans) {
    if (path === null) {
      stats.metapackages++
      continue
    }
    writeFiles(vfs, path, trees.get(key), stats)
    stats.installed++
  }
  const installed = plans.map(({ path, name, version, type, dev, from }) => ({ path, name, version, type, dev, ...from }))
  return { vfs: mount(vfs, into, folded, checkVfs), stats, installed }
}
