import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { assert } from '#assert'
import { localStateFor } from './model.js'

// The scratch profile a browser is pointed at: where it goes, what it starts with, and making sure
// it is gone again — including when nothing gets to ask politely. index.js drives the browser
// inside it.

// Scratch profiles, so they can be removed again. Removing one never touches the model: the
// component tree inside it is a SYMLINK, and a recursive delete unlinks the link rather than
// following it.
const profiles = new Set()

// One directory of our own inside the temp dir, so the sweep reads it rather than everything the
// machine has put there. Per user, because the temp dir is not always: a shared /tmp takes the mode
// of whichever account made the root, and every other account gets EACCES inside it. Recomputed per
// call, so it follows TMPDIR.
const PROFILE_ROOT = `preventive-ai${process.getuid ? `-${process.getuid()}` : ''}`
const PROFILE_PREFIX = 'chrome-'
const profileRoot = () => join(tmpdir(), PROFILE_ROOT)

// Old enough that a profile made moments ago, before its owner marker was written, cannot be
// mistaken for one left behind.
const STALE_MS = 6 * 60 * 60 * 1000

// Lets another process sweeping the temp dir tell a profile in use from one left behind. Chrome
// ignores files it does not know at the profile root.
const OWNER_FILE = 'owner.pid'

// The guard on the single place this file deletes recursively: a profile holds a symlink into the
// user's model store. starts-with, so a path that merely has the name somewhere inside it is not
// one of ours.
export function isScratchProfile(dir) {
  if (typeof dir !== 'string' || !dir) return false
  // Resolved, then read as a name inside a directory. A prefix test on the raw string takes
  // <root>/chrome-x/../../elsewhere for one of ours, and rmSync resolves that traversal before
  // deleting.
  const path = resolve(dir)
  const name = basename(path)
  return dirname(path) === profileRoot() && name.startsWith(PROFILE_PREFIX) && name.length > PROFILE_PREFIX.length
}

export function removeProfileDir(dir) {
  assert(
    isScratchProfile(dir),
    `refusing to recursively delete a path that is not one of our scratch profiles (expected ${join(profileRoot(), PROFILE_PREFIX)}*): ${dir}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

// Take the shared directory too, once it is empty. Non-recursive, so a profile still in it — this
// process's or another's — is ENOTEMPTY and stays.
export function pruneProfileRoot() {
  try { rmdirSync(profileRoot()) } catch { /* still in use, or already gone */ }
}

export function dropProfile(dir) {
  profiles.delete(dir)
  try { removeProfileDir(dir) } catch { /* already gone, or not ours to touch */ }
  // Nothing of ours is left in this process to clean up after.
  if (profiles.size === 0) removeExitCleanup()
}

// Whether the process that made a profile is still running: 'alive', 'dead', or 'unknown' where
// there is no marker to read. EPERM means a process by that number exists and is someone else's,
// which is still alive.
function owner(dir) {
  let pid
  try { pid = Number(readFileSync(join(dir, OWNER_FILE), 'utf8')) } catch { return 'unknown' }
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  try { process.kill(pid, 0); return 'alive' } catch (err) { return err.code === 'EPERM' ? 'alive' : 'dead' }
}

// Best effort, on launch: clear what earlier runs left behind. A marker whose process is gone
// settles it outright — that profile is nobody's, however recent. Age only decides for a directory
// with no marker to go on, which is also the one made moments ago by a process still writing it.
export function sweepStaleProfiles() {
  const now = Date.now()
  let dirs = []
  try { dirs = readdirSync(profileRoot()).filter((n) => n.startsWith(PROFILE_PREFIX)) } catch { return }
  for (const name of dirs) {
    const dir = join(profileRoot(), name)
    if (profiles.has(dir)) continue
    try {
      const state = owner(dir)
      if (state === 'alive') continue
      if (state === 'dead' || now - statSync(dir).mtimeMs > STALE_MS) removeProfileDir(dir)
    } catch { /* in use, or gone */ }
  }
}

// rmSync is synchronous, which is what makes cleanup possible at all from here: an exit hook cannot
// await anything. Left in `profiles` rather than taken out of it, so the second pass below still
// knows what to look at.
function removeAllProfiles() {
  for (const dir of profiles) {
    try { removeProfileDir(dir) } catch { /* exiting anyway */ }
  }
  pruneProfileRoot()
}

// A crash, or a bare `node script.js`, never reaches closeProvider.
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

// Ctrl+C reaches no 'exit' handler on its own: with nothing listening, the default disposition ends
// the process and 'exit' is never emitted. Listening suppresses that, so the signal is handed back
// once the profiles are gone — an application listener then decides, and with none the default ends
// the process as it always would. Registered only while a profile of ours exists; owning a
// process's signals past that is not a library's to do.
function onSignal(signal) {
  removeAllProfiles()
  removeExitCleanup()
  // Only with nothing left listening. An application's own handler already had this signal; sending
  // it again would run that a second time. With ours gone and no other, re-sending is what restores
  // the default.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}

const signalHandlers = new Map(EXIT_SIGNALS.map((signal) => [signal, () => onSignal(signal)]))
let exitHookInstalled = false

function installExitCleanup() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', removeAllProfiles)
  for (const [signal, handler] of signalHandlers) process.on(signal, handler)
}

function removeExitCleanup() {
  if (!exitHookInstalled) return
  exitHookInstalled = false
  process.removeListener('exit', removeAllProfiles)
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
}

// The root, once it is certainly ours. The mode on mkdir only lands when this creates the
// directory, and the name is predictable: in a shared temp dir another account can get there first,
// with one it can write to or a symlink pointing at something else of ours. Refused rather than
// repaired — it is not ours to chmod, and the profile inside links to a real model store.
function ourProfileRoot() {
  const root = profileRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stats = lstatSync(root)
  assert(stats.isDirectory(), `refusing a scratch root that is not a directory: ${root}`)
  // Neither ownership nor mode means anything on Windows, where the temp dir is the account's own
  // to begin with.
  if (!process.getuid) return root
  assert(stats.uid === process.getuid(), `refusing a scratch root owned by another user: ${root}`)
  assert((stats.mode & 0o077) === 0, `refusing a scratch root that others can read or write: ${root}`)
  return root
}

// A profile for a browser to be pointed at, and everything that has to be true before one is: the
// strays cleared, an exit that takes this one with it, and the state Chrome reads at startup
// already in place.
export function claimProfile(modelDir, baseModel) {
  sweepStaleProfiles()
  installExitCleanup()
  const profile = mkdtempSync(join(ourProfileRoot(), PROFILE_PREFIX))
  profiles.add(profile)
  // Before anything slow, so a concurrent sweep can already see an owner.
  writeFileSync(join(profile, OWNER_FILE), String(process.pid))
  writeFileSync(join(profile, 'Local State'), JSON.stringify(localStateFor(modelDir, baseModel)))
  return profile
}
