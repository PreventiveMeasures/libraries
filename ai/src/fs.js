import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Every filesystem operation the cache makes, as the operations the cache actually needs rather than
// as raw syscalls: read-or-absent, write-atomically, move-if-there-is-something-to-move. cache.js
// and cache-scan.js go through this and import no node: module of their own, which puts the two
// things that are easy to get subtly wrong — which errno means "absent" and which means "try again",
// and the tmp-then-rename dance — in one place instead of at every call site.

// `join` rides along because path-building is part of addressing a file, and one import for "the
// filesystem" beats two where the second is a string helper.
export { join }

// Absence is the one failure with a return value rather than a throw: a cache asks for files that
// are usually not there, and a missing entry is the normal answer, not an error to handle.
const isMissing = (err) => err.code === 'ENOENT'

// Errors that come from pressure, not absence — parallel lookups can hit fd exhaustion or a
// busy/slow volume, and at concurrency 1 the same read would simply have succeeded a moment later.
// Worth a few retries before giving up.
const TRANSIENT_READ_ERRORS = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'ETIMEDOUT'])

// Over node:timers/promises, which is the same wait behind an import a page has no answer for. The
// braces keep the Timeout out of the resolution value — same shape as the delay in fetch-json.js.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

export async function readText(path) {
  return await readFile(path, 'utf8')
}

// The text at `path`, or null if there is nothing usable there. Only two outcomes are folded into
// that null — the file is missing, or it is empty — and nothing else: a caller degrading an
// unreadable file to "absent" has a decision to announce, and swallowing the errno here would take
// the words out of its mouth. Transient failures are retried first, so a fd shortage under fan-out
// does not reach the caller as a decision at all.
export async function readTextOrNull(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      // We don't expect and don't load empty files, those can be failed writes or failed responses
      return await readText(path) || null
    } catch (err) {
      if (isMissing(err)) return null
      if (TRANSIENT_READ_ERRORS.has(err.code) && attempt < 4) {
        await sleep(10 * 2 ** attempt)
        continue
      }
      throw err
    }
  }
}

// A directory's entries, or none. Unreadable and missing are one answer here, unlike the file read
// above: the callers are scans, and a scan of what a cache happens to hold has nothing to decide
// about a directory it cannot open — there is simply nothing in it to walk.
export async function readDirOrEmpty(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

// Atomic write: plain writeFile truncates then streams, so a killed process — or two concurrent
// writers landing on one key — could leave a torn file that a later run happily LOADS as the cached
// result (a truncated `.md` still reads as text). Write to a per-process temp name in the same
// directory and rename into place: readers see either the old complete file or the new complete one,
// never a partial.
//
// The pid and the counter are both needed: the pid separates concurrent processes, the counter
// separates two writes racing inside one of them.
let tmpSeq = 0
export async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function move(from, to) {
  await rename(from, to)
}

// Move what may not be there, saying whether it was: a caller distinguishing "nothing to do" from
// "it moved" reads the boolean, and one that doesn't ignores it. Only absence is absorbed — a
// cross-device move or a permission failure is a real failure and still throws.
export async function moveIfExists(from, to) {
  try {
    await rename(from, to)
    return true
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

export async function removeIfExists(path) {
  try {
    await unlink(path)
  } catch (err) {
    if (!isMissing(err)) throw err
  }
}

// For a delete that is housekeeping rather than part of the operation: the caller's work is already
// done and correct whether or not this lands, so no failure it can report is worth raising.
export async function removeBestEffort(path) {
  await unlink(path).catch(() => {})
}
