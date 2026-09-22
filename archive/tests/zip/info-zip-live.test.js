import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { zip } from '../../zip.js'
import { utf8 } from '../helpers.js'

// The recordings say what Info-ZIP wrote once; this asks the Info-ZIP and
// the python3 on the machine, when there are any, to read what zip()
// writes now.

const have = (command, args) => {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const unzipHere = have('unzip', ['-v'])
const pythonHere = have('python3', ['-c', 'import zipfile'])

const T = 1577836800
const ENTRIES = [
  { name: 'a.txt', data: utf8('hello hello hello hello\n'), mtime: T },
  { name: 'dir', type: 'directory', mtime: T },
  { name: 'dir/b.bin', data: new Uint8Array(3000).fill(0x62), mtime: T + 1, mode: 0o600 },
  { name: 'empty', mtime: T },
  { name: 'link', type: 'symlink', linkname: 'a.txt', mtime: T },
  { name: 'ü.txt', data: utf8('x'), mtime: T },
]

describe('Info-ZIP reads what zip writes', { skip: unzipHere ? false : 'unzip is not on the PATH' }, () => {
  for (const method of ['deflate', 'store']) {
    it(`tests and extracts a ${method} archive`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'zip-live-'))
      try {
        const file = join(root, 'archive.zip')
        writeFileSync(file, await zip(ENTRIES, { method }))
        execFileSync('unzip', ['-tqq', file])
        const out = join(root, 'out')
        // A UTF-8 locale, or unzip writes a non-ASCII name escaped.
        execFileSync('unzip', ['-qq', file, '-d', out], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C.UTF-8' } })
        assert.equal(readFileSync(join(out, 'a.txt'), 'utf8'), 'hello hello hello hello\n')
        assert.equal(statSync(join(out, 'dir/b.bin')).size, 3000)
        assert.equal(statSync(join(out, 'dir/b.bin')).mode & 0o777, 0o600)
        assert.equal(Math.round(statSync(join(out, 'dir/b.bin')).mtimeMs / 1000), T + 1)
        assert.equal(readlinkSync(join(out, 'link')), 'a.txt')
        assert.ok(lstatSync(join(out, 'link')).isSymbolicLink())
        assert.equal(readFileSync(join(out, 'ü.txt'), 'utf8'), 'x')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

describe('python3 reads what zip writes', { skip: pythonHere ? false : 'python3 with zipfile is not on the PATH' }, () => {
  it('finds nothing wrong, and the names and sizes it expects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zip-live-'))
    try {
      const file = join(root, 'archive.zip')
      writeFileSync(file, await zip(ENTRIES))
      const script = 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(f"{i.filename} {i.file_size} {i.external_attr >> 16:o}" for i in z.infolist()))'
      const listed = execFileSync('python3', ['-c', script, file]).toString().trim().split('\n')
      assert.deepEqual(listed, ['a.txt 24 100644', 'dir/ 0 40755', 'dir/b.bin 3000 100600', 'empty 0 100644', 'link 5 120777', 'ü.txt 1 100644'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
