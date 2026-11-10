// rn-serve's cache on disk (load-cache.js's): a pack per target of its loads and module builds, in a few
// segment files read whole, since a file per entry cost 25 s on macOS for an app's 27k reads; and loose
// entries, a JSON file each. A segment is zstd frames of records: a 64-hex key, a u32 LE length, JSON.

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'

const KEY = 64
const RECORD_HEAD = KEY + 4
const SEGMENT = '.pack'
// Once a run has read this many segments, its last build rewrites them as one.
const SEGMENTS = 8
// About this many bytes of records per frame; frames unpack in parallel, off the main thread. Each is
// headed by its packed and unpacked u32 LE lengths.
const CHUNK = 8 * 1024 * 1024
const HEAD = 8
// zstd level 3: a fifth of the records' size, as fast to read as raw, and smaller than gzip or
// brotli at a fast write. The checksum drops a corrupt frame whole.
const PACKING = { chunkSize: 1024 * 1024, params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_checksumFlag]: 1 } }
const pack = promisify(zstdCompress)
const unpack = promisify(zstdDecompress)

// Yield to the event loop after this many ms of work, so build progress and sockets get a turn:
// reading cached files does no I/O that would yield on its own.
const TURN = 20
let turned = performance.now()
const turn = async () => {
  await nextTurn()
  turned = performance.now()
}
export const pause = () => (performance.now() - turned < TURN ? null : turn())

// Stamps a pack's or entries' directory as used now: load-prune.js removes what no run uses.
export function touch(dir) {
  try {
    const now = new Date()
    utimesSync(dir, now, now)
  } catch {
    // Not there yet: the first write creates it.
  }
}

// Reads every segment in `dir` whole, unpacking its frames in parallel: the index of each record by its
// key, and the names read. A truncated segment keeps its whole frames; a corrupt frame is skipped.
async function readSegments(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(SEGMENT))
  const index = new Map()
  const read = []
  const indexed = (records) => {
    for (let at = 0; at + RECORD_HEAD <= records.length; ) {
      const end = at + RECORD_HEAD + records.readUInt32LE(at + KEY)
      if (end > records.length) break
      index.set(records.toString('latin1', at, at + KEY), records.subarray(at, end))
      at = end
    }
  }
  const each = async (name) => {
    const buffer = await readFile(join(dir, name)).catch(() => null)
    if (buffer === null) return
    read.push(name)
    const frames = []
    for (let at = 0; at + HEAD <= buffer.length; ) {
      const end = at + HEAD + buffer.readUInt32LE(at)
      if (end > buffer.length) break
      // Unpacked into one chunk of its size: zlib's default 16 KB chunks each cost a thread-pool round trip.
      const chunkSize = Math.min(Math.max(buffer.readUInt32LE(at + 4), 64), 8 * CHUNK)
      frames.push(unpack(buffer.subarray(at + HEAD, end), { chunkSize }).then(indexed, () => {}))
      at = end
    }
    await Promise.all(frames)
  }
  await Promise.all(names.map(each))
  return { index, read }
}

// Writes `records` as a new segment in `dir`, aside and then renamed into place, so that a run reading the
// pack meanwhile sees all of it or none; then removes the segments `gone`.
async function writeSegment(dir, records, gone) {
  const chunks = []
  let size = CHUNK
  for (const record of records) {
    if (size >= CHUNK) {
      chunks.push([])
      size = 0
    }
    chunks.at(-1).push(record)
    size += record.length
  }
  const frames = await Promise.all(
    chunks.map(async (chunk) => {
      const joined = Buffer.concat(chunk)
      const frame = await pack(joined, PACKING)
      const head = Buffer.alloc(HEAD)
      head.writeUInt32LE(frame.length, 0)
      head.writeUInt32LE(joined.length, 4)
      return [head, frame]
    }),
  )
  const path = join(dir, `${randomUUID()}${SEGMENT}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(`${path}.tmp`, frames.flat())
    await rename(`${path}.tmp`, path)
  } finally {
    await rm(`${path}.tmp`, { force: true })
  }
  await Promise.all(gone.map((name) => rm(join(dir, name), { force: true })))
}

// The pack in `dir`. load() reads it whole once; the last build's finish() writes the records set
// since as a new segment, compacting the records builds asked for into it once SEGMENTS were read,
// then lets go of what it read, since each file is in memory by then. A failed write only costs hits.
export function createPack(dir) {
  let index = new Map()
  let read = []
  let loading = null
  let done = false
  let building = 0
  const asked = new Set()
  const fresh = []
  const load = async () => {
    touch(dir)
    const found = await readSegments(dir)
    // None if its builds finished meanwhile.
    if (!done) ({ index, read } = found)
  }
  return {
    load: () => (loading ??= load()),
    get: (key) => {
      const record = index.get(key)
      if (record === undefined) return null
      asked.add(record)
      return JSON.parse(record.toString('utf8', RECORD_HEAD))
    },
    set: (key, value) => {
      const json = Buffer.from(JSON.stringify(value))
      const head = Buffer.alloc(RECORD_HEAD)
      head.write(key, 'latin1')
      head.writeUInt32LE(json.length, KEY)
      fresh.push(Buffer.concat([head, json]))
    },
    start: () => {
      building++
    },
    finish: async () => {
      if (--building > 0) return
      touch(dir)
      const compacting = read.length >= SEGMENTS
      const records = [...(compacting ? asked : []), ...fresh.splice(0)]
      const gone = compacting ? read : []
      index = new Map()
      read = []
      done = true
      asked.clear()
      if (records.length > 0 || gone.length > 0) await writeSegment(dir, records, gone)
    },
  }
}

// A loose entry: a JSON file named by its key.
export function readEntry(dir, key) {
  try {
    return JSON.parse(readFileSync(join(dir, key), 'utf8'))
  } catch {
    return null
  }
}

// Written aside and renamed into place, since another rn-serve may be reading it.
export function writeEntry(dir, key, value) {
  const written = join(dir, `${key}.${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(written, JSON.stringify(value))
    renameSync(written, join(dir, key))
  } catch {
    void rm(written, { force: true }).catch(() => {})
  }
}
