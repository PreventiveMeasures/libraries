// `pod install` without CocoaPods: the pods downloaded into Pods/ and what CocoaPods generates beside them, so
// that the app's project, which `pod install` integrated once, builds as it is.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { generate } from './generate.js'
import { load } from './load.js'
import { fetchPods, readManifest } from './sources.js'

const walk = (dir, prefix = '') => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])) : [])

// Removes the pods the last installation downloaded that this one does not have.
async function removeStale(input) {
  const before = await readManifest(input.sandbox)
  for (const root of Object.values(before?.roots ?? {})) {
    if (root.external?.type !== 'path' && !input.pods.some((pod) => pod.name === root.name)) rmSync(join(input.sandbox, root.name), { recursive: true, force: true })
  }
}

// Writes only the files that changed, so a build sees only those changed, and removes what is no longer
// generated. Returns the number of files written.
function writeGenerated(sandbox, files, links) {
  let written = 0
  for (const [path, content] of files) {
    const target = join(sandbox, path)
    const data = Buffer.from(content)
    if (existsSync(target) && readFileSync(target).equals(data)) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    chmodSync(target, path.endsWith('.sh') ? 0o755 : 0o644)
    written++
  }
  for (const dir of ['Target Support Files', 'Local Podspecs']) {
    for (const path of walk(join(sandbox, dir))) if (!files.has(`${dir}/${path}`)) rmSync(join(sandbox, dir, path))
  }
  rmSync(join(sandbox, 'Headers'), { recursive: true, force: true })
  for (const [path, target] of links) {
    mkdirSync(dirname(join(sandbox, path)), { recursive: true })
    symlinkSync(target, join(sandbox, path))
  }
  return written
}

// `dir` is the directory of the Podfile.lock; `github` the client pods are fetched through.
export async function install(dir, github) {
  const input = await load(dir)
  await removeStale(input)
  const downloaded = await fetchPods(input, github)
  const { files, links, podTargets, aggregates } = generate(input)
  const written = writeGenerated(input.sandbox, files, links)
  return { pods: podTargets.map((target) => target.name), targets: aggregates.map((aggregate) => aggregate.label), downloaded, written }
}
