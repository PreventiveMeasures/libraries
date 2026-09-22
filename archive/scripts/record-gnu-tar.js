// Records what GNU tar writes for the trees below into
// tests/fixtures/gnu-tar.js. Needs Linux, GNU tar 1.35 on the PATH and
// root (two entries are device nodes):
//
//     node archive/scripts/record-gnu-tar.js
//
// Each tree is built in a temporary directory as its entries say and
// archived with `--no-recursion` and the members named in order, so the
// list here alone decides what tar writes.

import { execFileSync } from 'node:child_process'
import { chmodSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const OUT = new URL('../tests/tar/fixtures/gnu-tar.js', import.meta.url)

const T = 1577836800 // 2020-01-01T00:00:00Z
const pattern = (length) => Array.from({ length }, (_, i) => String.fromCodePoint(0x21 + (i * 7) % 94)).join('')

const D150 = 'd'.repeat(150)
const F90 = 'f'.repeat(90)

const TREES = {
  basic: [
    { name: 'a.txt', data: 'hello\n' },
    { name: 'dir', type: 'directory' },
    { name: 'dir/b.bin', data: pattern(1000) },
    { name: 'empty' },
    { name: 'link', type: 'symlink', linkname: 'a.txt' },
  ],
  long: [
    { name: 'n'.repeat(100) },
    { name: 'm'.repeat(101) },
    { name: D150, type: 'directory' },
    { name: `${D150}/${F90}` },
    { name: `${D150}/${F90}-dir`, type: 'directory' },
    { name: 'longlink', type: 'symlink', linkname: `${D150}/${F90}` },
    { name: 'ü.txt', data: 'x' },
    { name: 'ülink', type: 'symlink', linkname: 'ü.txt' },
  ],
  splittable: [
    { name: 'n'.repeat(100) },
    { name: `${D150}/${F90}` },
    { name: `${D150}/${F90}-dir`, type: 'directory' },
    { name: 'ü.txt', data: 'x' },
    { name: 'ülink', type: 'symlink', linkname: 'ü.txt' },
  ],
  links: [
    { name: 'bdev', type: 'block-device', devmajor: 7, devminor: 0 },
    { name: 'cdev', type: 'character-device', devmajor: 1, devminor: 3 },
    { name: 'fifo', type: 'fifo' },
    { name: 'h1', data: 'data' },
    { name: 'h2', type: 'link', linkname: 'h1' },
    { name: 'sub', type: 'directory' },
    { name: 'sub/h3', type: 'link', linkname: 'h1' },
  ],
  one: [{ name: 'a.txt', data: 'hi' }],
  // The root itself as a member, which tar writes as `./`.
  dot: [{ name: '.', type: 'directory' }, { name: 'a.txt', data: 'hi' }],
}

const UNAME31 = 'abcdefghijklmnopqrstuvwxyzabcde'
const UNAME36 = 'abcdefghijklmnopqrstuvwxyzabcdefghij'

// `args` go to tar; `expect` is what they make of every entry.
const CASES = [
  { tree: 'basic', format: 'gnu', blocking: 20 },
  { tree: 'basic', format: 'gnu' },
  { tree: 'basic', format: 'ustar' },
  { tree: 'basic', format: 'pax' },
  { tree: 'long', format: 'gnu' },
  { tree: 'long', format: 'pax' },
  { tree: 'splittable', format: 'ustar' },
  { tree: 'links', format: 'gnu' },
  { tree: 'links', format: 'ustar' },
  { tree: 'links', format: 'pax' },
  { tree: 'one', format: 'gnu', args: ['--owner=:3000000', '--group=:3000000'], expect: { uid: 3000000, gid: 3000000 } },
  { tree: 'one', format: 'pax', args: ['--owner=:3000000', '--group=:3000000'], expect: { uid: 3000000, gid: 3000000 } },
  { tree: 'one', format: 'gnu', args: ['--mtime=@100000000000'], expect: { mtime: 100000000000 } },
  { tree: 'one', format: 'pax', args: ['--mtime=@100000000000'], expect: { mtime: 100000000000 } },
  { tree: 'one', format: 'gnu', args: ['--mtime=@-1'], expect: { mtime: -1 } },
  { tree: 'one', format: 'pax', args: ['--mtime=@-1'], expect: { mtime: -1 } },
  { tree: 'one', format: 'gnu', owners: ['root', 'root'] },
  { tree: 'one', format: 'ustar', owners: [UNAME31, UNAME31] },
  { tree: 'one', format: 'pax', owners: [UNAME31, UNAME31] },
  { tree: 'one', format: 'pax', owners: [UNAME36, UNAME36] },
  { tree: 'one', format: 'gnu', owners: ['ünïcode', 'gröup'] },
  { tree: 'one', format: 'pax', owners: ['ünïcode', 'gröup'] },
  { tree: 'empty', format: 'gnu', blocking: 20 },
  { tree: 'dot', format: 'gnu' },
  { tree: 'dot', format: 'pax' },
]

const DEFAULT_MODE = { directory: 0o755, symlink: 0o777 }

function normalize(spec, expect) {
  const type = spec.type ?? 'file'
  return {
    name: spec.name,
    type,
    mode: spec.mode ?? DEFAULT_MODE[type] ?? 0o644,
    uid: 0,
    gid: 0,
    mtime: T,
    uname: '',
    gname: '',
    linkname: spec.linkname ?? '',
    devmajor: spec.devmajor ?? 0,
    devminor: spec.devminor ?? 0,
    data: spec.data ?? '',
    ...expect,
  }
}

function build(root, entries) {
  for (const e of entries) {
    const path = join(root, e.name)
    mkdirSync(dirname(path), { recursive: true })
    if (e.type === 'directory') {
      if (e.name !== '.') mkdirSync(path)
    }
    else if (e.type === 'symlink') symlinkSync(e.linkname, path)
    else if (e.type === 'link') linkSync(join(root, e.linkname), path)
    else if (e.type === 'fifo') execFileSync('mkfifo', ['-m', '644', path])
    else if (e.type === 'character-device' || e.type === 'block-device') execFileSync('mknod', ['-m', '644', path, e.type[0], String(e.devmajor), String(e.devminor)])
    else writeFileSync(path, e.data)
    if (e.type !== 'symlink' && e.type !== 'link') chmodSync(path, e.mode)
  }
  // Children before their directories: creating an entry touches its directory.
  for (const e of entries.toReversed()) {
    if (e.type === 'symlink') lutimesSync(join(root, e.name), T, T)
    else utimesSync(join(root, e.name), T, T)
  }
}

function record(c) {
  const root = mkdtempSync(join(tmpdir(), 'record-gnu-tar-'))
  try {
    const specs = TREES[c.tree] ?? []
    const owners = c.owners ? [`--owner=${c.owners[0]}:0`, `--group=${c.owners[1]}:0`] : ['--owner=0', '--group=0', '--numeric-owner']
    const expect = { ...(c.owners && { uname: c.owners[0], gname: c.owners[1] }), ...c.expect }
    const entries = specs.map((spec) => normalize(spec, expect))
    build(root, entries)
    const blocking = c.blocking ?? 1
    const args = [
      `--format=${c.format === 'pax' ? 'posix' : c.format}`, '-b', String(blocking), '--no-recursion', ...owners,
      ...(c.format === 'pax' ? ['--pax-option=delete=atime,delete=ctime'] : []), ...(c.args ?? []),
      '-cf', '-', ...(specs.length ? ['--', ...specs.map((s) => s.name)] : ['-T', '/dev/null']),
    ]
    const archive = execFileSync('tar', args, { cwd: root, maxBuffer: 1 << 26 })
    return { command: `tar ${args.join(' ')}`, format: c.format, blocking, entries, archive: hexWithZeroRuns(archive) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Hex with each run of zero bytes as its length in brackets.
function hexWithZeroRuns(buffer) {
  let out = ''
  for (let i = 0; i < buffer.length;) {
    if (buffer[i] === 0) {
      let j = i
      while (j < buffer.length && buffer[j] === 0) j++
      out += `[${j - i}]`
      i = j
    } else {
      out += buffer[i].toString(16).padStart(2, '0')
      i++
    }
  }
  return out
}

const version = execFileSync('tar', ['--version']).toString().split('\n')[0]
if (!version.startsWith('tar (GNU tar)')) throw new Error(`need GNU tar, found ${version}`)

const recordings = CASES.map(record)
const header = `// Output recorded from ${version} by scripts/record-gnu-tar.js — see there
// for the trees and the options. Do not edit by hand; run the script.
//
// Every recording is a list of entries, in the order they were given to
// tar and with every field filled in, and the archive tar wrote for them:
// its bytes in hex, with each run of zero bytes as its length in brackets.
// \`blocking\` is the -b it was written with.

export const bytesOf = ({ archive }) => Uint8Array.from(
  [...archive.matchAll(/\\[(\\d+)\\]|([0-9a-f]{2})/gu)].flatMap(([, zeros, hex]) => (zeros ? Array.from({ length: Number(zeros) }, () => 0) : [Number.parseInt(hex, 16)])),
)

`
writeFileSync(OUT, `${header}export const RECORDINGS = ${JSON.stringify(recordings, null, 2)}\n`)
console.log(`recorded ${recordings.length} cases from ${version} into ${OUT.pathname}`)
