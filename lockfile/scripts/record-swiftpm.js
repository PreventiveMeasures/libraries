// Records what SwiftPM writes for the packages below into
// tests/swiftpm/fixtures.json.br: JSON, brotli-compressed, of each run by
// name, the Package.resolved as `resolved` and the root's manifest it was
// written for as `manifest`, each as its text. Downloads Swift's release
// for Ubuntu 24.04 on this machine's CPU from swift.org, or runs the swift
// that SWIFT names, and needs git and network access to github.com:
//
//     node lockfile/scripts/record-swiftpm.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// VERBOSE=1 shows what swift says as it runs.
//
// swiftpm-<version>-v<n>: a package of each kind of pin a repository has,
// written by `swift package resolve` with the root's tools version below
// 5.6, which writes version 1, below 5.10, which writes 2, and 6.0, which
// writes 3: swift-log at a version, swift-atomics on a branch, by a URL of
// capitals and `.git`, and swift-numerics at a revision, a full hash. Of
// version 3, swift-collections at a short hash too, which SwiftPM keeps
// as a branch, and swift-distributed-tracing at a version, which brings
// swift-service-context, at one too.
//
// swiftpm-<version>-registry: a registry's package, mona.LinkedList, by
// its identity, from a registry this script serves on loopback, beside
// swift-log. scm-registry: the same package by a repository's URL, which
// `--replace-scm-with-registry` has SwiftPM look up in the registry, and
// which it keeps as the pin's originalLocation.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const ARCHIVE = fileURLToPath(new URL('../tests/swiftpm/fixtures.json.br', import.meta.url))
const VERSION = '6.4.2'

const stdio = ['ignore', process.env.VERBOSE ? 'inherit' : 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore']
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio })

const work = mkdtempSync(join(tmpdir(), 'record-swiftpm-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

// A command run while this process serves the registry, which a command
// run synchronously would leave unanswered.
async function runAsync(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio })
  const [status] = await once(child, 'exit')
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${status}`)
}

// swift of the release, from swift.org, for this machine.
function swift() {
  if (process.env.SWIFT) return process.env.SWIFT
  const dir = join(work, `swift-${VERSION}`)
  const bin = join(dir, 'usr', 'bin', 'swift')
  if (existsSync(bin)) return bin
  const cpu = { x64: '', arm64: '-aarch64' }[arch()]
  if (platform() !== 'linux' || cpu === undefined) throw new Error(`no Swift release for ${platform()} ${arch()}: set SWIFT to a swift of ${VERSION}`)
  mkdirSync(dir)
  const archive = join(dir, 'swift.tar.gz')
  const release = `swift-${VERSION}-RELEASE`
  run('curl', ['-fsSL', '-o', archive, `https://download.swift.org/swift-${VERSION}-release/ubuntu2404${cpu.replace('-', '')}/${release}/${release}-ubuntu24.04${cpu}.tar.gz`])
  run('tar', ['-xzf', archive, '-C', dir, '--strip-components=1'])
  rmSync(archive)
  return bin
}

const LOG = '.package(url: "https://github.com/apple/swift-log.git", .exact("1.6.1"))'
const ATOMICS = '.package(url: "https://github.com/Apple/Swift-Atomics.git", branch: "main")'
const NUMERICS = '.package(url: "https://github.com/apple/swift-numerics", revision: "0a5bc04095a675662cf24757cc0640aa2204253b")'
const COLLECTIONS = '.package(url: "https://github.com/apple/swift-collections", revision: "8d9834a")'
const TRACING = '.package(url: "https://github.com/apple/swift-distributed-tracing.git", .exact("1.1.2"))'

const manifest = (toolsVersion, dependencies) => [
  `// swift-tools-version:${toolsVersion}`,
  'import PackageDescription',
  '',
  'let package = Package(',
  '    name: "Fixture",',
  '    dependencies: [',
  ...dependencies.map((dependency) => `        ${dependency},`),
  '    ]',
  ')',
  '',
].join('\n')

// mona.LinkedList 1.2.0, its source archive zipped with its directory at
// the top, which SwiftPM strips.
function linkedList() {
  const dir = join(work, 'registry', 'LinkedList')
  mkdirSync(join(dir, 'Sources', 'LinkedList'), { recursive: true })
  const packageSwift = [
    '// swift-tools-version:5.7',
    'import PackageDescription',
    '',
    'let package = Package(',
    '    name: "LinkedList",',
    '    products: [.library(name: "LinkedList", targets: ["LinkedList"])],',
    '    targets: [.target(name: "LinkedList")]',
    ')',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'Package.swift'), packageSwift)
  writeFileSync(join(dir, 'Sources', 'LinkedList', 'LinkedList.swift'), 'public struct LinkedList {}\n')
  run('zip', ['-qrX', 'LinkedList-1.2.0.zip', 'LinkedList'], join(work, 'registry'))
  return { packageSwift, zip: readFileSync(join(work, 'registry', 'LinkedList-1.2.0.zip')) }
}

// The endpoints of the registry protocol SwiftPM asks a registry: the
// releases of the package, one release, its manifest and its source
// archive, and the identifiers of a repository's URL.
function serve({ packageSwift, zip }) {
  const checksum = createHash('sha256').update(zip).digest('hex')
  const headers = (type) => ({ 'Content-Type': type, 'Content-Version': '1' })
  const json = (res, body) => res.writeHead(200, headers('application/json')).end(JSON.stringify(body))
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname.toLowerCase()
    if (path === '/mona/linkedlist') return json(res, { releases: { '1.2.0': { url: `${url.origin}/mona/LinkedList/1.2.0` } } })
    if (path === '/mona/linkedlist/1.2.0') return json(res, { id: 'mona.LinkedList', version: '1.2.0', resources: [{ name: 'source-archive', type: 'application/zip', checksum }], metadata: {} })
    if (path === '/mona/linkedlist/1.2.0/package.swift') return res.writeHead(200, headers('text/x-swift')).end(packageSwift)
    if (path === '/mona/linkedlist/1.2.0.zip') return res.writeHead(200, headers('application/zip')).end(zip)
    if (path === '/identifiers' && url.searchParams.get('url') === 'https://github.com/mona/LinkedList') return json(res, { identifiers: ['mona.LinkedList'] })
    return res.writeHead(404, headers('application/problem+json')).end(JSON.stringify({ detail: 'not found' }))
  })
}

// The registry, the first time it is asked for: its URL.
let registry
async function registryUrl() {
  if (registry === undefined) {
    registry = serve(linkedList()).listen(0, '127.0.0.1')
    await once(registry, 'listening')
  }
  return `http://127.0.0.1:${registry.address().port}`
}

// The package's registries.json: the registry, which is of plain HTTP, and
// whose packages are not signed.
async function useRegistry(dir) {
  mkdirSync(join(dir, '.swiftpm', 'configuration'), { recursive: true })
  const config = {
    authentication: {},
    registries: { '[default]': { supportsAvailability: false, url: await registryUrl() } },
    security: { default: { signing: { onUnsigned: 'silentAllow' } } },
    version: 1,
  }
  writeFileSync(join(dir, '.swiftpm', 'configuration', 'registries.json'), JSON.stringify(config))
}

// SwiftPM's caches, and what it trusts of a registry, kept in the work
// directory, apart from the user's.
async function resolve(name, toolsVersion, dependencies, { registry: registered = false, flags = [] } = {}) {
  const dir = join(work, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'Package.swift'), manifest(toolsVersion, dependencies))
  if (registered) await useRegistry(dir)
  const paths = ['--cache-path', join(work, 'cache'), '--security-path', join(work, 'security')]
  await runAsync(swift(), ['package', ...paths, 'resolve', ...flags], dir)
  return dir
}

const KINDS = [LOG, ATOMICS, NUMERICS]
const LINKED_LIST = '.package(id: "mona.LinkedList", exact: "1.2.0")'
const LINKED_LIST_SCM = '.package(url: "https://github.com/mona/LinkedList", exact: "1.2.0")'

// By the run's name, its root's tools version, what it depends on, and how
// it is resolved.
const RUNS = Object.fromEntries(Object.entries({
  v1: ['5.5', KINDS],
  v2: ['5.9', KINDS],
  v3: ['6.0', [...KINDS, COLLECTIONS, TRACING]],
  registry: ['6.0', [LINKED_LIST, LOG], { registry: true }],
  'scm-registry': ['6.0', [LINKED_LIST_SCM, LOG], { registry: true, flags: ['--replace-scm-with-registry'] }],
}).map(([name, args]) => [`swiftpm-${VERSION}-${name}`, () => resolve(name, ...args)]))

const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(RUNS)
const unknown = names.find((name) => !(name in RUNS))
if (unknown !== undefined) throw new Error(`no run named ${unknown}, of ${Object.keys(RUNS).join(', ')}`)
const recorded = existsSync(ARCHIVE) ? JSON.parse(brotliDecompressSync(readFileSync(ARCHIVE))) : {}
for (const name of names) {
  const dir = await RUNS[name]()
  recorded[name] = { resolved: readFileSync(join(dir, 'Package.resolved'), 'utf8'), manifest: readFileSync(join(dir, 'Package.swift'), 'utf8') }
  console.log(`recorded ${name}`)
}
registry?.close()
const runs = Object.fromEntries(Object.keys(RUNS).filter((name) => name in recorded).map((name) => [name, recorded[name]]))
writeFileSync(ARCHIVE, brotliCompressSync(`${JSON.stringify(runs, null, 2)}\n`))
