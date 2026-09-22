import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pack } from '../index.js'
import { assertBytes, utf8 } from './helpers.js'

// The recordings say what GNU tar wrote once; this asks the GNU tar on the
// machine, when there is one, to read what pack() writes now and to write
// the same tree back. Skipped where tar is not GNU's — the tests above
// carry the package everywhere else.

const version = (() => {
  try {
    return execFileSync('tar', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')[0]
  } catch {
    return null
  }
})()
const gnu = version?.startsWith('tar (GNU tar)') ?? false

const T = 1577836800
const LONGDIR = 'd'.repeat(120)
const LONG = `${LONGDIR}/${'f'.repeat(90)}`
const ENTRIES = [
  { name: 'a.txt', data: utf8('hello\n'), mtime: T },
  { name: 'dir', type: 'directory', mtime: T },
  { name: 'dir/b.bin', data: Uint8Array.from({ length: 1000 }, (_, i) => i % 251), mtime: T, mode: 0o600 },
  { name: 'dir/empty', mtime: T },
  { name: 'link', type: 'symlink', linkname: 'a.txt', mtime: T },
  { name: 'hard', type: 'link', linkname: 'a.txt', mtime: T },
  { name: 'ü.txt', data: utf8('x'), mtime: T },
  { name: LONGDIR, type: 'directory', mtime: T },
  { name: LONG, data: utf8('long'), mtime: T },
]

// ustar can split the long file's name at its slash, but has nowhere to
// put the long directory's.
const entriesFor = (format) => (format === 'ustar' ? ENTRIES.filter((e) => e.name !== LONGDIR) : ENTRIES)

// What tar lists: directories with their slash.
const listed = (entries) => entries.map((e) => (e.type === 'directory' ? `${e.name}/` : e.name))

describe('GNU tar reads what pack writes', { skip: gnu ? false : 'GNU tar is not on the PATH' }, () => {
  for (const format of ['gnu', 'ustar', 'pax']) {
    it(`extracts a ${format} archive, and writes it back the same`, () => {
      const root = mkdtempSync(join(tmpdir(), 'tar-live-'))
      try {
        const entries = entriesFor(format)
        const bytes = pack(entries, { format, blocking: 1 })
        const file = join(root, 'archive.tar')
        writeFileSync(file, bytes)
        assert.deepEqual(execFileSync('tar', ['-tf', file, '--quoting-style=literal']).toString().split('\n').filter(Boolean), listed(entries))
        const out = join(root, 'out')
        execFileSync('mkdir', [out])
        execFileSync('tar', ['-xpf', file, '-C', out, '--no-same-owner'])
        assert.equal(readFileSync(join(out, 'a.txt'), 'utf8'), 'hello\n')
        assert.equal(readFileSync(join(out, 'hard'), 'utf8'), 'hello\n')
        assert.equal(statSync(join(out, 'hard')).ino, statSync(join(out, 'a.txt')).ino)
        assert.equal(readlinkSync(join(out, 'link')), 'a.txt')
        assert.equal(statSync(join(out, 'dir/b.bin')).mode & 0o777, 0o600)
        assert.equal(statSync(join(out, 'dir/b.bin')).size, 1000)
        assert.equal(lstatSync(join(out, 'a.txt')).mtimeMs, T * 1000)
        assert.equal(readFileSync(join(out, LONG), 'utf8'), 'long')
        assert.equal(readFileSync(join(out, 'ü.txt'), 'utf8'), 'x')
        const args = [`--format=${format === 'pax' ? 'posix' : format}`, '-b', '1', '--no-recursion', '--owner=0', '--group=0', '--numeric-owner']
        if (format === 'pax') args.push('--pax-option=delete=atime,delete=ctime')
        const again = execFileSync('tar', [...args, '-cf', '-', '--', ...entries.map((e) => e.name)], { cwd: out })
        assertBytes(bytes, new Uint8Array(again), `the bytes ${version} writes for the same tree`)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
