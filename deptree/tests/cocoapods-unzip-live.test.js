import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'
import { DeptreeError } from '../src/error.js'
import { portExtract, random, rawZipCaseOf, sorted, zipCaseOf } from './cocoapods-archives.js'

// The unzip on the machine, where it is Info-ZIP's, against the port's
// reading of a zip: each extracted as RemoteFile has it extracted, `unzip
// file.zip -d <dir>` in the directory the zip was downloaded into, with
// nothing on stdin to answer a question, under a umask of 0o022, and
// listed. Where unzip exits with 0, the port has to list the same or refuse
// the zip; where it does not, which fails `pod install`, the port has to
// refuse it. Needs no Ruby, as the differential test does, so it runs
// wherever unzip is. The seeds are fixed.

const version = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
const SKIP = !(version.status === 0 && /Info-ZIP/u.test(version.stdout)) && 'no Info-ZIP unzip on the PATH'

process.umask(0o022)

function listing(root) {
  return readdirSync(root, { recursive: true }).map((name) => {
    const path = name.split(sep).join('/')
    const st = lstatSync(join(root, name))
    if (st.isSymbolicLink()) return [path, 'symlink', readlinkSync(join(root, name))]
    return st.isDirectory() ? [path, 'directory'] : [path, 'file', st.mode & 0o7777]
  })
}

function unzipExtract({ archive }) {
  const root = mkdtempSync(join(tmpdir(), 'deptree-unzip-live-'))
  try {
    const file = join(root, 'file.zip')
    writeFileSync(file, Buffer.from(archive, 'base64'))
    const r = spawnSync('unzip', ['-q', file, '-d', root], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    if (r.status !== 0) return { error: r.status, output: `${r.stdout}${r.stderr}` }
    rmSync(file)
    return { entries: listing(root) }
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
      let failed = 0
      for (let i = 0; i < 300; i++) {
        const one = { ...await caseOf(r), flatten: false }
        const expected = unzipExtract(one)
        let ours
        try {
          ours = await portExtract(one)
        } catch (error) {
          if (!(error instanceof DeptreeError)) throw error
          refused++
          if (expected.error !== undefined) failed++
          continue
        }
        assert.equal(expected.error, undefined, `unzip exits with ${expected.error} on what the port takes: ${expected.output} ${JSON.stringify(one)}`)
        assert.deepEqual(sorted(ours), sorted(expected.entries), JSON.stringify(one))
        compared++
      }
      assert.ok(compared > 100 && refused > 20, `compared ${compared}, refused ${refused}, of which unzip failed on ${failed}`)
    })
  }
})
