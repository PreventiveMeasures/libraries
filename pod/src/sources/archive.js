// An :http archive as RemoteFile leaves it: downloaded and held to its sha256, extracted as `tar xf` or `unzip -d`
// extract it under a umask of 0o022, then flattened where that is asked and it holds one directory.

import { createHash } from 'node:crypto'

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { unzip } from '@preventive/archive/zip.js'

import { PodError, quote } from '../error.js'

// The most an archive may be, and unpack to.
const MAX_BYTES = 512 * 1024 * 1024
const TIMEOUT = 300_000
const UMASK = 0o022
// The zip makers whose Unix mode unzip takes as it is stored.
const UNIX_HOSTS = new Set([2, 3, 5, 12, 13, 16, 17, 30])

// A `.git`, as git's checkout names one: dots and spaces after it dropped, in any case.
const isGit = (name) => name.replace(/[. ]+$/u, '').toLowerCase() === '.git'
const gitRefusal = (at) => new PodError('a .git, which CocoaPods 1.16 drops and others keep', at)
// The names at the archive's root.
const topsOf = ({ dirs, files, links }) => new Set([...dirs, ...files.keys(), ...links.keys()].map((path) => path.split('/')[0]))

// The archive at `url`, held to `sha256`: whoever answers a redirect, the bytes are what is checked.
export async function downloadArchive(url, sha256, where) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) })
  if (!response.ok) throw new PodError(`${quote(url)} answers ${response.status}`, where)
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BYTES) throw new PodError(`${quote(url)} is over ${MAX_BYTES} bytes`, where)
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== sha256) throw new PodError(`${quote(url)} has sha256 ${actual}, not ${sha256}`, where)
  return bytes
}

// Each entry as tar writes it out, a hard link a copy of what it links to, as CocoaPods' copies make it. A name
// starting with `._`, which bsdtar on macOS reads as another's extended attributes, is refused, as is a `.git`.
function untarred(entries, where) {
  const dirs = new Set()
  const files = new Map()
  const links = new Map()
  for (const entry of entries) {
    const { name, type } = entry
    if (name === '.' || dirs.has(name) || files.has(name) || links.has(name)) continue
    const at = `${where}: ${quote(name)}`
    const segments = name.split('/')
    if (segments.some(isGit)) throw gitRefusal(at)
    if (segments.some((segment) => segment.startsWith('._'))) throw new PodError('a `._` name, which bsdtar on macOS takes as metadata', at)
    if (type === 'directory') dirs.add(name)
    else if (type === 'file' || type === 'contiguous-file') files.set(name, { data: entry.data, mode: entry.mode & 0o777 & ~UMASK })
    else if (type === 'symlink') links.set(name, entry.linkname)
    else if (type === 'hardlink' && files.has(entry.linkname)) files.set(name, { ...files.get(entry.linkname) })
    else if (type === 'hardlink' && links.has(entry.linkname)) links.set(name, links.get(entry.linkname))
    else throw new PodError(`a ${type} entry`, at)
  }
  return { dirs, files, links }
}

// A file's mode as unzip's mapattr() makes one: a Unix maker's as stored; any other's 0o644, or 0o444 where marked
// read-only, unless the Unix mode stored with it agrees with that.
function zipMode({ system, attributes }) {
  const unix = attributes >>> 16
  if (UNIX_HOSTS.has(system)) return unix & 0o777
  const writable = (attributes & 1) === 0
  return system === 0 && (unix & 0o700) === (writable ? 0o600 : 0o400) ? unix & 0o777 : writable ? 0o644 : 0o444
}

// Each entry as unzip writes it out. An empty archive, which unzip warns of, and a name twice, which it asks about,
// fail CocoaPods and are refused.
function unzipped(entries, where) {
  if (entries.length === 0) throw new PodError('an empty zip, which CocoaPods fails on', where)
  const dirs = new Set()
  const files = new Map()
  const links = new Map()
  for (const entry of entries) {
    const { name, type } = entry
    if (name === '.') continue
    const at = `${where}: ${quote(entry.storedName)}`
    if (name.split('/').some(isGit)) throw gitRefusal(at)
    if (files.has(name) || links.has(name)) throw new PodError('a name twice, which unzip prompts on', at)
    if (type === 'directory') dirs.add(name)
    else if (type === 'symlink') links.set(name, entry.linkname)
    else files.set(name, { data: entry.data, mode: zipMode(entry) })
  }
  return { dirs, files, links }
}

// RemoteFile#extract_with_type's flattening: one directory beside the download has its contents moved up, by way
// of its name and `.tmp`. A link there, a name ending in `.`, or one the moves would meet is refused.
function flattened(contents, where) {
  const tops = topsOf(contents)
  if (tops.size !== 1) return contents
  const [top] = tops
  if (contents.files.has(top)) return contents
  const at = `${where}: ${quote(top)}`
  if (contents.links.has(top)) throw new PodError('a link to flatten', at)
  if (top.endsWith('.')) throw new PodError('a name ending in `.` to flatten', at)
  const strip = (path) => path.slice(top.length + 1)
  const inside = (path) => path.startsWith(`${top}/`)
  const stripped = (map) => new Map([...map].map(([path, value]) => [strip(path), value]))
  const moved = { dirs: new Set([...contents.dirs].filter(inside).map(strip)), files: stripped(contents.files), links: stripped(contents.links) }
  if (topsOf(moved).has(`${top}.tmp`)) throw new PodError(`holds ${quote(`${top}.tmp`)}, which flattening uses`, at)
  return moved
}

// `source` is sourceOf's: the archive's type, the name it is downloaded under, and whether it is flattened.
export async function archiveOf(bytes, source, where) {
  let contents
  try {
    if (source.archive === 'zip') contents = unzipped(await unzip(bytes, { limit: MAX_BYTES }), where)
    else contents = untarred(unpack(bytes[0] === 0x1f && bytes[1] === 0x8b ? await decompress(bytes, 'gzip', { limit: MAX_BYTES }) : bytes, { trailingGlobal: true }), where)
  } catch (error) {
    if (error instanceof ArchiveError) throw new PodError(`unreadable archive: ${error.message}`, where, { cause: error })
    throw error
  }
  if (topsOf(contents).has(source.file)) throw new PodError(`the archive holds ${quote(source.file)}, its own download's name`, where)
  return source.flatten ? flattened(contents, where) : contents
}
