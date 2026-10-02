// The vendor directory `composer install --no-plugins --no-scripts` makes
// from a composer.lock.

import { parseComposerLock } from '@preventive/lockfile/composer.js'
import { getDist } from '@preventive/upstream/composer.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { quote } from '../error.js'
import { checkNoDir, makeDirs, mount, writeFiles } from '../mount.js'
import { makeBinsExecutable } from './bins.js'
import { configOf } from './config.js'
import { fromArchive, fromZip } from './extract.js'
import { checkHost, inputsOf } from './inputs.js'
import { about, planOf } from './packages.js'

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
  const checkVfs = checkNoDir(config.vendorDir, `the vendor directory, ${quote(config.vendorDir)},`)
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkVfs(into, folded)
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
