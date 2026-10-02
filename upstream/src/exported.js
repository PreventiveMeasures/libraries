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

import { attributesOf, parseAttributes } from './attributes.js'
import { lineEndsToWorktree, mayRewriteLineEnds } from './eol.js'
import { ATTRIBUTES, gitTreeOfListing, nameOf, objectId, readTarball, subtree, treeId } from './tree.js'

class Refusal extends Error {}

const show = JSON.stringify
const hex = (dir) => treeId(dir).toString('hex')
const isIgnored = (stack, path) => attributesOf(stack, path).get('export-ignore') === true
// Git reads a .gitattributes from a blob, never through a symlink.
const isAttributes = (entry) => entry?.type === 'blob' && entry.mode !== '120000'

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
  return [...stack, { base: prefix.slice(0, -1), lines: parseAttributes(Buffer.from(bytes).toString('latin1'), prefix === '') }]
}

// A file the archive has otherwise than its blob: the blob, its line ends
// written as its attributes have git write them.
async function isRewritten(present, entry, path, attributes, blob) {
  if (present instanceof Map || present.mode !== entry.mode || !mayRewriteLineEnds(attributes)) return false
  return Buffer.from(lineEndsToWorktree(await blobOf(entry, path, blob), attributes)).equals(present.body)
}

// A directory the archive has whole, as its id shows: none of it may be
// marked export-ignore, and every directory in it has to hold a file, as
// git writes a directory only on reaching one. Whether it holds one.
function checkWhole(here, prefix, stack) {
  const own = here.get(ATTRIBUTES)
  const inner = own?.body === undefined ? stack : [...stack, { base: prefix.slice(0, -1), lines: parseAttributes(Buffer.from(own.body).toString('latin1'), prefix === '') }]
  for (const [name, entry] of here) {
    const isDir = entry instanceof Map
    const path = `${prefix}${name}${isDir ? '/' : ''}`
    if (isIgnored(inner, path)) throw new Refusal(`no tree: ${show(path)} is in the archive, though the tree's .gitattributes mark it export-ignore`)
    if (isDir && !checkWhole(entry, path, inner)) throw new Refusal(`no tree: ${show(path)} is in the archive, though git writes no directory it reaches no file in`)
  }
  return here.size > 0
}

// The tree `sha` at `prefix` put back together in `here`, the archive's
// entries of it: whether git reaches a file in it, a submodule or a file
// it leaves out among them, which has it write the directory.
async function walk(here, sha, prefix, stack, io) {
  if (hex(here) === sha) return checkWhole(here, prefix, stack)
  const entries = await io.listed(sha)
  const inner = await withOwn(stack, prefix, here, entries.find((entry) => entry.name === ATTRIBUTES), io.blob)
  const names = new Set(entries.map(({ name }) => name))
  const stray = [...here.keys()].find((name) => !names.has(name))
  if (stray !== undefined) throw new Refusal(`no tree: ${show(prefix + stray)} is in the archive, not the tree`)
  let reached = false
  for (const entry of entries) {
    const present = here.get(entry.name)
    const path = `${prefix}${entry.name}${entry.type === 'blob' ? '' : '/'}`
    reached ||= entry.type !== 'tree'
    if (isIgnored(inner, path)) {
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
    } else if (present instanceof Map || present.mode !== entry.mode || present.id.toString('hex') !== entry.sha) {
      if (!await isRewritten(present, entry, path, attributesOf(inner, path), io.blob)) throw new Refusal(`no tree: ${show(path)} is not the tree's, as git rewrites a file marked export-subst or ident, or for its working-tree-encoding`)
      here.set(entry.name, asListed(entry))
    }
  }
  return reached
}

// `list` answers GitHub's listing of a tree by its id, `blob` a blob's
// bytes by its id; `commit` is the commit whose archive it is.
export async function gitTreeOfArchive(gzipped, { expected, commit, list, blob }) {
  const read = readTarball(gzipped, { commit })
  if (typeof read === 'string') return read
  const listed = async (sha) => {
    const entries = await list(sha)
    if (!Array.isArray(entries) || gitTreeOfListing(entries) !== sha) throw new Refusal(`no tree: GitHub's listing of tree ${sha} is not that tree`)
    return entries.map((entry) => ({ ...entry, name: nameOf(entry.path) }))
  }
  try {
    await walk(read.root, expected, '', [], { listed, blob })
  } catch (error) {
    if (error instanceof Refusal) return error.message
    throw error
  }
  return hex(read.root)
}
