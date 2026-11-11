// A pod's prepare_command, run as CocoaPods runs it: by bash, in the pod's directory, under `set -e`, with
// CDPATH unset and COCOAPODS_VERSION set. It is the podspec's own script, and what it makes of the download no
// hash holds; so it is run for no pod but those pod.config.json names in `prepareCommands`, and for none by
// :path, which load.js refuses with one.

import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PodError, quote } from './error.js'

// Specification#prepare_command as PodSourcePreparer takes it: its indentation and its last line break off.
function scriptOf(command) {
  const lines = command.split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/u.exec(line)[0].length))
  return `\nset -e\n${lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n').replace(/\r?\n$|\r$/u, '')}`
}

export function runPrepare(name, command, dir, config, version) {
  const where = `pods[${quote(name)}]`
  if (!config.prepareCommands.includes(name)) throw new PodError('its podspec has a prepare_command, a script CocoaPods runs in the pod: to run it, name the pod in `prepareCommands` of pod.config.json', where)
  const { CDPATH: _unset, ...env } = process.env
  const result = spawnSync('bash', ['-c', scriptOf(command)], { cwd: dir, env: { ...env, COCOAPODS_VERSION: version }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw new PodError('bash cannot be run for its prepare_command', where, { cause: result.error })
  if (result.status !== 0) throw new PodError(`its prepare_command failed, with status ${result.status ?? result.signal}:\n${result.stderr.trim()}`, where)
}

// What a directory holds, as deptree takes a download: by paths from it.
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

// deptree's `prepare`: the download written out, the command run in it, and what is there afterwards read back.
export function prepareDownload(config, version) {
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
      runPrepare(name, command, dir, config, version)
      return read(dir, '', { dirs: [], files: new Map(), links: new Map() })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
