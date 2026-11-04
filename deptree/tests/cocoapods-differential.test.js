import assert from 'node:assert/strict'
import process from 'node:process'
import { describe, it } from 'node:test'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { DeptreeError } from '../src/error.js'
import { archiveOf } from '../src/cocoapods/archive.js'
import { expandBraces, fnmatch } from '../src/cocoapods/fnmatch.js'
import { installPod, planPod } from '../src/cocoapods/install.js'
import { readPodspec, specNamed } from '../src/cocoapods/podspec.js'
import { cocoapods, cocoapodsVersion } from './cocoapods-reference.js'

// CocoaPods, which cleans every pod it downloads, against the port here:
// over patterns and paths made at random, which Ruby's File.fnmatch
// matches; patterns whose braces PathList expands; downloads and podspecs
// made at random, which PodDirCleaner cleans and lock_files! locks; and
// archives made at random, which RemoteFile extracts with `tar xf` and
// flattens. Skipped where ruby or the cocoapods gem is missing; GEM_PATH
// may say where it is. The seeds are fixed.

const SKIP = cocoapodsVersion() === undefined && 'no ruby with the cocoapods gem'
// As root, bsdtar keeps an archive's modes, as no other user's tar does.
const EXTRACT_SKIP = SKIP || (process.getuid?.() === 0 && process.platform !== 'linux' && 'root, whose bsdtar keeps the modes archived')

function random(seed) {
  let state = seed
  const next = (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % n
  }
  const pick = (items) => items[next(items.length)]
  return { next, pick, join: (items, length) => Array.from({ length }, () => pick(items)).join('') }
}

const PATTERN = ['*', '*', '?', '[', ']', '!', '^', '-', '\\', '/', '/', '.', 'a', 'A', 'b', 'B', '**/', '/**/', '\u00E9', '\u00C9', '{', '}', ',', 'm', '.m']
const PATH = ['a', 'A', 'b', 'B', '/', '.', '\u00E9', '\u00C9', '-', ']', '[', '*', 'm', '!', '\\', '{', ',']

// A path made from a pattern, so that many match it.
function pathOf({ next, pick, join }, pattern) {
  return [...pattern].map((char) => (char === '*' ? join(PATH, next(3)) : char === '?' ? pick(PATH) : next(4) === 0 ? pick(PATH) : char)).join('')
}

const NAMES = ['a', 'A', 'Sources', 'sources', 'Source', 'Classes', 'Res', 'res.bundle', 'x.m', 'X.M', 'y.h', 'z.swift', 'img.png', 'README.md', 'readme', 'LICENSE', 'License.md', '.hidden', 'foo.', 'mod.modulemap', 'pre.pch', 'lib.a', 'F.framework', 'Tests', 'S', 'So']
const DIRS = ['a', 'Sources', 'sources', 'Source', 'Classes', 'Res', 'res.bundle', 'Tests', 'S', 'F.framework', 'sub', '.hid', 'd.']
const PATTERNS = ['**/*.{h,m}', 'Sources/**/*', 'Sources', 'sources/', 'Source', '*.m', 'S*', '**/*.swift', 'Classes/*.{h,m,swift}', 'Res/*', 'res.bundle', '*.png', 'a/**', '**/*', 'Tests/**/*.m', '{a,b}/*', '{}', 'F.framework', 'lib.a', 'x.m', 'X.M', '[ab]/*', '*/[a]*', '.hid/*', 'd./*']
const LISTS = ['source_files', 'exclude_files', 'resources', 'preserve_paths', 'vendored_frameworks', 'vendored_libraries']

// A download of files, directories and links, each as the reference takes it.
function downloadOf({ next, pick }) {
  const entries = new Map()
  for (let i = 3 + next(25); i > 0; i--) {
    const dirs = Array.from({ length: next(4) }, () => pick(DIRS))
    const path = [...dirs, pick(NAMES)].join('/')
    const parents = dirs.map((_, k) => dirs.slice(0, k + 1).join('/'))
    if (entries.has(path) || parents.some((dir) => entries.has(dir) && entries.get(dir)[1] !== 'directory')) continue
    for (const dir of parents) if (!entries.has(dir)) entries.set(dir, [dir, 'directory'])
    const kind = next(10)
    if (kind === 0) entries.set(path, [path, 'directory'])
    else if (kind === 1) entries.set(path, [path, 'symlink', 0, pick(['x.m', 'Sources', 'nowhere', 'y.h', 'a'])])
    else entries.set(path, [path, 'file', pick([0o644, 0o755, 0o444, 0o600]), Buffer.from(path).toString('base64')])
  }
  return [...entries.values()]
}

function specOf(r, name, depth) {
  const patterns = () => (r.next(4) === 0 ? r.pick(PATTERNS) : Array.from({ length: r.next(4) }, () => r.pick(PATTERNS)))
  const spec = { name }
  for (const key of LISTS) if (r.next(3) === 0) spec[key] = patterns()
  if (r.next(6) === 0) spec.resource_bundles = { B: patterns() }
  if (r.next(8) === 0) spec.prefix_header_file = r.pick(['pre.pch', 'Sources/pre.pch', false])
  if (r.next(8) === 0) spec.module_map = r.pick(['mod.modulemap', 'a/mod.modulemap'])
  if (r.next(5) === 0) spec.platforms = r.pick([{ ios: '12.0' }, 'ios', ['ios', 'tvos']])
  if (depth < 2 && r.next(3) === 0) spec.subspecs = ['Core', 'UI', 'Ext'].slice(0, 1 + r.next(3)).map((sub) => specOf(r, sub, depth + 1))
  return spec
}

const namesOf = (spec, prefix) => [prefix, ...(spec.subspecs ?? []).flatMap((sub) => namesOf(sub, `${prefix}/${sub.name}`))]

function caseOf(r) {
  const root = { ...specOf(r, 'Pod', 0), version: '1.0.0' }
  if (r.next(4) === 0) root.license = { type: 'MIT', file: r.pick(['LICENSE', 'License.md', 'nope']) }
  const names = namesOf(root, 'Pod')
  const installed = names.filter(() => r.next(2) === 0)
  return { entries: downloadOf(r), podspec: JSON.stringify(root), installed: installed.length > 0 ? installed : [names[0]] }
}

// The port's install of a case, as the reference lists it.
function portInstall({ entries, podspec, installed: names }) {
  const dirs = entries.filter(([, type]) => type === 'directory').map(([path]) => path)
  const files = new Map(entries.filter(([, type]) => type === 'file').map(([path, , mode, data]) => [path, { data: Buffer.from(data, 'base64'), mode }]))
  const links = new Map(entries.filter(([, type]) => type === 'symlink').map(([path, , , target]) => [path, target]))
  const spec = readPodspec(Buffer.from(podspec), 'Pod', '1.0.0', 'pod')
  const out = installPod({ dirs, files, links }, planPod(spec, names.map((name) => specNamed(spec, name)), undefined, 'pod'), { where: 'pod' })
  return [...out.dirs.map((dir) => [dir, 'directory']), ...[...out.files].map(([path, { mode }]) => [path, 'file', mode]), ...[...out.links].map(([path, target]) => [path, 'symlink', target])]
}

const sorted = (entries) => entries.map((entry) => JSON.stringify(entry)).sort()

// An archive as GitHub or a release might hold one: most of them one
// directory, some of it of modes a user's tar keeps, drops or is refused
// here, with links and hard links; gzipped or not, whatever its type says,
// and flattened by default, or as :flatten says.
const TOPS = ['Pod-1.0', 'pod', 'v1.2.3', 'x.tmp']
// Those refused here, a special bit or what the owner cannot read, list or
// write in, now and then.
const FILE_MODES = [0o644, 0o644, 0o644, 0o755, 0o444, 0o600, 0o664, 0o777, 0o700, 0o640]
const DIR_MODES = [0o755, 0o755, 0o755, 0o700, 0o775, 0o777]
const fileMode = (r) => (r.next(97) < 2 ? r.pick([0o4755, 0o200, 0o1644, 0o2644]) : r.pick(FILE_MODES))
const dirMode = (r) => (r.next(97) < 2 ? r.pick([0o555, 0o2755, 0o311]) : r.pick(DIR_MODES))
async function archiveCaseOf(r) {
  // Each path's kind, a directory's whether or not an entry names it.
  const kinds = new Map()
  const entries = []
  const top = r.next(4) === 0 ? '' : r.pick(TOPS)
  const dirEntry = (path) => entries.push({ name: `${path}/`, type: 'directory', mode: dirMode(r) })
  if (top !== '') {
    kinds.set(top, 'directory')
    if (r.next(2) === 0) dirEntry(top)
  }
  const files = []
  for (let i = 1 + r.next(12); i > 0; i--) {
    const dirs = [...(top === '' ? [] : [top]), ...Array.from({ length: r.next(3) }, () => r.pick(DIRS))]
    const parents = dirs.map((_, k) => dirs.slice(0, k + 1).join('/'))
    const path = [...dirs, r.pick(NAMES)].join('/')
    if (kinds.has(path) || parents.some((dir) => kinds.has(dir) && kinds.get(dir) !== 'directory')) continue
    for (const dir of parents) {
      if (kinds.has(dir)) continue
      kinds.set(dir, 'directory')
      if (r.next(2) === 0) dirEntry(dir)
    }
    const kind = r.next(10)
    if (kind === 0) {
      kinds.set(path, 'directory')
      dirEntry(path)
    } else if (kind === 1) {
      kinds.set(path, 'symlink')
      entries.push({ name: path, type: 'symlink', linkname: r.pick(['x.m', 'README.md', 'nowhere', 'a']) })
    } else if (kind === 2 && files.length > 0) {
      kinds.set(path, 'file')
      entries.push({ name: path, type: 'hardlink', linkname: r.pick(files) })
    } else {
      kinds.set(path, 'file')
      entries.push({ name: path, data: Buffer.from(path), mode: fileMode(r) })
      files.push(path)
    }
  }
  if (top !== '' && r.next(5) === 0) entries.push({ name: r.pick(['README', '.DS_Store', 'pax']), data: Buffer.from('beside') })
  const type = r.pick(['tgz', 'tar', 'tgz', 'tbz'])
  const tar = pack(entries, { format: r.pick(['gnu', 'pax', 'ustar']) })
  const archive = r.next(3) === 0 ? tar : await compress(tar, 'gzip')
  const flatten = r.pick([undefined, undefined, true, false, null])
  return { archive: Buffer.from(archive).toString('base64'), type, ...(flatten === undefined ? {} : { flatten }) }
}

// The port's extraction of a case, as the reference lists it, every
// directory on the way to a path among them; or what it refuses.
async function portExtract({ archive, type, flatten }) {
  const source = { file: `file.${type}`, flatten: flatten === undefined ? true : flatten !== null && flatten !== false }
  const out = await archiveOf(Buffer.from(archive, 'base64'), source, 'pod')
  const dirs = new Set(out.dirs)
  for (const path of [...out.dirs, ...out.files.keys(), ...out.links.keys()]) {
    for (let at = path; at.includes('/');) dirs.add(at = at.slice(0, at.lastIndexOf('/')))
  }
  return [...[...dirs].map((dir) => [dir, 'directory']), ...[...out.files].map(([path, { mode }]) => [path, 'file', mode]), ...[...out.links].map(([path, target]) => [path, 'symlink', target])]
}

describe('the port, against CocoaPods', { skip: SKIP }, () => {
  it('matches each path as File.fnmatch does', () => {
    const r = random(7)
    const pairs = Array.from({ length: 6000 }, () => {
      const pattern = r.join(PATTERN, 1 + r.next(8))
      return [pattern, r.next(3) === 0 ? r.join(PATH, r.next(7)) : pathOf(r, pattern)]
    })
    const { fnmatch: expected } = cocoapods({ fnmatch: pairs, expand: [], install: [] })
    pairs.forEach(([pattern, path], i) => assert.equal(fnmatch(pattern, path), expected[i], `${pattern} ${path}`))
  })

  it('expands braces as PathList does', () => {
    const r = random(11)
    const patterns = Array.from({ length: 2000 }, () => r.join(PATTERN, 1 + r.next(9)))
    const { expand: expected } = cocoapods({ fnmatch: [], expand: patterns, install: [] })
    patterns.forEach((pattern, i) => {
      const ours = expandBraces(pattern)
      if (ours !== undefined) assert.deepEqual(ours, expected[i], pattern)
    })
  })

  it('keeps of each download what CocoaPods keeps, and locks what it locks', () => {
    const r = random(3)
    const cases = Array.from({ length: 200 }, () => caseOf(r))
    const { install: expected } = cocoapods({ fnmatch: [], expand: [], install: cases })
    let compared = 0
    cases.forEach((one, i) => {
      assert.equal(expected[i].error, undefined, `CocoaPods fails on ${JSON.stringify(one)}`)
      let ours
      try {
        ours = portInstall(one)
      } catch (error) {
        // Refused here as it names other files on another platform.
        if (error instanceof DeptreeError && /names other files on/u.test(error.message)) return
        throw error
      }
      assert.deepEqual(sorted(ours), sorted(expected[i].entries), JSON.stringify(one))
      compared++
    })
    assert.ok(compared > 150, `compared ${compared}`)
  })

  it('extracts and flattens each archive as RemoteFile does with `tar xf`, where it does not refuse it', { skip: EXTRACT_SKIP }, async () => {
    const r = random(5)
    const cases = []
    for (let i = 0; i < 400; i++) cases.push(await archiveCaseOf(r))
    const { extract: expected } = cocoapods({ fnmatch: [], expand: [], install: [], extract: cases })
    let compared = 0
    let refused = 0
    for (const [i, one] of cases.entries()) {
      let ours
      try {
        ours = await portExtract(one)
      } catch (error) {
        if (!(error instanceof DeptreeError)) throw error
        refused++
        continue
      }
      assert.equal(expected[i].error, undefined, `CocoaPods fails on what the port takes: ${JSON.stringify(one)}`)
      assert.deepEqual(sorted(ours), sorted(expected[i].entries), JSON.stringify(one))
      compared++
    }
    assert.ok(compared > 150 && refused > 20, `compared ${compared}, refused ${refused}`)
  })
})
