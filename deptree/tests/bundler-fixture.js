import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { sha256 } from './registry.js'

// .gem files as `gem build` makes them, lockfiles as Bundler 4 writes
// them, and rubygems.org stubbed, for tests/bundler.test.js and the CLI's.

// upstream reads RubyGems' caches by these before rubygems.org.
delete process.env.GEM_HOME
delete process.env.GEM_PATH
delete process.env.XDG_DATA_HOME

const encoder = new TextEncoder()

export const HOST = Object.freeze({ bundler: '4.0.18', rubygems: '3.5.22', ruby: '3.3.6', platform: 'x86_64-linux', os: 'linux' })

const requirementYaml = (pairs, indent) => {
  const pad = ' '.repeat(indent)
  return `!ruby/object:Gem::Requirement\n${pad}  requirements:\n${pairs.map(([op, version]) => `${pad}  - - "${op}"\n${pad}    - !ruby/object:Gem::Version\n${pad}      version: '${version}'\n`).join('')}`
}

// A spec as Gem::Specification#to_yaml writes one; `deps` [name, [[op,
// version], ...], type], `extra` lines at the end.
export function specYaml({ name, version, platform = 'ruby', deps = [], executables = [], bindir = 'bin', extensions = [], requiredRuby = [['>=', '0']], requiredRubygems = [['>=', '0']], homepage, metadata = {}, extra = '' }) {
  const list = (items) => (items.length === 0 ? ' []\n' : `\n${items.map((item) => `- ${item}\n`).join('')}`)
  const dependencies = deps.map(([dep, pairs, type = 'runtime']) => `- !ruby/object:Gem::Dependency\n  name: ${dep}\n  requirement: ${requirementYaml(pairs, 2)}  type: :${type}\n  prerelease: false\n  version_requirements: ${requirementYaml(pairs, 2)}`).join('')
  const meta = Object.entries(metadata).map(([key, value]) => `  ${key}: ${value}\n`).join('')
  return `--- !ruby/object:Gem::Specification
name: ${name}
version: !ruby/object:Gem::Version
  version: '${version}'
platform: ${platform}
authors:
- Acme
autorequire:
bindir: ${bindir}
cert_chain: []
date: 2024-10-14 00:00:00.000000000 Z
dependencies:${deps.length === 0 ? ' []\n' : `\n${dependencies}`}description: |
  A gem.
executables:${list(executables)}extensions:${list(extensions)}files: []
homepage:${homepage === undefined ? '' : ` ${homepage}`}
licenses:
- MIT
metadata:${meta === '' ? ' {}\n' : `\n${meta}`}require_paths:
- lib
required_ruby_version: ${requirementYaml(requiredRuby, 0)}required_rubygems_version: ${requirementYaml(requiredRubygems, 0)}rubygems_version: 3.5.22
specification_version: 4
summary: A gem.
${extra}`
}

const bytesOf = (data) => (typeof data === 'string' ? encoder.encode(data) : data)

// The entries of data.tar: `files` maps a path to text, or to an entry's
// fields; `entries` are entries as given.
export function dataEntries(files = {}, entries = []) {
  return [
    ...Object.entries(files).map(([name, file]) => {
      const { data = '', ...fields } = typeof file === 'string' || file instanceof Uint8Array ? { data: file } : file
      const type = fields.type ?? 'file'
      return { name, mode: 0o644, ...fields, ...(type === 'file' ? { data: bytesOf(data) } : {}) }
    }),
    ...entries,
  ]
}

const SHA512 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-512', bytes)).toString('hex')

// A .gem as Gem::Package#build makes it: metadata.gz, data.tar.gz and
// checksums.yaml.gz, each 0o444, in a ustar tar. `tar` is data.tar's bytes
// where given; `members` replaces the outer entries.
export async function gemOf(spec, { files = { 'lib/a.rb': 'a\n' }, entries = [], tar, yaml, checksums, members } = {}) {
  const key = spec.platform === undefined || spec.platform === 'ruby' ? `${spec.name}-${spec.version}` : `${spec.name}-${spec.version}-${spec.platform}`
  const metadata = await compress(encoder.encode(yaml ?? specYaml(spec)), 'gzip')
  const data = await compress(tar ?? pack(dataEntries(files, entries), { format: 'ustar' }), 'gzip')
  const sums = checksums ?? `---\nSHA256:\n  metadata.gz: ${sha256(metadata)}\n  data.tar.gz: ${sha256(data)}\nSHA512:\n  metadata.gz: ${await SHA512(metadata)}\n  data.tar.gz: ${await SHA512(data)}\n`
  const outer = members ?? [
    { name: 'metadata.gz', data: metadata, mode: 0o444 },
    { name: 'data.tar.gz', data, mode: 0o444 },
    { name: 'checksums.yaml.gz', data: await compress(encoder.encode(sums), 'gzip'), mode: 0o444 },
  ]
  const bytes = pack(outer, { format: 'ustar' })
  return { name: spec.name, version: spec.version, platform: spec.platform ?? 'ruby', key, deps: spec.deps ?? [], bytes, checksum: sha256(bytes), metadata, data }
}

const lockName = ({ name, version, platform }) => `${name} (${version}${platform === 'ruby' ? '' : `-${platform}`})`
const lockDep = ([name, pairs, type = 'runtime']) => (type === 'runtime' ? [pairs.length === 1 && pairs[0][0] === '>=' && pairs[0][1] === '0' ? name : `${name} (${pairs.map((pair) => pair.join(' ')).sort().toReversed().join(', ')})`] : [])

// A Gemfile.lock as Bundler 4 writes one, of `gems` from rubygems.org and
// `others`, each { name, version, platform, deps }, under `sources` as
// written; DEPENDENCIES `dependencies`, by default every gem's name; no
// BUNDLED WITH where `bundled` is null.
export function lockOf(gems, { platforms = ['ruby', 'x86_64-linux'], dependencies, sources = '', others = [], checksums = true, bundled = '4.0.18' } = {}) {
  const spec = (gem) => [`    ${lockName(gem)}`, ...gem.deps.flatMap(lockDep).sort().map((dep) => `      ${dep}`)].join('\n')
  const names = dependencies ?? [...new Set([...gems, ...others].map(({ name }) => name))]
  const sumOf = (gem) => `  ${lockName(gem)}${gem.checksum === undefined ? '' : ` sha256=${gem.checksum}`}`
  const sums = checksums ? `CHECKSUMS\n${[...gems, ...others].map(sumOf).sort().join('\n')}\n\n` : ''
  const byKey = (a, b) => (a.key < b.key ? -1 : 1)
  return `${sources}GEM
  remote: https://rubygems.org/
  specs:
${gems.toSorted(byKey).map(spec).join('\n')}

PLATFORMS
${platforms.map((platform) => `  ${platform}`).join('\n')}

DEPENDENCIES
${names.toSorted().map((name) => `  ${name}`).join('\n')}

${sums}${bundled === null ? '' : `BUNDLED WITH\n  ${bundled}\n`}`.replace(/\n\n$/u, '\n')
}

// rubygems.org, each gem at /gems/<file>.gem, `served` over its bytes
// where given, and in the compact index. Returns what was asked of it.
export function stubGems(gems) {
  const served = new Map(gems.map((gem) => [`https://rubygems.org/gems/${gem.key}.gem`, gem.served ?? gem.bytes]))
  const index = Map.groupBy(gems, (gem) => gem.name)
  const calls = []
  globalThis.fetch = (input) => {
    const asked = String(input)
    calls.push(asked)
    const info = /^https:\/\/index\.rubygems\.org\/info\/(.+)$/u.exec(asked)
    if (info !== null && index.has(info[1])) {
      const lines = index.get(info[1]).map((gem) => `${gem.version}${gem.platform === 'ruby' ? '' : `-${gem.platform}`} |checksum:${gem.checksum}`)
      return Promise.resolve(new Response(`---\n${lines.join('\n')}\n`))
    }
    const bytes = served.get(asked)
    return Promise.resolve(bytes === undefined ? new Response('Not found', { status: 404 }) : new Response(bytes))
  }
  return calls
}
