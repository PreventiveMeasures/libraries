// A target's pack: what its builds keep on disk (each file as it loads,
// each dev module's build: load-cache.js), in segments, each a file of
// records, read whole at once as a run's first build of the target asks
// for one, not a file of each entry: on a system each file's opening costs
// at (macOS), the run's 27k reads of an app of 13.8k files, one each, cost
// it 25 s. A record: its key (64 hex digits), its length (4 bytes, LE),
// its JSON, parsed as it is asked for.

import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const KEY = 64
const SEGMENT = '.pack'
// Segments read, of which a build's end writes them all as one.
const SEGMENTS = 8
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

// -> { index: Map<key, its value's JSON>, read: the segments' names }: the
// segments of `dir`, each read whole; of one cut short, what is whole.
function segmentsOf(dir) {
  const index = new Map()
  const read = []
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(SEGMENT))
  } catch {
    // None yet.
  }
  for (const name of names) {
    let buffer
    try {
      buffer = readFileSync(join(dir, name))
    } catch {
      continue
    }
    read.push(name)
    for (let at = 0; at + KEY + 4 <= buffer.length; ) {
      const start = at + KEY + 4
      const end = start + buffer.readUInt32LE(at + KEY)
      if (end > buffer.length) break
      index.set(buffer.toString('latin1', at, at + KEY), buffer.subarray(start, end))
      at = end
    }
  }
  return { index, read }
}

// A segment of `records` ([key, JSON]) written in `dir`, whole, then moved
// in place; those of `gone` then removed.
async function writeSegment(dir, records, gone) {
  const name = `${Date.now().toString(36)}-${process.pid}-${segments++}${SEGMENT}`
  const chunks = records.flatMap(([key, value]) => {
    const head = Buffer.alloc(KEY + 4)
    head.write(key, 'latin1')
    head.writeUInt32LE(value.length, KEY)
    return [head, value]
  })
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.tmp`), chunks)
    await rename(join(dir, `${name}.tmp`), join(dir, name))
    await Promise.all(gone.map((each) => rm(join(dir, each), { force: true })))
  } catch {
    await rm(join(dir, `${name}.tmp`), { force: true }).catch(() => {})
  }
}

// -> { get(key) (its value, or null), set(key, value), start(), finish() }:
// the pack in `dir`. A run reads it at its first get(), and keeps what it
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
  let done = false
  let building = 0
  const asked = new Set()
  const fresh = []
  const load = () => {
    if (index !== null || done) return
    ;({ index, read } = segmentsOf(dir))
  }
  return {
    get: (key) => {
      load()
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
      const records = fresh.splice(0)
      let gone = []
      if (index !== null) {
        const kept = [...asked].filter((key) => index.has(key))
        if (read.length >= SEGMENTS) {
          records.unshift(...kept.map((key) => [key, index.get(key)]))
          gone = read
        }
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
