import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export { join }

const isMissing = (err) => err.code === 'ENOENT'

// Pressure, not absence: parallel lookups can exhaust fds or hit a busy volume, where the same read
// would have succeeded a moment later.
const TRANSIENT_READ_ERRORS = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'ETIMEDOUT'])

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

export async function readText(path) {
  return await readFile(path, 'utf8')
}

// Null only for missing or empty; everything else throws, so a caller degrading an unreadable file to
// "absent" still gets to say so.
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

// Plain writeFile truncates then streams, so a killed process — or two writers on one key — can leave
// a torn file that a later run happily LOADS (a truncated `.md` still reads as text). The pid
// separates processes, the counter two writes racing inside one.
//
// The temp file is new, so it takes the umask rather than the mode of what it replaces. That was
// invisible while this only ever created entries; a pass that rewrites a whole cache in place — see
// cache-normalize.js — would otherwise relax every file it touched, and a history holds the system
// prompt, the user content and raw tool output, which is exactly what an operator would have
// restricted. Carried over when there is something to carry over, and left to the umask when the
// file is new. Best-effort: a mode we cannot read or set is not a reason to lose the write.
let tmpSeq = 0
export async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, data)
  const mode = await stat(path).then((s) => s.mode & 0o7777, () => null)
  if (mode !== null) await chmod(tmp, mode).catch(() => {})
  await rename(tmp, path)
}

export async function move(from, to) {
  await rename(from, to)
}

// What `text` weighs once written, for a caller reporting a size rather than a character count.
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

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

export async function removeBestEffort(path) {
  await unlink(path).catch(() => {})
}
