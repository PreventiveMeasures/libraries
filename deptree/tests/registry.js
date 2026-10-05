import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

// upstream looks in npm's and cargo's caches and the home directory before
// the registry: all point at a directory never made, so no local tarball or
// .crate answers.
const NOWHERE = join(tmpdir(), `deptree-test-${process.pid}-nowhere`)
process.env.HOME = NOWHERE
process.env.npm_config_cache = NOWHERE
delete process.env.NPM_CONFIG_CACHE
delete process.env.CARGO_HOME

const encoder = new TextEncoder()

export const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
export const url = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`

// As npm packs one; `files` maps a path to text, or to `{ data, mode }`.
export async function tarball(name, version, files = {}, { top = 'package', manifest = {} } = {}) {
  const all = { 'package.json': JSON.stringify({ name, version, ...manifest }), ...files }
  const entries = Object.entries(all).filter(([, file]) => file !== undefined).map(([path, file]) => {
    const { data, mode } = typeof file === 'string' ? { data: file } : file
    return { name: `${top}/${path}`, data: typeof data === 'string' ? encoder.encode(data) : data, mode: mode ?? 0o644 }
  })
  const bytes = await compress(pack(entries), 'gzip')
  return { name, version, bytes, integrity: sri(bytes) }
}

// A tar of files under their names as given, which pack would refuse: a
// ustar header each, of `type` or a file's, 0o644, owned by root, from the
// epoch.
export function rawTar(entries) {
  const blocks = []
  for (const { name, data, type = '0' } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    for (const [at, value, width] of [[100, 0o644, 7], [108, 0, 7], [116, 0, 7], [124, Buffer.byteLength(data), 11], [136, 0, 11]]) header.write(`${value.toString(8).padStart(width, '0')}\0`, at)
    header.write(`        ${type}`, 148)
    header.write('ustar\u000000', 257)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0`, 148)
    blocks.push(header, Buffer.from(data), Buffer.alloc(-Buffer.byteLength(data) & 511))
  }
  return new Uint8Array(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

// The registry: each tarball at its URL, npm's unless `urlOf` gives another,
// and its version's document, with the dist it is served by.
export function stubRegistry(tarballs, urlOf = url) {
  const served = new Map(tarballs.map((t) => [urlOf(t.name, t.version), t.served ?? t.bytes]))
  const documents = new Map(tarballs.map((t) => [`https://registry.npmjs.org/${t.name}/${t.version}`, { name: t.name, version: t.version, dist: { tarball: url(t.name, t.version), integrity: t.integrity } }]))
  const calls = []
  globalThis.fetch = (input) => {
    calls.push(String(input))
    const document = documents.get(String(input))
    if (document !== undefined) return Promise.resolve(Response.json(document))
    const bytes = served.get(String(input))
    return Promise.resolve(bytes === undefined ? Response.json({ error: 'Not found' }, { status: 404 }) : new Response(bytes))
  }
  return calls
}

// The stubbed fetch, each answer `ms` late unless `now` gives one; counts
// the fetches still coming, and the most at once.
export function slowed(ms, now = () => undefined) {
  const served = globalThis.fetch
  const count = { open: 0, most: 0 }
  globalThis.fetch = async (input) => {
    const answer = now(String(input))
    if (answer !== undefined) return answer
    count.most = Math.max(count.most, ++count.open)
    await new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
    count.open--
    return await served(input)
  }
  return count
}

// `name`@`version` is not found at once, while every other tarball comes
// late; what is returned tells how many are still coming.
export function stubFailingRegistry(tarballs, name, version) {
  stubRegistry(tarballs)
  const count = slowed(100, (input) => (input === url(name, version) ? Response.json({ error: 'Not found' }, { status: 404 }) : undefined))
  return () => count.open
}

export const paths = (vfs) => [...vfs.walk('/')].map(({ path, type }) => `${path} ${type}`)

export const HOST = Object.freeze({ pnpm: '10.33.4', node: '24.15.0', os: 'linux', cpu: 'x64', libc: 'glibc' })

// A zip with every field as given, as one from Soldeer's registry may have
// it, repeats and all; `size` is the size declared, whatever the data's.
export function rawZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data ?? '')
    const extra = entry.extra ?? Buffer.alloc(0)
    const system = entry.system ?? 3
    const attributes = entry.attributes ?? (entry.mode ?? (name.at(-1) === 0x2f ? 0o40755 : 0o100644)) * 0x10000
    const crc = crc32(data) >>> 0
    const body = entry.deflate ? deflateRawSync(data) : data
    const method = entry.deflate ? 8 : 0
    const size = entry.size ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((system << 8) | 30, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(attributes >>> 0, 38); central.writeUInt32LE(offset, 42)
    const whole = Buffer.concat([local, name, extra, body])
    locals.push(whole)
    centrals.push(Buffer.concat([central, name, extra]))
    offset += whole.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const SOLDEER_API = 'https://api.soldeer.xyz/api/v1/revision-cli'
const revisions = (name) => `https://soldeer-revisions.s3.amazonaws.com/${name}/`

export function stubSoldeer(zips) {
  const calls = []
  globalThis.fetch = (input) => {
    const asked = new URL(String(input))
    calls.push(asked.href)
    if (`${asked.origin}${asked.pathname}` === SOLDEER_API) {
      const found = zips.find((z) => z.name === asked.searchParams.get('project_name') && z.version === asked.searchParams.get('revision'))
      return Promise.resolve(Response.json({ status: 'success', data: found === undefined ? [] : [{ version: found.version, url: `${revisions(found.name)}${found.version}.zip` }] }))
    }
    const found = zips.find((z) => asked.href === `${revisions(z.name)}${z.version}.zip`)
    return Promise.resolve(found === undefined ? Response.json({ error: 'Not found' }, { status: 404 }) : new Response(found.bytes))
  }
  return calls
}

const GITHUB_REPOS = 'https://api.github.com/repos/'

// Beside the fetch stubbed already, GitHub's API for `repos`, each by
// `owner/name`: { commit, tree, tarball, listings }, the listings each
// tree's entries by its id. Returns what was asked of it, from the repo on.
export function stubGitHub(repos) {
  const served = globalThis.fetch
  const calls = []
  globalThis.fetch = (input, init) => {
    const asked = String(input)
    if (!asked.startsWith(GITHUB_REPOS)) return served(input, init)
    const path = asked.slice(GITHUB_REPOS.length)
    calls.push(path)
    const [owner, name, ...rest] = path.split('/')
    const repo = repos[`${owner}/${name}`]
    const [kind, id] = [rest.slice(0, -1).join('/'), rest.at(-1)]
    const notFound = () => Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    if (repo === undefined) return notFound()
    if (kind === 'git/commits' && id === repo.commit) return Promise.resolve(Response.json({ sha: repo.commit, tree: { sha: repo.tree } }))
    if (kind === 'tarball' && id === repo.tree) return Promise.resolve(new Response(repo.tarball))
    if (kind === 'git/trees' && Object.hasOwn(repo.listings, id)) return Promise.resolve(Response.json({ sha: id, tree: repo.listings[id], truncated: false }))
    return notFound()
  }
  return calls
}
