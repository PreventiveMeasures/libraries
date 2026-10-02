// What buildSoldeerTree takes, as text or read from the project's root.

import { DeptreeError, quote } from '../error.js'
import { checkProject, readText } from '../project.js'

export function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with soldeer and os')
  for (const key of ['soldeer', 'os']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  if (host.soldeer !== '0.12.0') throw new DeptreeError(`Soldeer ${quote(host.soldeer)} is not supported: only Soldeer 0.12.0 is`, 'host.soldeer')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: Soldeer names folders otherwise there', 'host.os')
  return { soldeer: host.soldeer, os: host.os }
}

const LOCKFILE = 'lockfile must be the soldeer.lock text, or left out where project is given'

export function inputsOf(options) {
  const { lockfile, foundry, soldeer, project } = options
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    for (const [name, value] of Object.entries({ foundry, soldeer })) {
      if (value !== undefined) throw new TypeError(`${name} must be left out where lockfile is: all are read from project`)
    }
    const lock = readText(project, '/soldeer.lock', 'soldeer.lock')
    if (lock === undefined) throw new DeptreeError('the project has no soldeer.lock, without which Soldeer resolves each dependency anew')
    const foundryText = readText(project, '/foundry.toml', 'foundry.toml')
    return { lockfile: lock, foundry: foundryText, soldeer: foundryText === undefined ? readText(project, '/soldeer.toml', 'soldeer.toml') : undefined }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  for (const [name, value] of Object.entries({ foundry, soldeer })) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string, or left out`)
  }
  return { lockfile, foundry, soldeer }
}
