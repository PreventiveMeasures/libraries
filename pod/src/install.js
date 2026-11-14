// `pod install` without CocoaPods, so that the app's project, which `pod install` integrated once, builds as it
// is. Its stages import none of one another: podspecs to JSON (podspec/, by load.js), the pods' sources laid out
// (sources/), each prepare_command run on the way (prepare/), and what CocoaPods generates beside them (generate/).

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { generate } from './generate/generate.js'
import { load } from './load.js'
import { prepareDownload, refuseLocal } from './prepare/prepare.js'
import { layoutPods } from './sources/sources.js'

const walk = (dir, prefix = '') => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])) : [])

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

// `dir` is the directory of the Podfile.lock.
export async function install(dir) {
  const input = await load(dir)
  const { lock, config, sandbox } = input
  for (const pod of input.pods) if (pod.local) refuseLocal(pod.name, pod.root.attributes.prepare_command)
  const pods = input.pods.map((pod) => {
    const { repo, checkout } = lock.roots[pod.name]
    return { name: pod.name, version: pod.version, checksum: pod.checksum, specs: pod.specs, dir: pod.dir, local: pod.local, external: pod.external, repo, checkout: checkout !== undefined, podspec: pod.bytes }
  })
  const layout = { sandbox, cocoapods: lock.cocoapods, platform: config.platform.name, pods }
  const downloaded = await layoutPods(layout, prepareDownload(config.prepareCommands, lock.cocoapods))
  const { files, links, podTargets, aggregates } = generate(input)
  const written = writeGenerated(input.sandbox, files, links)
  return { pods: podTargets.map((target) => target.name), targets: aggregates.map((aggregate) => aggregate.label), downloaded, written }
}
