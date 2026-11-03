// A target's pack: its cached loads and module builds (load-cache.js) in a few segment files read
// whole, since a file per entry cost 25 s on macOS for an app's 27k reads. A segment is zstd frames,
// each headed by its packed and unpacked u32 LE lengths, of records: 64-hex key, u32 LE length, JSON.

import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'

const KEY = 64
const SEGMENT = '.pack'
// Once a run has read this many segments, its last build rewrites them as one.
const SEGMENTS = 8
// About this many bytes of records per frame; frames unpack in parallel, off the main thread.
const CHUNK = 8 * 1024 * 1024
const HEAD = 8
// zstd level 3: a fifth of the records' size, as fast to read as raw, and smaller than gzip or
// brotli at a fast write. The checksum drops a corrupt frame whole.
const PACKING = { chunkSize: 1024 * 1024, params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_checksumFlag]: 1 } }
const pack = promisify(zstdCompress)
const unpack = promisify(zstdDecompress)
let segments = 0

// Yield to the event loop after this many ms of work, so build progress and sockets get a turn:
// reading cached files does no I/O that would yield on its own.
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

// Stamps a pack's or entries' directory as used now: load-prune.js removes what no run uses.
export function touch(dir) {
  try {
    const now = new Date()
    utimesSync(dir, now, now)
  } catch {
    // Not there yet: the first write creates it.
  }
}

function indexRecords(index, records) {
  for (let at = 0; at + KEY + 4 <= records.length; ) {
    const start = at + KEY + 4
    const end = start + records.readUInt32LE(at + KEY)
    if (end > records.length) break
    index.set(records.toString('latin1', at, at + KEY), records.subarray(start, end))
    at = end
  }
}

// Reads every segment in `dir` whole, unpacking its frames in parallel. A truncated segment keeps
// its whole frames; a frame that fails to unpack (corrupt) is skipped.
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
      // Unpacked into one chunk of its size: zlib's default 16 KB chunks each cost a thread-pool round trip.
      frames.push(unpack(buffer.subarray(at + HEAD, end), { chunkSize: Math.min(Math.max(buffer.readUInt32LE(at + 4), 64), 8 * CHUNK) }).catch(() => null))
      at = end
    }
    for (const records of await Promise.all(frames)) {
      if (records === null) continue
      unpacked += records.length
      indexRecords(index, records)
    }
  }
  await Promise.all(names.map(each))
  return { index, read, bytes, unpacked }
}

// Writes `records` ([key, JSON buffer]) as a new segment in `dir`, then removes the segments `gone`.
async function writeSegment(dir, records, gone) {
  const name = `${Date.now().toString(36)}-${process.pid}-${segments++}${SEGMENT}`
  const temporary = join(dir, `${name}.tmp`)
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
    await writeFile(temporary, frames.flat())
    await rename(temporary, join(dir, name))
    await Promise.all(gone.map((each) => rm(join(dir, each), { force: true })))
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

// The pack in `dir`. load() reads it whole once; the last build's finish() writes the records set
// since as a new segment, compacting the records builds asked for into it once SEGMENTS were read,
// then lets go of what it read, since each file is in memory by then. Failures only cost cache hits.
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
    const { bytes, unpacked, ...found } = await segmentsOf(dir)
    // Its builds finished while reading.
    if (done) return null
    ;({ index, read } = found)
    return { bytes, unpacked, segments: read.length }
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
        // concat(), not push(...): an app's records exceed the arguments a call takes.
        records = [...asked].map((key) => [key, index.get(key)]).concat(records)
        gone = read
      }
      index = null
      read = []
      done = true
      asked.clear()
      return records.length === 0 && gone.length === 0 ? Promise.resolve() : writeSegment(dir, records, gone)
    },
  }
}

// Loose entries: one JSON file per key.
const entryPath = (dir, key) => join(dir, key.slice(0, 2), key.slice(2))
export function readEntry(dir, key) {
  try {
    return JSON.parse(readFileSync(entryPath(dir, key), 'utf8'))
  } catch {
    return null
  }
}

// Written aside and renamed into place, since another rn-serve may be reading it.
export function writeEntry(dir, key, value) {
  const path = entryPath(dir, key)
  const written = `${path}.${process.pid}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(written, JSON.stringify(value))
    renameSync(written, path)
  } catch {
    try {
      rmSync(written, { force: true })
    } catch {}
  }
}
