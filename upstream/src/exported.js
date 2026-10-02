// The id of the git tree a commit's archive comes from, as `git archive`
// 2.43 exports it: what the tree's .gitattributes mark export-ignore left
// out, and nothing else. Each file there has to be the tree's own, or its
// blob with its line ends written as its eol attributes have git write
// them; one git rewrites otherwise, as export-subst, ident or a
// working-tree-encoding has it, comes out otherwise. What is missing is read
// off GitHub's listings of the trees, each held to its id, from the top down
// to every directory missing anything, and the .gitattributes that say why,
// and the blobs of files rewritten so, from GitHub's blobs, held to theirs.

import { Buffer } from 'node:buffer'

import { show } from './args.js'
import { attributesOf, frameOf } from './attr.js'
import { lineEndsRewriter } from './eol.js'
import { ATTRIBUTES, gitTreeOfListing, nameOf, objectId, readTarball, subtree, treeId } from './tree.js'

class Refusal extends Error {}

const isIgnored = (attributes) => attributes.get('export-ignore') === true
// Git reads a .gitattributes from a blob, never through a symlink.
const isAttributes = (entry) => entry?.type === 'blob' && entry.mode !== '120000'
// The .gitattributes of the directory at `prefix`, macros in the top one.
const frame = (prefix, bytes) => frameOf(prefix.slice(0, -1), Buffer.from(bytes).toString('latin1'), prefix === '')

// The tree's entry back where the archive leaves it out.
const asListed = ({ mode, type, sha }) => (type === 'tree' ? subtree(sha) : { mode, id: Buffer.from(sha, 'hex') })

// GitHub's blob of a path, held to its id.
async function blobOf(entry, path, blob) {
  const bytes = await blob(entry.sha)
  if (!(bytes instanceof Uint8Array) || objectId('blob', bytes).toString('hex') !== entry.sha) throw new Refusal(`no tree: GitHub's blob ${entry.sha}, ${show(path)}, is not that blob`)
  return bytes
}

// A directory's own .gitattributes on top of the stack above it, `here` the
// archive's entries of it.
async function withOwn(stack, prefix, here, entry, blob) {
  if (!isAttributes(entry)) return stack
  const archived = here.get(ATTRIBUTES)
  const bytes = archived?.body !== undefined && archived.id.toString('hex') === entry.sha ? archived.body : await blobOf(entry, `${prefix}${ATTRIBUTES}`, blob)
  return [...stack, frame(prefix, bytes)]
}

// A file, never a link, the archive has otherwise than its blob: the blob,
// its line ends written as its attributes have git write them.
async function isRewritten(present, entry, path, attributes, blob) {
  const rewrite = entry.mode === '120000' ? null : lineEndsRewriter(attributes)
  return rewrite !== null && objectId('blob', rewrite(await blobOf(entry, path, blob))).equals(present.id)
}

// A directory the archive has whole, as its id shows: none of it may be
// marked export-ignore, and every directory in it has to hold a file, as
// git writes a directory only on reaching one. Whether it holds one.
function checkWhole(here, prefix, stack) {
  const own = here.get(ATTRIBUTES)
  const inner = own?.body === undefined ? stack : [...stack, frame(prefix, own.body)]
  for (const [name, entry] of here) {
    const isDir = entry instanceof Map
    const path = `${prefix}${name}${isDir ? '/' : ''}`
    if (isIgnored(attributesOf(inner, path))) throw new Refusal(`no tree: ${show(path)} is in the archive, though the tree's .gitattributes mark it export-ignore`)
    if (isDir && !checkWhole(entry, path, inner)) throw new Refusal(`no tree: ${show(path)} is in the archive, though git writes no directory it reaches no file in`)
  }
  return here.size > 0
}

// The tree `sha` at `prefix` put back together in `here`, the archive's
// entries of it: whether git reaches a file in it, a submodule or a file
// it leaves out among them, which has it write the directory. The
// listings of the subtrees the archive has otherwise are asked for at
// once, rather than one after another.
async function walk(here, sha, prefix, stack, io) {
  if (io.id(here) === sha) return checkWhole(here, prefix, stack)
  const entries = await io.listed(sha)
  for (const entry of entries) {
    const present = here.get(entry.name)
    if (entry.type === 'tree' && present instanceof Map && io.id(present) !== entry.sha) io.listed(entry.sha).catch(() => {})
  }
  const inner = await withOwn(stack, prefix, here, entries.find((entry) => entry.name === ATTRIBUTES), io.blob)
  const names = new Set(entries.map(({ name }) => name))
  const stray = [...here.keys()].find((name) => !names.has(name))
  if (stray !== undefined) throw new Refusal(`no tree: ${show(prefix + stray)} is in the archive, not the tree`)
  let reached = false
  for (const entry of entries) {
    const present = here.get(entry.name)
    const path = `${prefix}${entry.name}${entry.type === 'blob' ? '' : '/'}`
    const attributes = attributesOf(inner, path)
    reached ||= entry.type !== 'tree'
    if (isIgnored(attributes)) {
      if (present !== undefined) throw new Refusal(`no tree: ${show(path)} is in the archive, though the tree's .gitattributes mark it export-ignore`)
      here.set(entry.name, asListed(entry))
    } else if (entry.type === 'tree') {
      if (present !== undefined && !(present instanceof Map)) throw new Refusal(`no tree: ${show(path)} is a file in the archive, a directory in the tree`)
      const dir = present ?? new Map()
      const wrote = await walk(dir, entry.sha, path, inner, io)
      if ((present !== undefined) !== wrote) throw new Refusal(`no tree: ${show(path)} is ${wrote ? 'not ' : ''}in the archive, though git writes a directory where it reaches a file, and only there`)
      reached ||= wrote
      here.set(entry.name, dir)
    } else if (entry.type === 'commit') {
      if (!(present instanceof Map) || present.size > 0) throw new Refusal(`no tree: the submodule ${show(path)} is not an empty directory in the archive`)
      here.set(entry.name, asListed(entry))
    } else if (present === undefined) {
      throw new Refusal(`no tree: ${show(path)} is not in the archive`)
    } else if (present instanceof Map || present.mode !== entry.mode || (present.id.toString('hex') !== entry.sha && !await isRewritten(present, entry, path, attributes, io.blob))) {
      throw new Refusal(`no tree: ${show(path)} is not the tree's, as git rewrites a file marked export-subst or ident, or for its working-tree-encoding`)
    } else {
      here.set(entry.name, asListed(entry))
    }
  }
  return reached
}

// `list` answers GitHub's listing of a tree by its id, `blob` a blob's
// bytes by its id; `commit` is the commit whose archive it is. Each
// directory's id is worked out once, as the archive has it, before the
// walk puts anything back in it; the whole tree's once more after.
export async function gitTreeOfArchive(gzipped, { expected, commit, list, blob }) {
  const root = readTarball(gzipped, { commit })
  if (typeof root === 'string') return root
  const memo = new WeakMap()
  const listed = async (sha) => {
    const entries = await list(sha)
    if (!Array.isArray(entries) || gitTreeOfListing(entries) !== sha) throw new Refusal(`no tree: GitHub's listing of tree ${sha} is not that tree`)
    return entries.map((entry) => ({ ...entry, name: nameOf(entry.path) }))
  }
  try {
    await walk(root, expected, '', [], { listed, blob, id: (dir) => treeId(dir, memo).toString('hex') })
  } catch (error) {
    if (error instanceof Refusal) return error.message
    throw error
  }
  return treeId(root).toString('hex')
}
