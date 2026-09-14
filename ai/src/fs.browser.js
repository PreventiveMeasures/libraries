// fs.js for a browser build, chosen by the `#fs` condition in package.json: the cache's filesystem
// over OPFS, the origin's own private storage (navigator.storage.getDirectory).

// OPFS is the only writable storage a page has that is shaped like a filesystem at all — real
// directories, real files, a few hundred MB to gigabytes of quota rather than localStorage's five —
// and the cache is exactly the thing that wants it: many small files, addressed by a hashed name,
// read far more often than written.

// It is not, however, a filesystem, and four differences shape everything below.

// It has no paths, only handles: a directory is reached by asking its parent for a child by name, one
// segment at a time. So the string paths cache.js builds are walked here rather than handed to a
// syscall, and `join` is a string helper over the same shape node:path produced.

// There is no cwd and nothing above the root. An absolute-looking cache dir — setCacheDir('/cache'),
// or a host path copied from a Node config — is read as a path under the origin's private root, which
// is the only place there is. Nothing can traverse out of it: OPFS rejects a `..` segment outright,
// and the segment filter below drops the `.` that cannot mean anything either.

// Absence is a DOMException named NotFoundError rather than an ENOENT, and the errnos that mean
// pressure on a filesystem — EMFILE, EAGAIN — have no counterpart at all. A page has no fd table to
// exhaust, so the read retry that fs.js does for those has nothing here to retry.

// And a rename is not a given. `FileSystemHandle.move()` is what the retitling below wants, and
// engines that ship OPFS do not all ship it yet, so each mover states what it does without one.

// One requirement, shared with the Web Crypto digest in cache.js: a secure context. A page served
// over plain http has no navigator.storage.getDirectory, and the cache is unusable there.

// Path segments, as OPFS can take them: a leading slash means nothing here, `.` cannot mean anything,
// and an empty segment out of a double slash is not a directory name.
const segments = (path) => String(path).split('/').filter((part) => part && part !== '.')

// The same joining node:path did for the paths cache.js builds — `<model>/<type>-<hash>` and a
// filename onto it. Not a general-purpose resolver: it has no absolute paths to respect and no `..`
// to collapse, because neither reaches it.
export function join(...parts) {
  const path = parts.flatMap(segments).join('/')
  return path || '.'
}

// Absence, the one failure with a return value rather than a throw: a cache asks for files that are
// usually not there. NotFoundError covers both a missing file and a missing directory on the way to
// it, which is the same answer either way.
const isMissing = (err) => err?.name === 'NotFoundError'

const opfsRoot = () => navigator.storage.getDirectory()

// Walk to a directory, creating it or not. `ensureDir` is the create side of this and the only
// caller that passes true; every read walks with false so that a missing directory is a miss rather
// than a tree of empty directories left behind by looking.
async function dirAt(parts, create) {
  let dir = await opfsRoot()
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}

// A file's name and the directory holding it, which is how OPFS addresses a file: there is no
// operation that takes a whole path.
async function placeOf(path, create) {
  const parts = segments(path)
  const name = parts.pop()
  if (!name) throw new TypeError(`Not a file path: ${path}`)
  return { dir: await dirAt(parts, create), name }
}

async function fileAt(path, create) {
  const { dir, name } = await placeOf(path, create)
  return await dir.getFileHandle(name, { create })
}

export async function readText(path) {
  return await (await (await fileAt(path, false)).getFile()).text()
}

// The text at `path`, or null if there is nothing usable there — a missing file, a missing directory
// on the way to it, or an empty file, which is a write that did not finish. Everything else throws,
// as it does under Node: a caller degrading an unreadable file to "absent" has a decision to
// announce, and swallowing the reason here would take the words out of its mouth.
export async function readTextOrNull(path) {
  try {
    return await readText(path) || null
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

// node:fs's Dirent, as much of it as the scans in cache-scan.js read. OPFS iteration already hands
// over the two things they ask — a name, and whether it is a file — so this is a shape adapter and
// nothing more.
const direntOf = (name, handle) => ({
  name,
  isFile: () => handle.kind === 'file',
  isDirectory: () => handle.kind === 'directory',
})

// A directory's entries, or none: a scan of what a cache happens to hold has nothing to decide about
// a directory it cannot open — there is simply nothing in it to walk.
export async function readDirOrEmpty(path) {
  try {
    const dir = await dirAt(segments(path), false)
    const out = []
    for await (const [name, handle] of dir.entries()) out.push(direntOf(name, handle))
    return out
  } catch {
    return []
  }
}

export async function ensureDir(dir) {
  await dirAt(segments(dir), true)
}

async function writeInto(handle, data) {
  const stream = await handle.createWritable()
  await stream.write(data)
  await stream.close()
}

// Whether this engine can retitle a handle, probed once on the first write rather than asserted: it
// is a capability, and the fallback is a real fallback rather than a failure.
let canMove

// Write, then put it in place. Where `move()` exists this is the same two steps fs.js takes on Node —
// a temp name in the same directory, then a rename — and gives the same guarantee: a reader sees
// either the old complete file or the new complete one.
//
// Where it does not, the write goes straight to the destination, and what stands in for the rename is
// the writable stream itself: `createWritable()` stages into a swap file and commits at `close()`, so
// an abandoned write leaves the previous contents rather than a truncated file. That is an engine's
// promise rather than a filesystem's, which is why it is the fallback and not the method.
//
// The suffix is random rather than a pid: a page has no pid, and two tabs on one origin share this
// storage the way two processes share a directory.
let tmpSeq = 0

function tmpNameFor(name) {
  const unique = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `${name}.${++tmpSeq}-${unique}.tmp`
}

export async function writeAtomic(path, data) {
  const { dir, name } = await placeOf(path, true)
  if (canMove === false) {
    await writeInto(await dir.getFileHandle(name, { create: true }), data)
    return
  }
  const tmpName = tmpNameFor(name)
  const tmp = await dir.getFileHandle(tmpName, { create: true })
  await writeInto(tmp, data)
  try {
    await tmp.move(name)
    canMove = true
  } catch (err) {
    if (canMove) throw err
    // First write of the session, and this engine has no move: take the fallback, and stop paying for
    // a temp file on every write from here on.
    canMove = false
    await dir.removeEntry(tmpName).catch(() => {})
    await writeAtomic(path, data)
  }
}

// Retitle or relocate an entry. OPFS has one operation for both, when it has it at all: `move()`
// takes a new name, a new directory, or both.
//
// The fallback for a file is to copy it and drop the original, which is not atomic — a reader can see
// both names at once, and a failure between the two leaves the source. For a DIRECTORY there is no
// fallback at all: a recursive copy is a different operation with different failure modes, and the
// one caller that moves a directory is cache.js's one-shot migration of a type renamed before any
// browser cache existed, which is to say it cannot fire here.
const canRetitle = (handle) => typeof handle.move === 'function'

async function moveEntry(from, to) {
  const source = segments(from)
  const target = segments(to)
  const name = target.at(-1)
  const dir = await dirAt(target.slice(0, -1), true)

  const handle = await (await dirAt(source.slice(0, -1), false)).getFileHandle(source.at(-1))
    .catch(async (err) => {
      if (!isMissing(err)) throw err
      // Not a file. A directory move is move()-only, and reports itself as such.
      const asDir = await dirAt(source, false)
      if (!canRetitle(asDir)) {
        throw new Error(`Cannot move the directory ${from}: this browser has no FileSystemHandle.move()`)
      }
      return asDir
    })

  if (canRetitle(handle)) {
    await handle.move(dir, name)
    return
  }
  await writeInto(await dir.getFileHandle(name, { create: true }), await (await handle.getFile()).text())
  await (await dirAt(source.slice(0, -1), false)).removeEntry(source.at(-1))
}

export async function move(from, to) {
  await moveEntry(from, to)
}

// Move what may not be there, saying whether it was: a caller distinguishing "nothing to do" from
// "it moved" reads the boolean, and one that doesn't ignores it. Only absence is absorbed.
export async function moveIfExists(from, to) {
  try {
    await moveEntry(from, to)
    return true
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

export async function removeIfExists(path) {
  const { dir, name } = await placeOf(path, false).catch((err) => {
    if (isMissing(err)) return {}
    throw err
  })
  if (!dir) return
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!isMissing(err)) throw err
  }
}

// For a delete that is housekeeping rather than part of the operation: the caller's work is already
// done and correct whether or not this lands, so no failure it can report is worth raising.
export async function removeBestEffort(path) {
  await removeIfExists(path).catch(() => {})
}
