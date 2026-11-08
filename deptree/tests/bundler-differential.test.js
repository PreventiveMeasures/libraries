import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { DeptreeError, buildBundlerTree } from '../bundler.js'
import { bundlerNotBuilt, difference, projectView, readSide } from '../bin/compare.js'
import { installGem } from '../src/bundler/extract.js'
import { readGem } from '../src/bundler/gem.js'
import { parsePsych } from '../src/bundler/yaml.js'
import { readSpec } from '../src/bundler/spec.js'
import { gemOf } from './bundler-fixture.js'
import { bundlerVersion, reference } from './bundler-reference.js'

// Bundler and RubyGems themselves against the port here: random .gem files,
// installed by Bundler's own installer as `bundle install` runs it; random
// specs, written by Gem::Specification#to_yaml and read back by from_yaml;
// and a real `bundle install` of a lockfile of gems from rubygems.org, one
// of them of a platform's own, set beside the tree built from it. Skipped
// where ruby or Bundler is missing, or is a Bundler or a RubyGems this does
// not take; the install where rubygems.org cannot be reached. The seeds are
// fixed.

const host = bundlerVersion()
const SKIP = host === undefined ? 'no ruby with Bundler' : host.engine === 'ruby' ? false : `${host.engine}, not CRuby`

function random(seed) {
  let state = seed
  const next = (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state >>> 16) % n
  }
  return { next, pick: (items) => items[next(items.length)] }
}

// A ustar header as any tar writes one, of a name, mode, type and link
// target as given, which @preventive/archive's pack would hold to more.
function ustar(entries) {
  const blocks = []
  for (const { name, mode = 0o644, type = '0', linkname = '', data = Buffer.alloc(0) } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    for (const [at, value, width] of [[100, mode, 7], [108, 0, 7], [116, 0, 7], [124, data.length, 11], [136, 0, 11]]) header.write(`${value.toString(8).padStart(width, '0')}\0`, at)
    header.write(`        ${type}`, 148)
    header.write(linkname, 157)
    header.write('ustar\u000000', 257)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0`, 148)
    blocks.push(header, data, Buffer.alloc(-data.length & 511))
  }
  return new Uint8Array(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

const DIRS = ['lib', 'lib/x', 'bin', 'exe', 'd', '.hid', 'a b', 'lib/x/y']
const NAMES = ['a.rb', 'b', '.dot', 'README', 'tool', 'z']
const FILE_MODES = [0o644, 0o644, 0o644, 0o755, 0o755, 0o600, 0o444, 0o664, 0o777, 0o700, 0o640, 0o400, 0o100644]
const DIR_MODES = [0o755, 0o755, 0o700, 0o775, 0o777, 0o750, 0o40755]
const TARGETS = ['a.rb', 'a.rb', '../a.rb', 'nowhere', '.', 'lib', '../lib/a.rb', 'bin/tool', 'tool', 'lib/x/y', 'z', '../../z', 'b']

// A gem of directories, each of a mode of its own entry now and then, then
// files and links made at random: now and then a name again, a directory's
// entry after what is in it, a mode RubyGems keeps a special bit of, or one
// no user but root can write in; and executables, some of them missing or
// not executable.
async function gemCaseOf(r, i) {
  const entries = []
  for (const dir of DIRS) {
    if (r.next(5) === 0) entries.push({ name: `${dir}/`, type: '5', mode: r.next(60) === 0 ? r.pick([0o555, 0o2755, 0o300]) : r.pick(DIR_MODES) })
  }
  const kinds = new Map()
  for (let n = 1 + r.next(14); n > 0; n--) {
    const dir = r.next(4) === 0 ? '' : r.pick(DIRS)
    const path = dir === '' ? r.pick(NAMES) : `${dir}/${r.pick(NAMES)}`
    const kind = r.next(30)
    if (kinds.has(path)) {
      if (r.next(3) === 0) entries.push(kinds.get(path))
      continue
    }
    if (kind === 0) {
      entries.push({ name: `${dir || r.pick(DIRS)}/`, type: '5', mode: 0o755 })
    } else if (kind <= 7) {
      entries.push({ name: path, type: '2', linkname: r.pick(TARGETS), mode: 0o777 })
      kinds.set(path, entries.at(-1))
    } else {
      entries.push({ name: path, mode: r.next(150) === 0 ? 0o4755 : r.pick(FILE_MODES), data: Buffer.from(`${path}\n`) })
      kinds.set(path, entries.at(-1))
    }
  }
  const executables = NAMES.filter(() => r.next(4) === 0)
  const spec = { name: `g${i}`, version: '1.0.0', executables, bindir: r.pick(['bin', 'exe', 'lib/x', '.']) }
  return { bytes: (await gemOf(spec, { tar: ustar(entries) })).bytes, spec, entries }
}

async function portInstall(bytes) {
  const { spec, entries } = await readGem(bytes, 'gem')
  const { dirs, files, links } = installGem(entries, spec, false, 'gem')
  return [...dirs.map(({ path, mode }) => [path, 'directory', mode]), ...[...files].map(([path, { mode }]) => [path, 'file', mode]), ...[...links].map(([path, target]) => [path, 'symlink', target])]
}

const sorted = (entries) => entries.map((entry) => JSON.stringify(entry)).sort()

// A spec's strings as the port reads them, as the reference lists them.
function portRead(yaml) {
  const spec = readSpec(yaml, 'spec')
  const fields = parsePsych(yaml, 'spec').entries
  const value = (node) => {
    if (node === undefined || node.type === 'null') return null
    if (node.type === 'binary') return { binary: node.value.replaceAll(/\s/gu, '') }
    if (node.kind === 'seq') return node.items.map(value)
    if (node.kind === 'map') return Object.fromEntries([...node.entries].map(([key, item]) => [key, value(item)]))
    return node.value
  }
  const own = Object.fromEntries(['summary', 'description', 'authors', 'files', 'executables', 'post_install_message', 'metadata', 'homepage'].map((key) => [key, value(fields.get(key))]))
  return { name: spec.name, version: spec.version, platform: spec.platform, ...own, metadata: own.metadata ?? {}, executables: own.executables ?? [], dependencies: spec.dependencies.map(({ name, requirements }) => [name, requirements]) }
}

describe('the port, against Bundler and RubyGems', { skip: SKIP }, () => {
  it('leaves of each .gem what Bundler\'s installer does, where it does not refuse it', async () => {
    const r = random(9)
    const cases = []
    for (let i = 0; i < 300; i++) cases.push(await gemCaseOf(r, i))
    const { install: expected } = reference({ install: cases.map(({ bytes }) => Buffer.from(bytes).toString('base64')) })
    let compared = 0
    let refused = 0
    for (const [i, one] of cases.entries()) {
      let ours
      try {
        ours = await portInstall(one.bytes)
      } catch (error) {
        if (!(error instanceof DeptreeError)) throw error
        refused++
        continue
      }
      assert.equal(expected[i].error, undefined, `Bundler fails on what the port takes: ${JSON.stringify(one.entries)} ${JSON.stringify(one.spec)}`)
      assert.deepEqual(sorted(ours), sorted(expected[i].entries), `${JSON.stringify(one.entries)} ${JSON.stringify(one.spec)}`)
      compared++
    }
    assert.ok(compared > 100 && refused > 20, `compared ${compared}, refused ${refused}`)
  })

  // Refused, as libyaml writes it raw in a block scalar: a line break of
  // YAML 1.1 but LF, of which the specs made at random hold many.
  it('reads each spec as Gem::Specification.from_yaml does, as #to_yaml writes it, where it does not refuse it', () => {
    const { specs } = reference({ specs: { seed: 3, count: 400 } })
    let compared = 0
    for (const { yaml, read } of specs) {
      assert.equal(read.error, undefined, yaml)
      let ours
      try {
        ours = portRead(yaml)
      } catch (error) {
        if (error instanceof DeptreeError && /a line break of YAML 1\.1 but LF/u.test(error.message) && /[\u0085\u2028\u2029]/u.test(yaml)) continue
        throw error
      }
      assert.deepEqual(ours, read, yaml)
      compared++
    }
    assert.ok(compared > 250, `compared ${compared}`)
  })
})

// A lockfile Bundler 4 wrote, but for BUNDLED WITH, so that any Bundler
// takes it: a gem of every platform but none, ffi; a dependency of a
// dependency; executables, rake's; and a default gem of Ruby 3.3, logger.
const LOCKFILE = `GEM
  remote: https://rubygems.org/
  specs:
    concurrent-ruby (1.3.4)
    ffi (1.17.0)
    ffi (1.17.0-aarch64-linux-gnu)
    ffi (1.17.0-aarch64-linux-musl)
    ffi (1.17.0-arm-linux-gnu)
    ffi (1.17.0-arm-linux-musl)
    ffi (1.17.0-arm64-darwin)
    ffi (1.17.0-x86-linux-gnu)
    ffi (1.17.0-x86-linux-musl)
    ffi (1.17.0-x86_64-darwin)
    ffi (1.17.0-x86_64-linux-gnu)
    ffi (1.17.0-x86_64-linux-musl)
    logger (1.6.0)
    mustermann (3.0.3)
      ruby2_keywords (~> 0.0.1)
    rack (3.1.8)
    rake (13.2.1)
    ruby2_keywords (0.0.5)

PLATFORMS
  aarch64-linux
  aarch64-linux-gnu
  aarch64-linux-musl
  arm-linux-gnu
  arm-linux-musl
  arm64-darwin
  ruby
  x86-linux-gnu
  x86-linux-musl
  x86_64-darwin
  x86_64-linux-gnu
  x86_64-linux-musl

DEPENDENCIES
  concurrent-ruby (= 1.3.4)
  ffi (= 1.17.0)
  logger (= 1.6.0)
  mustermann (= 3.0.3)
  rack (= 3.1.8)
  rake (= 13.2.1)

CHECKSUMS
  concurrent-ruby (1.3.4) sha256=d4aa926339b0a86b5b5054a0a8c580163e6f5dcbdfd0f4bb916b1a2570731c32
  ffi (1.17.0) sha256=51630e43425078311c056ca75f961bb3bda1641ab36e44ad4c455e0b0e4a231c
  ffi (1.17.0-aarch64-linux-gnu) sha256=228c8fb79e6b018a31c75414115a75ca65f74e8138b2c9c97d22041e4e12f2c1
  ffi (1.17.0-aarch64-linux-musl) sha256=f31ab84b3d7a850a22d2767b66dafebaebe12f64eaa9a4d1748d417ad1123109
  ffi (1.17.0-arm-linux-gnu) sha256=ae3b5bf4701c84263002f13eadfde35fe1e6f88720e7c6f15f1f08f46d745857
  ffi (1.17.0-arm-linux-musl) sha256=6f9dc84817e2dfb62fd209649097e134625c9a66db43c441fa7a8ddb17f40fc9
  ffi (1.17.0-arm64-darwin) sha256=609c874e76614542c6d485b0576e42a7a38ffcdf086612f9a300c4ec3fcd0d12
  ffi (1.17.0-x86-linux-gnu) sha256=81b80d24392be2b8ec6bd66da6b488fd05242af5c0868b59c8b716e5a633c8b5
  ffi (1.17.0-x86-linux-musl) sha256=6917c10e928b80dbf9b16abf9696aa9d7ca417a24d0cc5c1d53fb4ce9799c8c1
  ffi (1.17.0-x86_64-darwin) sha256=fdcd48c69db3303ef95aec5c64d6275fcf9878a02c0bec0afddc506ceca0f56b
  ffi (1.17.0-x86_64-linux-gnu) sha256=1015e59d5919dd6bbcb0704325b0bd639be664a79b1e2189943ceb18faa34198
  ffi (1.17.0-x86_64-linux-musl) sha256=6573299eedf8dd16668f8a435b72c4236b61bca0279bb73c811e3cbdb395e877
  logger (1.6.0) sha256=0ab7c120262dd8de2a18cb8d377f1f318cbe98535160a508af9e7710ff43ef3e
  mustermann (3.0.3) sha256=d1f8e9ba2ddaed47150ddf81f6a7ea046826b64c672fbc92d83bce6b70657e88
  rack (3.1.8) sha256=d3fbcbca43dc2b43c9c6d7dfbac01667ae58643c42cea10013d0da970218a1b1
  rake (13.2.1) sha256=46cb38dae65d7d74b6020a4ac9d48afed8eb8149c040eccf0523bec91907059d
  ruby2_keywords (0.0.5) sha256=ffd13740c573b7301cf7a2e61fc857b2a8e3d3aff32545d6f8300d8bae10e3ef
`
const GEMFILE = 'source "https://rubygems.org"\n\n%w[concurrent-ruby:1.3.4 ffi:1.17.0 logger:1.6.0 mustermann:3.0.3 rack:3.1.8 rake:13.2.1].each { |g| name, version = g.split(":"); gem name, version }\n'

async function reachable() {
  try {
    return (await fetch('https://index.rubygems.org/info/rack', { method: 'HEAD', signal: AbortSignal.timeout(10_000) })).ok
  } catch {
    return false
  }
}

const INSTALL_SKIP = SKIP || (!await reachable() && 'rubygems.org cannot be reached')

describe('a bundle install, against the tree built from its lockfile', { skip: INSTALL_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'deptree-bundler-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  it('holds the same gems, files, modes and links under BUNDLE_PATH', async (t) => {
    mkdirSync(join(root, '.bundle'))
    writeFileSync(join(root, 'Gemfile'), GEMFILE)
    writeFileSync(join(root, 'Gemfile.lock'), LOCKFILE)
    writeFileSync(join(root, '.bundle', 'config'), '---\nBUNDLE_PATH: "vendor/bundle"\n')
    const options = { project: projectView(root), host: { ...host, os: process.platform } }
    let tree
    try {
      tree = await buildBundlerTree(options)
    } catch (error) {
      // ffi's gems of a platform are for Rubies before 3.4, and Bundler
      // before 2.5.12 is not taken.
      if (error instanceof DeptreeError && /requires Ruby|host\.(?:bundler|rubygems|ruby|platform)|none of PLATFORMS/u.test(error.message)) return t.skip(error.message)
      throw error
    }
    const r = spawnSync('bundle', ['install', '--quiet'], { cwd: root, encoding: 'utf8', env: { ...process.env, BUNDLE_GEMFILE: join(root, 'Gemfile') }, timeout: 300_000 })
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const notBuilt = bundlerNotBuilt('vendor/bundle')
    const changes = difference(readSide(projectView(root), ['vendor/bundle'], notBuilt), readSide(tree.vfs, ['vendor/bundle'], notBuilt))
    const scope = `vendor/bundle/ruby/${host.ruby.replace(/\.\d+$/u, '.0')}`
    const generated = new Set(['bin', 'build_info', 'doc', 'extensions', 'plugins', 'specifications'].map((name) => `${scope}/${name}`))
    assert.deepEqual(changes.filter(({ path }) => !generated.has(path)).map(({ mark, path, what }) => `${mark} ${path} ${what ?? ''}`), [])
    assert.deepEqual(tree.installed.map(({ name }) => name), ['concurrent-ruby', 'ffi', 'logger', 'mustermann', 'rack', 'rake', 'ruby2_keywords'])
  })
})
