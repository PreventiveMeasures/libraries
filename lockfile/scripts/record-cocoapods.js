// Records what CocoaPods writes for the projects below into
// tests/cocoapods/fixtures.json.br: JSON, brotli-compressed, of each run
// by name, the Podfile.lock as `lock` and the Podfile it was written for
// as `podfile`, each as its text. Needs ruby and gem, git,
// curl, rsync and tar, and network access to rubygems.org, the CocoaPods
// CDN and github.com:
//
//     node lockfile/scripts/record-cocoapods.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// VERBOSE=1 shows what CocoaPods says as it runs. Each CocoaPods is
// installed once, with `gem install`, into $COCOAPODS_GEMS/<version>, or a
// folder under the system's temporary one; those before 1.13 with an
// activesupport before 7.1, which they fail on. Its home, the CDN's specs
// and the pods it caches, is $COCOAPODS_HOME, or one more such folder.
//
// every: an iOS app that asks for every kind of pod a Podfile.lock
// records: from the trunk CDN, a root with a default subspec and a
// dependency, one by two requirements and one by an exact version; from a
// spec repo of its own by `:source`, of a name CocoaPods quotes; from git
// by a branch, a tag, a commit and nothing, with submodules; by `:path`, a
// root, a subspec and a test spec, one subspec with a dependency on macOS
// alone, which nothing installs; by `:podspec`, whose source is a git
// branch; and from a tarball over http, served here, with its sha256.
// CocoaPods 1.17 to 1.10 lock the same pods: 1.13 and later quote what
// reads as a date, 1.10 and later yes, no, on and off, and 1.15 and later
// merge the pods of spec repos of one URL.
//
// empty: an app with no pods, which leaves the Podfile's checksum and the
// CocoaPods version alone.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const ARCHIVE = fileURLToPath(new URL('../tests/cocoapods/fixtures.json.br', import.meta.url))
const GEMS = process.env.COCOAPODS_GEMS ?? join(tmpdir(), 'cocoapods-gems')
const HOME = process.env.COCOAPODS_HOME ?? join(tmpdir(), 'cocoapods-home')
const PORT = 8137

const quiet = process.env.VERBOSE ? 'inherit' : 'ignore'
const run = (command, args, options) => execFileSync(command, args, { stdio: ['ignore', quiet, 'inherit'], ...options })

const before = (version, than) => version.split('.').map(Number).reduce((order, part, index) => order || part - than[index], 0) < 0

// The gems of a CocoaPods, installed where missing, and the environment
// that runs it.
function cocoapods(version) {
  const dir = join(GEMS, version)
  const env = { ...process.env, GEM_HOME: dir, GEM_PATH: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CP_HOME_DIR: HOME, COCOAPODS_DISABLE_STATS: '1' }
  if (!existsSync(join(dir, 'bin', 'pod'))) {
    const gem = (...args) => run('gem', ['install', '--no-document', '--conservative', '--install-dir', dir, ...args], { env })
    if (before(version, [1, 13, 0])) gem('activesupport', '-v', '< 7.1')
    gem('cocoapods', '-v', version)
  }
  return env
}

const PROJECT = `require 'xcodeproj'
project = Xcodeproj::Project.new('App.xcodeproj')
project.new_target(:application, 'App', :ios, '15.0')
project.save
`

const spec = (name, version, rest) => `Pod::Spec.new do |s|
  s.name = '${name}'
  s.version = '${version}'
  s.summary = 'A fixture.'
  s.homepage = 'https://example.com/${name}'
  s.license = { :type => 'MIT' }
  s.authors = { 'Fixture' => 'fixture@example.com' }
  s.swift_version = '5.0'
${rest}end
`

const LOCAL = spec('LocalPod', '0.1.0', `  s.source = { :git => 'https://example.com/LocalPod.git', :tag => s.version.to_s }
  s.ios.deployment_target = '15.0'
  s.osx.deployment_target = '12.0'
  s.default_subspecs = 'Core'
  s.subspec 'Core' do |core|
    core.source_files = 'Sources/Core/*.swift'
    core.dependency 'Alamofire', '~> 5.8'
  end
  s.subspec 'Extra' do |extra|
    extra.source_files = 'Sources/Extra/*.swift'
    extra.dependency 'LocalPod/Core'
    extra.osx.dependency 'Kingfisher', '~> 7.0'
  end
  s.test_spec 'Tests' do |test|
    test.source_files = 'Tests/*.swift'
  end
`)

const SPEC = spec('SpecPod', '2.0.0', `  s.source = { :git => 'https://github.com/devxoul/Then.git', :branch => 'main' }
  s.ios.deployment_target = '15.0'
  s.source_files = 'Sources/Then/*.swift'
`)

const HTTP = spec('HttpPod', '3.0.0', `  s.source = { :http => 'https://example.com/HttpPod.tgz' }
  s.ios.deployment_target = '15.0'
  s.source_files = 'Sources/*.swift'
`)

const KEYCHAIN = '84e546727d66f1adc5439debad16270d0fdd04e7'

const HEAD = `platform :ios, '15.0'
install! 'cocoapods', :integrate_targets => false

target 'App' do
  project 'App.xcodeproj'
`

const every = (sha256) => `source 'https://cdn.cocoapods.org/'

${HEAD}  pod 'Moya', '~> 15.0'
  pod 'Alamofire', '~> 5.8.0'
  pod 'SnapKit', '>= 5.0', '< 6.0'
  pod 'Artsy+UIColors', '3.0.1', :source => 'https://github.com/artsy/Specs.git'
  pod 'Then', :git => 'https://github.com/devxoul/Then.git', :branch => 'main'
  pod 'SwiftyJSON', :git => 'https://github.com/SwiftyJSON/SwiftyJSON.git', :tag => '5.0.2'
  pod 'KeychainAccess', :git => 'https://github.com/kishikawakatsumi/KeychainAccess.git', :commit => '${KEYCHAIN}'
  pod 'Reusable', :git => 'https://github.com/AliSoftware/Reusable.git', :submodules => true
  pod 'LocalPod', :path => 'LocalPod', :testspecs => ['Tests']
  pod 'LocalPod/Extra', :path => 'LocalPod'
  pod 'SpecPod', :podspec => 'specs/SpecPod.podspec'
  pod 'HttpPod', :http => 'http://127.0.0.1:${PORT}/HttpPod.tgz', :type => 'tgz', :sha256 => '${sha256}'
end
`

const write = (dir, path, text) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

// HttpPod's tarball, the same bytes each time, for its sha256.
function tarball(dir) {
  const pod = join(dir, 'httppod')
  write(pod, 'HttpPod.podspec', HTTP)
  write(pod, 'Sources/Http.swift', 'public let http = 1\n')
  const tar = execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '.'], { cwd: pod })
  const tgz = execFileSync('gzip', ['-9n'], { input: tar })
  write(dir, 'serve/HttpPod.tgz', tgz)
  return createHash('sha256').update(tgz).digest('hex')
}

function everyProject(dir) {
  write(dir, 'LocalPod/LocalPod.podspec', LOCAL)
  write(dir, 'LocalPod/Sources/Core/Core.swift', 'public let core = 1\n')
  write(dir, 'LocalPod/Sources/Extra/Extra.swift', 'public let extra = 1\n')
  write(dir, 'LocalPod/Tests/Tests.swift', 'let tests = 1\n')
  write(dir, 'specs/SpecPod.podspec', SPEC)
  return every(tarball(dir))
}

const emptyProject = () => `${HEAD}end
`

const RUNS = [
  { name: 'cocoapods-1.17.0', cocoapods: '1.17.0', project: everyProject },
  { name: 'cocoapods-1.16.2', cocoapods: '1.16.2', project: everyProject },
  { name: 'cocoapods-1.15.2', cocoapods: '1.15.2', project: everyProject },
  { name: 'cocoapods-1.12.1', cocoapods: '1.12.1', project: everyProject },
  { name: 'cocoapods-1.10.2', cocoapods: '1.10.2', project: everyProject },
  { name: 'cocoapods-1.17.0-empty', cocoapods: '1.17.0', project: emptyProject },
]

// Serves the run's serve/ folder, in a process of its own, as CocoaPods
// fetches from it while this one waits.
const SERVER = `const { createServer } = require('node:http')
const { readFile } = require('node:fs')
const { join } = require('node:path')
createServer((req, res) => readFile(join(process.argv[1], req.url), (error, data) => {
  res.writeHead(error ? 404 : 200)
  res.end(data)
})).listen(${PORT}, '127.0.0.1', () => console.log('ready'))
`

async function serve(dir) {
  const server = spawn(process.execPath, ['-e', SERVER, join(dir, 'serve')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve)
    server.once('exit', () => reject(new Error('the server did not start')))
  })
  return server
}

// The Podfile.lock and the Podfile of a run.
async function record({ name, cocoapods: version, project }) {
  const env = cocoapods(version)
  const dir = mkdtempSync(join(tmpdir(), `record-cocoapods-${name}-`))
  const server = await serve(dir)
  try {
    writeFileSync(join(dir, 'Podfile'), project(dir))
    writeFileSync(join(dir, 'project.rb'), PROJECT)
    run('ruby', ['project.rb'], { cwd: dir, env })
    const root = process.getuid?.() === 0 ? ['--allow-root'] : []
    run('pod', ['install', ...root, ...(process.env.VERBOSE ? ['--verbose'] : [])], { cwd: dir, env })
    return { lock: readFileSync(join(dir, 'Podfile.lock'), 'utf8'), podfile: readFileSync(join(dir, 'Podfile'), 'utf8') }
  } finally {
    server.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

const only = process.argv.slice(2)
for (const name of only) if (!RUNS.some((item) => item.name === name)) throw new Error(`no run ${name}`)
const recorded = existsSync(ARCHIVE) ? JSON.parse(brotliDecompressSync(readFileSync(ARCHIVE))) : {}
for (const item of RUNS) if (only.length === 0 || only.includes(item.name)) recorded[item.name] = await record(item)
const runs = Object.fromEntries(RUNS.filter((item) => item.name in recorded).map((item) => [item.name, recorded[item.name]]))
writeFileSync(ARCHIVE, brotliCompressSync(`${JSON.stringify(runs, null, 2)}\n`))
