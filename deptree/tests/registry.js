import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
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

export const sri = (bytes, algorithm = 'sha512') => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
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
// epoch, with the data's size unless `size` gives another.
export function rawTar(entries) {
  const blocks = []
  for (const { name, data, type = '0', size = Buffer.byteLength(data) } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    for (const [at, value, width] of [[100, 0o644, 7], [108, 0, 7], [116, 0, 7], [124, size, 11], [136, 0, 11]]) header.write(`${value.toString(8).padStart(width, '0')}\0`, at)
    header.write(`        ${type}`, 148)
    header.write('ustar\u000000', 257)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0`, 148)
    blocks.push(header, Buffer.from(data), Buffer.alloc(-Buffer.byteLength(data) & 511))
  }
  return new Uint8Array(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

// The registry: each tarball at its URL, npm's unless `urlOf` gives another,
// its version's document, with the dist it is served by, `t.dist` over it,
// and `t.document`'s fields beside, and its package's, with `time` of each
// version given a `published` one.
export function stubRegistry(tarballs, urlOf = url) {
  const served = new Map(tarballs.map((t) => [urlOf(t.name, t.version), t.served ?? t.bytes]))
  const documentOf = (t) => ({ name: t.name, version: t.version, dist: { tarball: url(t.name, t.version), integrity: t.integrity, ...t.dist }, ...t.document })
  const documents = new Map(tarballs.map((t) => [`https://registry.npmjs.org/${t.name}/${t.version}`, documentOf(t)]))
  for (const [name, versions] of Map.groupBy(tarballs, (t) => t.name)) {
    const time = Object.fromEntries(versions.map((t) => [t.version, t.published]))
    documents.set(`https://registry.npmjs.org/${name}`, { name, versions: Object.fromEntries(versions.map((t) => [t.version, {}])), time })
  }
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

// What a version document says of where a package comes from, of one that
// says nothing, or is not fetched.
export const ABOUT = Object.freeze({ commit: undefined, repository: undefined, homepage: undefined, bugs: undefined })

// A cache store in memory, as upstream's CacheOptions take one: what is
// written is `kept` by `<type> <key>`.
export function memoryStore() {
  const kept = new Map()
  return {
    kept,
    read: (type, key) => Promise.resolve(kept.get(`${type} ${key}`)),
    write: (type, key, value) => {
      kept.set(`${type} ${key}`, value)
      return Promise.resolve()
    },
  }
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

// The stubbed fetch, each answer held until `at` fetches are coming at once,
// or a second has gone by, and `ms` more; counts them as slowed does. A limit
// of `at` reads as `at` however busy the machine, where a timer alone lets the
// first answer come before the last of them is asked for.
export function gathered(at, ms = 5) {
  const served = globalThis.fetch
  const count = { open: 0, most: 0 }
  const { promise: together, resolve } = Promise.withResolvers()
  const timer = setTimeout(resolve, 1000)
  globalThis.fetch = async (input) => {
    count.most = Math.max(count.most, ++count.open)
    if (count.open >= at) {
      clearTimeout(timer)
      resolve()
    }
    await together
    await new Promise((resolved) => {
      setTimeout(resolved, ms)
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

// A zip with every field as given, as one from Soldeer's registry or a
// GitHub release may have it, repeats and all; `size` is the size declared,
// whatever the data's, and `version` the one needed to extract, 2.0 unless
// given.
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
    const version = entry.version ?? 20
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(version, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((system << 8) | 30, 4); central.writeUInt16LE(version, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10)
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
const GITHUB_REPO_BY_ID = /^https:\/\/api\.github\.com\/(repositories\/(\d+))$/u
const GITHUB_UPLOAD_PACK = /^https:\/\/github\.com\/([^/]+\/[^/]+)\.git\/git-upload-pack$/u

// A commit of `tree` as git writes one, its id and its object's bytes: the
// commit a stubbed repo is at, whose tree getCommitTree reads off it.
export function commitOf(tree, message = 'acme\n') {
  const object = Buffer.from(`tree ${tree}\nauthor Acme <acme@example.com> 0 +0000\ncommitter Acme <acme@example.com> 0 +0000\n\n${message}`)
  return { id: createHash('sha1').update(`commit ${object.length}\0`).update(object).digest('hex'), object }
}

const pkt = (data) => Buffer.concat([Buffer.from((Buffer.byteLength(data) + 4).toString(16).padStart(4, '0')), Buffer.from(data)])

// A packfile of `objects`, each { type, data }, and github.com's answer to a
// protocol v2 fetch with it, as getCommitTree reads one.
export function packOf(objects) {
  const parts = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)]
  parts[2].writeUInt32BE(objects.length)
  for (const { type, data } of objects) {
    const header = []
    let byte = ({ commit: 1, tree: 2, blob: 3 }[type] << 4) | (data.length & 15)
    for (let size = Math.floor(data.length / 16); size > 0; size = Math.floor(size / 128)) {
      header.push(byte | 0x80)
      byte = size & 0x7f
    }
    parts.push(Buffer.from([...header, byte]), deflateSync(data))
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, createHash('sha1').update(body).digest()])
}
export const uploadPackAnswer = (packfile, sha) => Buffer.concat([pkt('shallow-info\n'), pkt(`shallow ${sha}\n`), Buffer.from('0001'), pkt('packfile\n'), pkt(Buffer.concat([Buffer.from([1]), packfile])), Buffer.from('0000')])

// Beside the fetch stubbed already, GitHub's API for `repos`, each by
// `owner/name`: { id, commit, tree, tarball, listings, tags, branches,
// history }, the listings each tree's entries by its id, the tags and the
// branches each one's commit by its name, `history` the commits the default
// branch, main, is ahead of; or { location } for one renamed or transferred,
// which GitHub redirects there, as it does to the repository by its `id`.
// And github.com's git-upload-pack for each, answering a fetch of `commit`
// with commitOf(tree)'s object, which `commit` has to be the id of.
// Returns what was asked of it, from the repo on.
export function stubGitHub(repos) {
  const served = globalThis.fetch
  const calls = []
  globalThis.fetch = (input, init) => {
    const asked = String(input)
    const notFound = () => Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    const git = GITHUB_UPLOAD_PACK.exec(asked)
    if (git !== null) {
      calls.push(`${git[1]}.git/git-upload-pack`)
      const repo = repos[git[1]]
      if (repo === undefined) return notFound()
      if (repo.location !== undefined) return Promise.resolve(new Response('', { status: 301, headers: { location: 'https://github.com/elsewhere.git/git-upload-pack' } }))
      const want = /want ([\da-f]{40})/u.exec(Buffer.from(init.body).toString())?.[1]
      const { id, object } = commitOf(repo.tree)
      if (want !== repo.commit || want !== id) return Promise.resolve(new Response(pkt(`ERR upload-pack: not our ref ${want}\n`)))
      return Promise.resolve(new Response(uploadPackAnswer(packOf([{ type: 'commit', data: object }]), want)))
    }
    const byId = GITHUB_REPO_BY_ID.exec(asked)
    if (byId !== null) {
      calls.push(byId[1])
      const found = Object.entries(repos).find(([, repo]) => repo.id === Number(byId[2]))
      return found === undefined ? notFound() : Promise.resolve(Response.json({ id: found[1].id, full_name: found[0] }))
    }
    if (!asked.startsWith(GITHUB_REPOS)) return served(input, init)
    const path = asked.slice(GITHUB_REPOS.length)
    calls.push(path)
    const [owner, name, ...rest] = path.split('/')
    const repo = repos[`${owner}/${name}`]
    const [kind, id] = [rest.slice(0, -1).join('/'), rest.at(-1)]
    if (repo === undefined) return notFound()
    if (repo.location !== undefined) return Promise.resolve(new Response('', { status: 301, headers: { location: repo.location } }))
    if (rest.length === 0) return Promise.resolve(Response.json({ id: repo.id, full_name: `${owner}/${name}`, default_branch: 'main' }))
    if (kind === 'compare') {
      const [base] = id.split('?')[0].split('...')
      const ahead = (repo.history ?? []).includes(base)
      return Promise.resolve(Response.json({ status: ahead ? 'ahead' : 'diverged', ahead_by: 1, behind_by: ahead ? 0 : 1, base_commit: { sha: base }, merge_base_commit: { sha: ahead ? base : 'f'.repeat(40) } }))
    }
    if (kind === 'git/ref/tags' && Object.hasOwn(repo.tags ?? {}, id)) return Promise.resolve(Response.json({ ref: `refs/tags/${id}`, object: { type: 'commit', sha: repo.tags[id] } }))
    if (kind === 'git/ref/heads' && Object.hasOwn(repo.branches ?? {}, id)) return Promise.resolve(Response.json({ ref: `refs/heads/${id}`, object: { type: 'commit', sha: repo.branches[id] } }))
    if (kind === 'git/commits' && id === repo.commit) return Promise.resolve(Response.json({ sha: repo.commit, tree: { sha: repo.tree } }))
    if (kind === 'tarball' && id === repo.tree) return Promise.resolve(new Response(repo.tarball))
    if (kind === 'git/trees' && Object.hasOwn(repo.listings, id)) return Promise.resolve(Response.json({ sha: id, tree: repo.listings[id], truncated: false }))
    return notFound()
  }
  return calls
}

// Where trunk's CDN serves a podspec, sharded as CocoaPods shards it.
export function podspecUrl(name, version) {
  const shard = [...createHash('md5').update(name).digest('hex').slice(0, 3)].join('/')
  return `https://cdn.cocoapods.org/Specs/${shard}/${encodeURIComponent(name)}/${version}/${encodeURIComponent(name)}.podspec.json`
}

// Beside the fetch stubbed already, trunk's CDN for `podspecs`, each a
// podspec's bytes by `<name>@<version>`, at the path CocoaPods shards it
// under. Returns what was asked of it.
export function stubTrunk(podspecs) {
  const served = globalThis.fetch
  const calls = []
  const byUrl = new Map(Object.entries(podspecs).map(([id, bytes]) => {
    const [name, version] = id.split('@')
    return [podspecUrl(name, version), bytes]
  }))
  globalThis.fetch = (input, init) => {
    const asked = String(input)
    if (!asked.startsWith('https://cdn.cocoapods.org/')) return served(input, init)
    calls.push(asked)
    return Promise.resolve(byUrl.has(asked) ? new Response(byUrl.get(asked)) : new Response('Not found', { status: 404 }))
  }
  return calls
}

// Beside the fetch stubbed already, GitHub's web host for `archives`, each
// an archive's bytes by its URL there, as GitHub serves a tag's archive
// once its redirect to codeload is followed. Returns what was asked of it.
export function stubArchives(archives) {
  const served = globalThis.fetch
  const calls = []
  globalThis.fetch = (input, init) => {
    const asked = String(input)
    if (!asked.startsWith('https://github.com/') || asked.endsWith('/git-upload-pack')) return served(input, init)
    calls.push(asked)
    return Promise.resolve(Object.hasOwn(archives, asked) ? new Response(archives[asked]) : new Response('Not Found', { status: 404 }))
  }
  return calls
}
