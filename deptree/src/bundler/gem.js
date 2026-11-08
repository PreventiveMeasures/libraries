// A .gem as Gem::Package#verify reads it with no security policy: its
// members each once, held to checksums.yaml.gz; then its spec and data.

import { crc32 } from '@exodus/bytes/crc.js'
import { toHex } from '@exodus/bytes/hex.js'
import { utf8toString } from '@exodus/bytes/utf8.js'
import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { DeptreeError, quote } from '../error.js'
import { readChecksums, readSpec } from './spec.js'
import { readTar } from './tar.js'

const MEMBERS = ['metadata.gz', 'data.tar.gz', 'checksums.yaml.gz']
const NAMES = new Set([...MEMBERS, ...MEMBERS.map((name) => `${name}.sig`)])

// Gem::Package#limit_read's bound on metadata.gz and checksums.yaml.gz.
const YAML_LIMIT = 10 * 1024 * 1024

// What data.tar.gz may unpack to, a bound of ours: 512 MiB, or twenty
// times the .gem where that is more.
const dataLimit = (gem) => Math.max(512 * 1024 * 1024, gem.length * 20)

// The digests Gem::Security.create_digest makes under the names
// checksums.yaml gives them, as RubyGems writes them.
const DIGESTS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' }

const [FTEXT, FEXTRA, FNAME, FCOMMENT] = [0x01, 0x04, 0x08, 0x10]

// Zlib::GzipReader reads one member and passes over what follows, so the
// one has to be all of it; it refuses flag 0x02 and the reserved ones, and
// checks the trailer's CRC-32 and length.
async function gunzip(bytes, limit, what, where) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError(`${what} is not gzipped`, where)
  const flags = bytes[3]
  if (flags & ~(FTEXT | FEXTRA | FNAME | FCOMMENT)) throw new DeptreeError(`${what} has a gzip flag Zlib refuses`, where)
  let at = 10
  if (flags & FEXTRA) at += 2 + (bytes[at] | (bytes[at + 1] << 8))
  for (const flag of [FNAME, FCOMMENT]) {
    if (!(flags & flag)) continue
    const end = bytes.indexOf(0, at)
    at = end === -1 ? bytes.length : end + 1
  }
  if (at > bytes.length - 8) throw new DeptreeError(`${what}'s gzip header runs past its end`, where)
  let data
  try {
    data = await decompress(bytes.subarray(at, bytes.length - 8), 'deflate-raw', { limit })
  } catch (error) {
    if (!(error instanceof CompressionError)) throw error
    throw new DeptreeError(error.limited ? `${what} unpacks to more than ${limit} bytes` : `${what} is not one gzip member, of which Zlib reads the first alone`, where, { cause: error })
  }
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8)
  if (trailer.getUint32(0, true) !== crc32(data) || trailer.getUint32(4, true) !== data.length >>> 0) throw new DeptreeError(`${what}'s gzip trailer does not match its data`, where)
  return data
}

function utf8(bytes, what, where) {
  try {
    return utf8toString(bytes)
  } catch {
    throw new DeptreeError(`${what} is not UTF-8, which Psych refuses`, where)
  }
}

// Gem::Specification.normalize_yaml_input, which from_yaml reads it after.
const normalized = (text) => (text.startsWith('--- ') ? text : `--- ${text}`).replaceAll(' !!null \n', ' \n').replace(/^(date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+?)Z/gmu, '$1 Z')

const digest = async (algorithm, bytes) => toHex(new Uint8Array(await crypto.subtle.digest(algorithm, bytes)))

// Gem::Package#verify_checksums: each one listed, of a file of the .gem
// that is no .sig, as RubyGems digests no .sig; an algorithm RubyGems
// would fail to make a digest of refused.
async function verifyChecksums(files, checksums, where) {
  for (const [algorithm, listed] of checksums) {
    if (!Object.hasOwn(DIGESTS, algorithm)) throw new DeptreeError(`checksums.yaml.gz: ${quote(algorithm)} is no digest RubyGems writes`, where)
    for (const [name, hex] of listed) {
      const file = name.endsWith('.sig') ? undefined : files.get(name)
      if (file === undefined) throw new DeptreeError(`checksums.yaml.gz: ${quote(name)} is no file of the .gem that RubyGems digests`, where)
      if (await digest(DIGESTS[algorithm], file) !== hex) throw new DeptreeError(`checksums.yaml.gz: the ${algorithm} of ${quote(name)} is not the one it has`, where)
    }
  }
}

// The .gem's spec, as readSpec reads it, and the entries of data.tar.gz.
export async function readGem(bytes, where) {
  const files = new Map()
  for (const entry of readTar(bytes, 'the .gem', where)) {
    const here = `${where}: ${quote(entry.name)}`
    if (!NAMES.has(entry.name)) throw new DeptreeError('a file of a .gem RubyGems does not write', here)
    if (entry.type !== 'file') throw new DeptreeError(`a ${entry.type}, where RubyGems writes a file`, here)
    if (files.has(entry.name)) throw new DeptreeError('twice in the .gem, which RubyGems refuses', here)
    files.set(entry.name, entry.data)
  }
  for (const name of ['metadata.gz', 'data.tar.gz']) if (!files.has(name)) throw new DeptreeError(`the .gem has no ${name}, which RubyGems refuses`, where)
  const sums = files.get('checksums.yaml.gz')
  if (sums !== undefined) {
    const text = utf8(await gunzip(sums, YAML_LIMIT, 'checksums.yaml.gz', where), 'checksums.yaml.gz', where)
    await verifyChecksums(files, readChecksums(text, `${where}: checksums.yaml.gz`), where)
  }
  const metadata = utf8(await gunzip(files.get('metadata.gz'), YAML_LIMIT, 'metadata.gz', where), 'metadata.gz', where)
  const spec = readSpec(normalized(metadata), `${where}: metadata.gz`)
  const data = await gunzip(files.get('data.tar.gz'), dataLimit(bytes), 'data.tar.gz', where)
  return { spec, entries: readTar(data, 'data.tar.gz', `${where}: data.tar.gz`) }
}
