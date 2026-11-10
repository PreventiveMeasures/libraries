// `pod install`, without CocoaPods: the pods downloaded into Pods/, and beside them what CocoaPods generates
// there, so that the app's own project, which `pod install` integrated once, builds as it is.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { generate } from './generate.js'
import { load } from './load.js'
import { runPrepare } from './prepare.js'
import { fetchPods } from './sources.js'

const walk = (dir, prefix = '') => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])) : [])

// The pods the last installation downloaded that this one has no more, as Pods/Manifest.lock records them.
async function removeStale(input) {
  const manifest = join(input.sandbox, 'Manifest.lock')
  if (!existsSync(manifest)) return
  const before = await parsePodfileLock(readFileSync(manifest, 'utf8')).catch(() => undefined)
  for (const root of Object.values(before?.roots ?? {})) {
    if (root.external?.type !== 'path' && !input.pods.some((pod) => pod.name === root.name)) rmSync(join(input.sandbox, root.name), { recursive: true, force: true })
  }
}

// What is generated, written where it is not there as it is, so that a build finds changed only what changed;
// what an earlier installation generated and this one does not is removed.
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

// `dir` is the directory of the Podfile.lock; `github` the client pods are fetched through. Returns what was
// done: the pods, those downloaded now, and the files written.
export async function install(dir, github) {
  const input = await load(dir)
  await removeStale(input)
  const downloaded = await fetchPods(input, github)
  for (const pod of input.pods) {
    const command = pod.root.attributes.prepare_command
    if (pod.local && typeof command === 'string') runPrepare(pod.name, command, pod.dir, input.config, input.lock.cocoapods)
  }
  const { files, links, podTargets, aggregates } = generate(input)
  const written = writeGenerated(input.sandbox, files, links)
  return { pods: podTargets.map((target) => target.name), targets: aggregates.map((aggregate) => aggregate.label), downloaded, written }
}
