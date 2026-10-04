import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fromZip } from '../src/composer/extract.js'
import { rawZip } from './registry.js'

const decoder = new TextDecoder()
const WHERE = 'packages["a/b"]'

// What unzip extracts, as `path: mode` or `path -> target`, and the
// directories it sets a mode of.
async function extracted(entries) {
  const { dirs, files, links, modes } = await fromZip(rawZip(entries), WHERE)
  return {
    dirs: [...dirs].toSorted(),
    files: Object.fromEntries([...files].map(([path, { data, mode }]) => [path, `${mode.toString(8)} ${decoder.decode(data)}`])),
    links: Object.fromEntries(links),
    modes: Object.fromEntries([...modes].map(([path, mode]) => [path, mode.toString(8)])),
  }
}

describe('fromZip, as unzip extracts', () => {
  it('keeps a mode made on Unix but its special bits, with no umask, and its links', async () => {
    assert.deepEqual(await extracted([
      { name: 'top/', mode: 0o40700 },
      { name: 'top/a', data: 'a', mode: 0o100644 },
      { name: 'top/group', data: 'g', mode: 0o100775 },
      { name: 'top/suid', data: 's', mode: 0o104755 },
      { name: 'top/sub/', mode: 0o40777 },
      { name: 'top/sub/link', data: '../a', mode: 0o120777 },
    ]), { dirs: ['sub'], files: { a: '644 a', group: '775 g', suid: '755 s' }, links: { 'sub/link': '../a' }, modes: { '': '700', sub: '777' } })
  })

  it('writes a link made on Unix with no target as an empty file of its mode, as no link can have none', async () => {
    assert.deepEqual(await extracted([
      { name: 'top/', mode: 0o40755 },
      { name: 'top/none', mode: 0o120777 },
      { name: 'top/group', mode: 0o120775, deflate: true },
      { name: 'top/suid', mode: 0o124755 },
      { name: 'top/link', data: 'none', mode: 0o120777 },
    ]), { dirs: [], files: { none: '777 ', group: '775 ', suid: '755 ' }, links: { link: 'none' }, modes: {} })
    // Not the bytes it was given: those are left as they were.
    const zip = rawZip([{ name: 'none', mode: 0o120777 }])
    const before = Uint8Array.from(zip)
    await fromZip(zip, WHERE)
    assert.deepEqual(zip, before)
  })

  it('reads the DOS attributes of what MS-DOS made, with the umask taken off, but for a Unix mode that agrees with them, and makes no link of it', async () => {
    assert.deepEqual(await extracted([
      { name: 'plain', data: 'p', system: 0, attributes: 0x20 },
      { name: 'none', data: 'n', system: 0, attributes: 0 },
      { name: 'read-only', data: 'r', system: 0, attributes: 0x21 },
      { name: 'dir/', system: 0, attributes: 0x10 },
      { name: 'agrees', data: 'k', system: 0, attributes: (0o100600 * 0x10000) | 0x20 },
      { name: 'differs', data: 'd', system: 0, attributes: (0o100777 * 0x10000) | 0x20 },
      { name: 'ntfs', data: 'w', system: 11, attributes: (0o100600 * 0x10000) | 0x20 },
      { name: 'not-a-link', data: 'a', system: 0, attributes: 0o120777 * 0x10000 },
    ]), { dirs: ['dir'], files: { plain: '644 p', none: '644 n', 'read-only': '444 r', agrees: '600 k', differs: '644 d', ntfs: '644 w', 'not-a-link': '644 a' }, links: {}, modes: {} })
  })

  it('moves the one directory at the top into place, .DS_Store aside, and nothing else', async () => {
    assert.deepEqual((await extracted([{ name: 'top/a', data: 'a' }, { name: '.DS_Store', data: 'x' }])).files, { a: '644 a' })
    assert.deepEqual((await extracted([{ name: 'top/a', data: 'a' }, { name: 'other/b', data: 'b' }])).files, { 'top/a': '644 a', 'other/b': '644 b' })
    assert.deepEqual((await extracted([{ name: 'file', data: 'f' }])).files, { file: '644 f' })
    assert.deepEqual((await extracted([{ name: '.DS_Store/', mode: 0o40755 }, { name: 'top/a', data: 'a' }])).dirs, [])
  })

  it('refuses what unzip asks about or reads otherwise', async () => {
    const refusals = [
      [[{ name: 'a', data: '1' }, { name: 'a', data: '1' }], /"a": a name twice in the zip, which unzip asks whether to replace/u],
      [[{ name: 'café', data: 'c' }], /a name not flagged UTF-8/u],
      [[{ name: 'a', data: 'a', system: 3, attributes: 0 }], /an entry unzip reads no mode of/u],
      [[{ name: 'a', data: 'a', system: 19, attributes: 0x20 }], /an entry unzip reads no mode of/u],
      [[{ name: 'top', data: 'elsewhere', mode: 0o120777 }], /holds the link "top" alone/u],
      [[{ name: 'top/', mode: 0o40755 }, { name: 'top/out', data: '../x', mode: 0o120777 }], /"out" links out of the package/u],
      [[{ name: '../x', data: 'x' }], /its zip cannot be read/u],
    ]
    for (const [entries, message] of refusals) {
      await assert.rejects(fromZip(rawZip(entries), WHERE), (error) => error.name === 'DeptreeError' && error.message.startsWith(WHERE) && message.test(error.message), JSON.stringify(entries))
    }
    // Flagged UTF-8, the same name is taken.
    assert.deepEqual((await extracted([{ name: 'café', data: 'c', flags: 0x0800 }])).files, { 'café': '644 c' })
  })
})
