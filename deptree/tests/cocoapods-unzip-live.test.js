import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DeptreeError } from '../src/error.js'
import { portExtract, random, rawZipCaseOf, sorted, zipCaseOf } from './cocoapods-archives.js'

// Info-ZIP's unzip on the machine, if any, against the port: `unzip file.zip
// -d <dir>` as RemoteFile runs it, with nothing on stdin, under a umask of
// 0o022. Needs no Ruby, as the differential test does. The seeds are fixed.

const version = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
const SKIP = !(version.status === 0 && /Info-ZIP/u.test(version.stdout)) && 'no Info-ZIP unzip on the PATH'

process.umask(0o022)

// Each directory made listable and removable on the way, as its mode is not
// compared.
function listing(root, prefix = '') {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return [[`${prefix}${name}`, 'symlink', readlinkSync(path)]]
    if (!st.isDirectory()) return [[`${prefix}${name}`, 'file', st.mode & 0o7777]]
    chmodSync(path, 0o700)
    return [[`${prefix}${name}`, 'directory'], ...listing(path, `${prefix}${name}/`)]
  })
}

function unzipExtract({ archive }) {
  const root = mkdtempSync(join(tmpdir(), 'deptree-unzip-live-'))
  try {
    writeFileSync(join(root, 'file.zip'), Buffer.from(archive, 'base64'))
    const r = spawnSync('unzip', ['-q', 'file.zip', '-d', root], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    const entries = listing(root).filter(([path]) => path !== 'file.zip')
    return r.status === 0 ? { entries } : { error: `${r.status}: ${r.stdout}${r.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the port, against unzip', { skip: SKIP }, () => {
  for (const [what, seed, caseOf] of [['as zip writes one', 13, zipCaseOf], ['with every field as given', 17, rawZipCaseOf]]) {
    it(`reads each zip ${what} as unzip extracts it, or refuses it, and refuses each unzip fails on`, async () => {
      const r = random(seed)
      let compared = 0
      let refused = 0
      for (let i = 0; i < 300; i++) {
        const one = { ...await caseOf(r), flatten: false }
        const expected = unzipExtract(one)
        let ours
        try {
          ours = await portExtract(one)
        } catch (error) {
          if (!(error instanceof DeptreeError)) throw error
          refused++
          continue
        }
        assert.equal(expected.error, undefined, `unzip fails on what the port takes: ${expected.error} ${JSON.stringify(one)}`)
        assert.deepEqual(sorted(ours), sorted(expected.entries), JSON.stringify(one))
        compared++
      }
      assert.ok(compared > 100 && refused > 20, `compared ${compared}, refused ${refused}`)
    })
  }
})
