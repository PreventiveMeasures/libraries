// Makes a fixture of a project `pod install` has run in, with CocoaPods itself: node export.mjs <project> <name>.
// `project/` is what pod-install reads -- the app's project, the lockfile, the podspecs as CocoaPods wrote them
// in Pods/Local Podspecs, the local pods and the downloaded ones as CocoaPods left them in Pods/ -- and
// `expected/` what CocoaPods generated beside them. A podspec whose source is a `file://` archive, as the
// fixture was downloaded from, has it rewritten to a GitHub archive's, and its checksum in the lockfiles with it.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [from, name] = process.argv.slice(2)
const out = new URL(`${name}/`, import.meta.url).pathname
const GENERATED = new Set(['Headers', 'Local Podspecs', 'Manifest.lock', 'Pods.xcodeproj', 'Target Support Files'])
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'project/Podspecs'), { recursive: true })
mkdirSync(join(out, 'expected'), { recursive: true })
for (const file of ['Podfile', 'Podfile.lock']) cpSync(join(from, file), join(out, 'project', file))
const config = JSON.parse(readFileSync(join(from, 'pod.config.json'), 'utf8'))
delete config.podspecs
writeFileSync(join(out, 'project/pod.config.json'), `${JSON.stringify(config, null, 2)}\n`)
const project = readdirSync(from).find((entry) => entry.endsWith('.xcodeproj'))
cpSync(join(from, project, 'project.pbxproj'), join(out, 'project', project, 'project.pbxproj'))
if (existsSync(join(from, 'local'))) cpSync(join(from, 'local'), join(out, 'project/local'), { recursive: true })
for (const entry of readdirSync(join(from, 'Pods'))) if (!GENERATED.has(entry)) cpSync(join(from, 'Pods', entry), join(out, 'project/Pods', entry), { recursive: true })
for (const entry of ['Target Support Files', 'Local Podspecs', 'Manifest.lock']) cpSync(join(from, 'Pods', entry), join(out, 'expected', entry), { recursive: true })
cpSync(join(from, 'Pods/Pods.xcodeproj/project.pbxproj'), join(out, 'expected/Pods.xcodeproj/project.pbxproj'))
const headers = existsSync(join(from, 'Pods/Headers')) ? walk(join(from, 'Pods/Headers')).filter((path) => lstatSync(join(from, 'Pods/Headers', path)).isSymbolicLink()) : []
writeFileSync(join(out, 'expected/links.json'), `${JSON.stringify(Object.fromEntries(headers.sort().map((path) => [`Headers/${path}`, readlinkSync(join(from, 'Pods/Headers', path))])), null, 2)}\n`)

const replaced = new Map()
for (const file of readdirSync(join(out, 'expected/Local Podspecs'))) {
  const before = readFileSync(join(out, 'expected/Local Podspecs', file))
  const spec = JSON.parse(before)
  const after = Buffer.from(before.toString('utf8').replace(/"file:\/\/[^"]*"/u, `"https://github.com/acme/${spec.name.toLowerCase()}/archive/refs/tags/${spec.version}.tar.gz"`))
  replaced.set(sha1(before), sha1(after))
  writeFileSync(join(out, 'expected/Local Podspecs', file), after)
  writeFileSync(join(out, 'project/Podspecs', file), after)
}
for (const lockfile of ['project/Podfile.lock', 'expected/Manifest.lock']) {
  let text = readFileSync(join(out, lockfile), 'utf8')
  for (const [before, after] of replaced) text = text.replaceAll(before, after)
  writeFileSync(join(out, lockfile), text)
}
