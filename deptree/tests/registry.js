import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

// upstream looks in npm's cache and the home directory before the
// registry: both are pointed at a directory that is never made, so no
// tarball on this machine answers for the stubs, and nothing is written.
const NOWHERE = join(tmpdir(), `deptree-test-${process.pid}-nowhere`)
process.env.HOME = NOWHERE
process.env.npm_config_cache = NOWHERE
delete process.env.NPM_CONFIG_CACHE

const encoder = new TextEncoder()

export const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
export const url = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`

// A package's tarball as npm packs one, everything under `package/`:
// `files` maps a path to text, or to `{ data, mode }`, and package.json is
// written for the name and version, and the fields of `manifest`, unless
// given.
export async function tarball(name, version, files = {}, { top = 'package', manifest = {} } = {}) {
  const all = { 'package.json': JSON.stringify({ name, version, ...manifest }), ...files }
  const entries = Object.entries(all).filter(([, file]) => file !== undefined).map(([path, file]) => {
    const { data, mode } = typeof file === 'string' ? { data: file } : file
    return { name: `${top}/${path}`, data: typeof data === 'string' ? encoder.encode(data) : data, mode: mode ?? 0o644 }
  })
  const bytes = await compress(pack(entries), 'gzip')
  return { name, version, bytes, integrity: sri(bytes) }
}

// The registry, serving each tarball given at its own URL; `calls` is
// every URL asked for.
export function stubRegistry(tarballs) {
  const served = new Map(tarballs.map((t) => [url(t.name, t.version), t.served ?? t.bytes]))
  const calls = []
  globalThis.fetch = (input) => {
    calls.push(String(input))
    const bytes = served.get(String(input))
    return Promise.resolve(bytes === undefined ? Response.json({ error: 'Not found' }, { status: 404 }) : new Response(bytes))
  }
  return calls
}

export const HOST = Object.freeze({ pnpm: '10.33.4', node: '24.15.0', os: 'linux', cpu: 'x64', libc: 'glibc' })

// A zip with every field as given, as a zip of Soldeer's registry may have
// it: entries of { name, data, system (3, Unix, by default), flags, mode
// (a Unix mode, put in the upper half of the attributes) or attributes
// (raw), extra }, each stored, in order, repeats and all.
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
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((system << 8) | 30, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(attributes >>> 0, 38); central.writeUInt32LE(offset, 42)
    const whole = Buffer.concat([local, name, extra, data])
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

// Soldeer's registry, serving each zip, { name, version, bytes }, where
// its revision says; `calls` is every URL asked for.
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
