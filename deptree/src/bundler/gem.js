// A .gem as Gem::Package#verify reads it with no security policy: its
// members each once, held to checksums.yaml.gz; then its spec and data.

import { gunzip, unpackLimit } from '../archive.js'
import { DeptreeError, quote } from '../error.js'
import { hexDigest } from '../hash.js'
import { decodeUtf8 } from '../project.js'
import { readChecksums, readSpec } from './spec.js'
import { readTar } from './tar.js'

const MEMBERS = ['metadata.gz', 'data.tar.gz', 'checksums.yaml.gz']
const NAMES = new Set([...MEMBERS, ...MEMBERS.map((name) => `${name}.sig`)])

// Gem::Package#limit_read's bound on metadata.gz and checksums.yaml.gz.
const YAML_LIMIT = 10 * 1024 * 1024

// The digests Gem::Security.create_digest makes under the names
// checksums.yaml gives them, as RubyGems writes them.
const DIGESTS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' }

// Zlib::GzipReader's reading of a member of the .gem; what data.tar.gz may
// unpack to is a bound of ours, cargo's.
const gunzipped = (bytes, what, limit, where) => gunzip(bytes, { what, reader: 'Zlib', limit, where })
const yamlOf = async (bytes, what, where) => decodeUtf8(await gunzipped(bytes, what, YAML_LIMIT, where), `${what} is not UTF-8, which Psych refuses`, where)

// Gem::Specification.normalize_yaml_input, which from_yaml reads it after.
const normalized = (text) => (text.startsWith('--- ') ? text : `--- ${text}`).replaceAll(' !!null \n', ' \n').replace(/^(date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+?)Z/gmu, '$1 Z')

// Gem::Package#verify_checksums: each one listed, of a file of the .gem
// that is no .sig, as RubyGems digests no .sig; an algorithm RubyGems
// would fail to make a digest of refused.
async function verifyChecksums(files, checksums, where) {
  for (const [algorithm, listed] of checksums) {
    if (!Object.hasOwn(DIGESTS, algorithm)) throw new DeptreeError(`checksums.yaml.gz: ${quote(algorithm)} is no digest RubyGems writes`, where)
    for (const [name, hex] of listed) {
      const file = name.endsWith('.sig') ? undefined : files.get(name)
      if (file === undefined) throw new DeptreeError(`checksums.yaml.gz: ${quote(name)} is no file of the .gem that RubyGems digests`, where)
      if (await hexDigest(DIGESTS[algorithm], file) !== hex) throw new DeptreeError(`checksums.yaml.gz: the ${algorithm} of ${quote(name)} is not the one it has`, where)
    }
  }
}

// The .gem's spec, as readSpec reads it, and `entries`, which reads those
// of data.tar.gz.
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
    await verifyChecksums(files, readChecksums(await yamlOf(sums, 'checksums.yaml.gz', where), `${where}: checksums.yaml.gz`), where)
  }
  const spec = readSpec(normalized(await yamlOf(files.get('metadata.gz'), 'metadata.gz', where)), `${where}: metadata.gz`)
  const entries = async () => readTar(await gunzipped(files.get('data.tar.gz'), 'data.tar.gz', unpackLimit(bytes), where), 'data.tar.gz', `${where}: data.tar.gz`)
  return { spec, entries }
}
