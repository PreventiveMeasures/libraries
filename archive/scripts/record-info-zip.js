// Records what Info-ZIP zip writes for the trees below, and what Python's
// zipfile writes when it cannot seek (data descriptors), into
// tests/fixtures/info-zip.js. Needs Linux, Info-ZIP zip 3.0 and python3:
//
//     node archive/scripts/record-info-zip.js
//
// Each tree is built in a temporary directory as its entries say and
// archived with the members named in order, in UTC, so the list here
// alone decides what is written.

import { execFileSync } from 'node:child_process'
import { chmodSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const OUT = new URL('../tests/zip/fixtures/info-zip.js', import.meta.url)

const T = 1577836800 // 2020-01-01T00:00:00Z
const pattern = (length) => Array.from({ length }, (_, i) => String.fromCodePoint(0x21 + (i * 7) % 94)).join('')

const TREES = {
  basic: [
    { name: 'a.txt', data: 'hello hello hello hello\n' },
    { name: 'dir', type: 'directory' },
    { name: 'dir/b.bin', data: pattern(3000) },
    { name: 'empty' },
    { name: 'link', type: 'symlink', linkname: 'a.txt' },
    { name: 'ü.txt', data: 'x' },
    { name: 'exec', data: '#!/bin/sh\n', mode: 0o755 },
  ],
  odd: [{ name: 'a.txt', data: 'hi', mtime: T + 1 }],
}

// `args` go to zip after the members; `python` records with zipfile instead.
const CASES = [
  { tree: 'basic', args: ['-0'] },
  { tree: 'basic', args: ['-0', '-X'] },
  { tree: 'basic', args: [] },
  { tree: 'odd', args: ['-0'] },
  { tree: 'odd', args: ['-0', '-X'], expect: { mtime: T } },
  { tree: 'basic', python: true },
]

const DEFAULT_MODE = { file: 0o644, directory: 0o755, symlink: 0o777 }

const normalize = (spec, expect) => ({
  name: spec.name,
  type: spec.type ?? 'file',
  mode: spec.mode ?? DEFAULT_MODE[spec.type ?? 'file'],
  mtime: spec.mtime ?? T,
  linkname: spec.linkname ?? '',
  data: spec.data ?? '',
  ...expect,
})

function build(root, entries) {
  for (const e of entries) {
    const path = join(root, e.name)
    mkdirSync(dirname(path), { recursive: true })
    if (e.type === 'directory') mkdirSync(path)
    else if (e.type === 'symlink') symlinkSync(e.linkname, path)
    else writeFileSync(path, e.data)
    if (e.type !== 'symlink') chmodSync(path, e.mode)
  }
  for (const e of entries.toReversed()) {
    if (e.type === 'symlink') lutimesSync(join(root, e.name), e.mtime, e.mtime)
    else utimesSync(join(root, e.name), e.mtime, e.mtime)
  }
}

// zipfile writing to a stream it cannot seek: every file entry gets a data
// descriptor, and every name is written as UTF-8 with the flag set.
const PYTHON = `
import io, os, sys, zipfile, time
class Unseekable(io.RawIOBase):
    def __init__(self): self.buf = bytearray()
    def writable(self): return True
    def write(self, b): self.buf += b; return len(b)
out = Unseekable()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in sys.argv[1:]:
        st = os.lstat(name)
        info = zipfile.ZipInfo(name + ('/' if os.path.isdir(name) else ''), time.gmtime(st.st_mtime)[:6])
        info.external_attr = (st.st_mode & 0o177777) << 16
        if os.path.islink(name): z.writestr(info, os.readlink(name), zipfile.ZIP_STORED)
        elif os.path.isdir(name): info.external_attr |= 0x10; z.writestr(info, b'', zipfile.ZIP_STORED)
        else: z.writestr(info, open(name, 'rb').read())
sys.stdout.buffer.write(bytes(out.buf))
`

function record(c) {
  const root = mkdtempSync(join(tmpdir(), 'record-info-zip-'))
  try {
    const entries = TREES[c.tree].map((spec) => normalize(spec, c.expect))
    build(root, entries)
    const members = entries.map((e) => e.name)
    const env = { ...process.env, TZ: 'UTC' }
    let archive
    let command
    if (c.python) {
      command = `python3 (zipfile, unseekable) ${members.join(' ')}`
      archive = execFileSync('python3', ['-c', PYTHON, ...members], { cwd: root, env })
    } else {
      const args = ['-q', '-y', ...c.args, 'out.zip', '--', ...members]
      command = `TZ=UTC zip ${args.join(' ')}`
      execFileSync('zip', args, { cwd: root, env })
      archive = readFileSync(join(root, 'out.zip'))
    }
    return { command, entries, archive: archive.toString('base64') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const version = execFileSync('zip', ['-v']).toString().split('\n').find((line) => line.startsWith('This is Zip'))
const recordings = CASES.map(record)
const header = `// Output recorded from ${version} and python3's zipfile by
// scripts/record-info-zip.js — see there for the trees and the options.
// Do not edit by hand; run the script.
//
// Every recording is a list of entries, in the order they were given, with
// every field filled in, and the archive written for them, in base64.

export const bytesOf = ({ archive }) => Uint8Array.from(atob(archive), (c) => c.codePointAt(0))

`
writeFileSync(OUT, `${header}export const RECORDINGS = ${JSON.stringify(recordings, null, 2)}\n`)
console.log(`recorded ${recordings.length} cases into ${OUT.pathname}`)
