// Stage 3: a downloaded pod's prepare_command, run as CocoaPods runs it, by bash in the pod's directory under
// `set -e`, CDPATH unset and COCOAPODS_VERSION set. No hash holds what it makes, so only `allowed` pods run one.

import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PodError, quote } from '../error.js'

// Specification#prepare_command as PodSourcePreparer runs it: less its indentation and its last line break.
function scriptOf(command) {
  const lines = command.split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/u.exec(line)[0].length))
  return `\nset -e\n${lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n').replace(/\r?\n$|\r$/u, '')}`
}

// CocoaPods runs a local pod's prepare_command in it at each installation; a pod by :path is the project's own
// files, which no podspec's script is run in.
export function refuseLocal(name, command) {
  if (typeof command === 'string') throw new PodError('its podspec has a prepare_command, and the pod is one by :path, which is used where it is: CocoaPods would run the script in the pod\'s own directory at each installation, and none is run there here. The prepare_command has to be taken out of the podspec, and what it makes be in the pod already', `pods[${quote(name)}]`)
}

function runPrepare(name, command, dir, allowed, version) {
  const where = `pods[${quote(name)}]`
  if (!allowed.includes(name)) throw new PodError('its podspec has a prepare_command, a script CocoaPods runs in the pod: to run it, name the pod in `prepareCommands` of pod.config.json', where)
  const { CDPATH: _unset, ...env } = process.env
  const result = spawnSync('bash', ['-c', scriptOf(command)], { cwd: dir, env: { ...env, COCOAPODS_VERSION: version }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw new PodError('bash cannot be run for its prepare_command', where, { cause: result.error })
  if (result.status !== 0) throw new PodError(`its prepare_command failed, with status ${result.status ?? result.signal}:\n${result.stderr.trim()}`, where)
}

// What a directory holds, by paths from it, as deptree takes a download.
function read(dir, prefix, contents) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) contents.links.set(path, readlinkSync(full))
    else if (entry.isDirectory()) {
      contents.dirs.push(path)
      read(full, `${path}/`, contents)
    } else if (entry.isFile()) contents.files.set(path, { data: readFileSync(full), mode: lstatSync(full).mode & 0o777 })
    else throw new PodError(`its prepare_command left ${quote(path)}, which is no file, directory or link`)
  }
  return contents
}

// deptree's `prepare`: the download written out, the command run in it, and the result read back. `allowed` are
// the config's `prepareCommands`, `version` the lockfile's CocoaPods.
export function prepareDownload(allowed, version) {
  return ({ name, command, contents }) => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-prepare-'))
    try {
      for (const path of contents.dirs) mkdirSync(join(dir, path), { recursive: true })
      for (const [path, { data, mode }] of contents.files) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), data)
        chmodSync(join(dir, path), mode)
      }
      for (const [path, target] of contents.links) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        symlinkSync(target, join(dir, path))
      }
      runPrepare(name, command, dir, allowed, version)
      return read(dir, '', { dirs: [], files: new Map(), links: new Map() })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
