import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
