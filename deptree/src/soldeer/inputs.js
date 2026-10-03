// What buildSoldeerTree takes, as text or read from the project's root.

import { DeptreeError, quote } from '../error.js'
import { checkHostKeys, checkLeftOut, checkProject, checkTexts, readText } from '../project.js'

export function checkHost(host) {
  checkHostKeys(host, ['soldeer', 'os'], 'soldeer and os')
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
    checkLeftOut({ foundry, soldeer }, 'all')
    const lock = readText(project, '/soldeer.lock', 'soldeer.lock')
    if (lock === undefined) throw new DeptreeError('the project has no soldeer.lock, without which Soldeer resolves each dependency anew')
    const foundryText = readText(project, '/foundry.toml', 'foundry.toml')
    return { lockfile: lock, foundry: foundryText, soldeer: foundryText === undefined ? readText(project, '/soldeer.toml', 'soldeer.toml') : undefined }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  checkTexts({ foundry, soldeer })
  return { lockfile, foundry, soldeer }
}
