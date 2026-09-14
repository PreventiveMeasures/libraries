// The cache's filesystem over OPFS, the origin's private storage. Handle-based rather than
// path-based, so the paths cache.js builds are walked a segment at a time; absence is a
// NotFoundError; `..` is rejected outright and there is nothing above the root; and
// `FileSystemHandle.move()` is not in every engine that ships OPFS — see writeAtomic and moveEntry.
// Needs a secure context, as the digest in cache.js does.

const segments = (path) => String(path).split('/').filter((part) => part && part !== '.')

export function join(...parts) {
  const path = parts.flatMap(segments).join('/')
  return path || '.'
}

const isMissing = (err) => err?.name === 'NotFoundError'

const opfsRoot = () => navigator.storage.getDirectory()

async function dirAt(parts, create) {
  let dir = await opfsRoot()
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}

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

// Null only for missing or empty, as the Node half does.
export async function readTextOrNull(path) {
  try {
    return await readText(path) || null
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

// As much of node:fs's Dirent as cache-scan.js reads.
const direntOf = (name, handle) => ({
  name,
  isFile: () => handle.kind === 'file',
  isDirectory: () => handle.kind === 'directory',
})

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

let canMove

// With `move()`, the Node half's temp-then-rename. Without it, `createWritable()` stands in: it stages
// into a swap file and commits at close(), so an abandoned write leaves the previous contents rather
// than a truncated file — an engine's promise rather than a filesystem's, hence the fallback.
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
    // No move() in this engine: take the fallback, and stop paying for a temp file from here on.
    canMove = false
    await dir.removeEntry(tmpName).catch(() => {})
    await writeAtomic(path, data)
  }
}

// Without `move()` a file is copied and the original dropped, which is not atomic. A directory has no
// fallback: its one caller is cache.js's migration of a type renamed before any browser cache
// existed, so it cannot fire here.
const canRetitle = (handle) => typeof handle.move === 'function'

async function moveEntry(from, to) {
  const source = segments(from)
  const target = segments(to)
  const name = target.at(-1)
  const dir = await dirAt(target.slice(0, -1), true)

  const handle = await (await dirAt(source.slice(0, -1), false)).getFileHandle(source.at(-1))
    .catch(async (err) => {
      if (!isMissing(err)) throw err
      // Not a file, so move()-only.
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

export async function removeBestEffort(path) {
  await removeIfExists(path).catch(() => {})
}
