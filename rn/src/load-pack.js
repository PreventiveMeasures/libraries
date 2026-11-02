// A target's pack: what its builds keep on disk (each file as it loads,
// each dev module's build: load-cache.js), in segments, each a file of
// records, read whole at once as a run's first build of the target asks
// for one, not a file of each entry: on a system each file's opening costs
// at (macOS), the run's 27k reads of an app of 13.8k files, one each, cost
// it 25 s. A segment: frames, each its length and its records' (4 bytes
// each, LE), then its records, zstd's (level 3, of a checksum: of one
// corrupt, none read), of CHUNK or so each, unpacked each of its own, at
// once, off the main thread: of an app's records, a fifth of their size,
// as fast to read and unpack as to read them unpacked, and of zlib's,
// zstd's are the smaller of the faster to write, of gzip's and brotli's.
// A record: its key (64 hex digits), its length (4 bytes, LE), its JSON,
// parsed as it is asked for.

import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'

const KEY = 64
const SEGMENT = '.pack'
// Segments read, of which a build's end writes them all as one.
const SEGMENTS = 8
const CHUNK = 8 * 1024 * 1024
// A frame's head: its length, and its records'.
const HEAD = 8
const PACKING = { chunkSize: 1024 * 1024, params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_checksumFlag]: 1 } }
const pack = promisify(zstdCompress)
const unpack = promisify(zstdDecompress)
let segments = 0

// Of work that runs on, at most so long before the event loop has its
// turn: a build's progress, which a client is told of as it goes, and its
// sockets', wait for it; a file the cache has, which takes no I/O but
// reading, never gives it one.
const TURN = 20
let turned = performance.now()
export const pause = () => {
  if (performance.now() - turned < TURN) return null
  return new Promise((done) => {
    setImmediate(() => {
      turned = performance.now()
      done()
    })
  })
}

// A pack's directory, or a run's entries', stamped as a run uses it (its
// mtime now), as load-prune.js has it: what no run uses, a run after removes.
export function touch(dir) {
  try {
    const now = new Date()
    utimesSync(dir, now, now)
  } catch {
    // None there yet: what is written makes it, of its mtime then.
  }
}

// Each record of `records` (a frame's, unpacked) in `index`, by its key.
function indexed(index, records) {
  for (let at = 0; at + KEY + 4 <= records.length; ) {
    const start = at + KEY + 4
    const end = start + records.readUInt32LE(at + KEY)
    if (end > records.length) break
    index.set(records.toString('latin1', at, at + KEY), records.subarray(start, end))
    at = end
  }
}

// -> { index: Map<key, its value's JSON>, read: the segments' names, bytes,
// unpacked }: the segments of `dir`, each read whole, its frames unpacked
// each of its own, at once; of one cut short, the frames whole; of one
// that fails to unpack (corrupt), none.
async function segmentsOf(dir) {
  const index = new Map()
  const read = []
  let bytes = 0
  let unpacked = 0
  const names = await readdir(dir).then((all) => all.filter((name) => name.endsWith(SEGMENT)), () => [])
  const each = async (name) => {
    const buffer = await readFile(join(dir, name)).catch(() => null)
    if (buffer === null) return
    read.push(name)
    bytes += buffer.length
    const frames = []
    for (let at = 0; at + HEAD <= buffer.length; ) {
      const end = at + HEAD + buffer.readUInt32LE(at)
      if (end > buffer.length) break
      // Unpacked in one chunk of its size, which zlib's 16 KB would take a round of the thread pool each.
      frames.push(unpack(buffer.subarray(at + HEAD, end), { chunkSize: Math.min(Math.max(buffer.readUInt32LE(at + 4), 64), 8 * CHUNK) }).catch(() => null))
      at = end
    }
    for (const records of await Promise.all(frames)) {
      if (records === null) continue
      unpacked += records.length
      indexed(index, records)
    }
  }
  await Promise.all(names.map(each))
  return { index, read, bytes, unpacked }
}

// A segment of `records` ([key, JSON]) written in `dir`, its frames packed
// off the main thread, whole, then moved in place; those of `gone` then
// removed.
async function writeSegment(dir, records, gone) {
  const name = `${Date.now().toString(36)}-${process.pid}-${segments++}${SEGMENT}`
  // Written in chunks of CHUNK bytes or so, not a write of each record's
  // key and value, each a syscall.
  const chunks = []
  let parts = []
  let size = 0
  for (const [key, value] of records) {
    const head = Buffer.alloc(KEY + 4)
    head.write(key, 'latin1')
    head.writeUInt32LE(value.length, KEY)
    parts.push(head, value)
    size += head.length + value.length
    if (size >= CHUNK) {
      chunks.push(Buffer.concat(parts, size))
      parts = []
      size = 0
    }
  }
  if (parts.length > 0) chunks.push(Buffer.concat(parts, size))
  const framed = async (chunk) => {
    const frame = await pack(chunk, PACKING)
    const head = Buffer.alloc(HEAD)
    head.writeUInt32LE(frame.length, 0)
    head.writeUInt32LE(chunk.length, 4)
    return [head, frame]
  }
  try {
    const frames = await Promise.all(chunks.map(framed))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.tmp`), frames.flat())
    await rename(join(dir, `${name}.tmp`), join(dir, name))
    await Promise.all(gone.map((each) => rm(join(dir, each), { force: true })))
  } catch {
    await rm(join(dir, `${name}.tmp`), { force: true }).catch(() => {})
  }
}

// -> { load(), get(key) (its value, or null), set(key, value), start(), finish() }:
// the pack in `dir`. A run reads it at its first load() (a promise of {
// bytes, unpacked, segments } of what it read; else of null), which its
// get() waits for (of none read, null), and keeps what it
// read while a build that started before is under way: at the end of the
// last (finish()), the entries set since are written, a segment of their
// own, then; with as many segments read as SEGMENTS, all of those the
// builds asked for with them, as one, the segments read gone (and with
// them, those asked for none: of a file's source before it was edited, or
// of another bundle's). What it read
// is then let go, as each file is in memory: of a build after, get() has
// none. A cache, at best: what fails to read or write is loaded anew.
export function createPack(dir) {
  let index = null
  let read = []
  let loading = null
  let done = false
  let building = 0
  const asked = new Set()
  const fresh = []
  const load = async () => {
    if (done) return null
    touch(dir)
    const made = await segmentsOf(dir)
    // Its builds done as it read: none kept.
    if (done) return null
    ;({ index, read } = made)
    return { bytes: made.bytes, unpacked: made.unpacked, segments: read.length }
  }
  return {
    load: () => (loading ??= load()),
    get: (key) => {
      const value = index?.get(key)
      if (value === undefined) return null
      asked.add(key)
      try {
        return JSON.parse(value.toString('utf8'))
      } catch {
        return null
      }
    },
    set: (key, value) => {
      fresh.push([key, Buffer.from(JSON.stringify(value))])
    },
    start: () => {
      building++
    },
    finish: () => {
      if (--building > 0) return Promise.resolve()
      touch(dir)
      let records = fresh.splice(0)
      let gone = []
      if (index !== null && read.length >= SEGMENTS) {
        // Concatenated, not spread: of an app's records, more than a call takes.
        records = [...asked].filter((key) => index.has(key)).map((key) => [key, index.get(key)]).concat(records)
        gone = read
      }
      // Let go: each file is in memory now.
      index = null
      read = []
      done = true
      asked.clear()
      return records.length === 0 && gone.length === 0 ? Promise.resolve() : writeSegment(dir, records, gone)
    },
  }
}

// What is kept in `dir` by a key: JSON, or null where none.
const entryPath = (dir, key) => join(dir, key.slice(0, 2), key.slice(2))
export function readEntry(dir, key) {
  try {
    return JSON.parse(readFileSync(entryPath(dir, key), 'utf8'))
  } catch {
    return null
  }
}

// Written whole, then moved in place: another rn-serve may read it.
export function writeEntry(dir, key, value) {
  const path = entryPath(dir, key)
  const written = `${path}.${process.pid}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(written, JSON.stringify(value))
    renameSync(written, path)
  } catch {
    // Nor what is left of it, where it can't be: the file is loaded still.
    try {
      rmSync(written, { force: true })
    } catch {}
  }
}
