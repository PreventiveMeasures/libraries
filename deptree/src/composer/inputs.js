// What buildComposerTree takes, as text or read from the project's root.

import { createClient } from '@preventive/upstream/github.js'
import { DeptreeError, quote } from '../error.js'
import { checkProject, readText } from '../project.js'

// Composer installs alike from 2.2, the long-term release, to 2.10: the
// same downloaders, installers and order of preference.
const RELEASE = /^2\.(?:[2-9]|10)\.(?:0|[1-9]\d*)$/u

export function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with composer, os and unzip')
  for (const key of ['composer', 'os']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  if (typeof host.unzip !== 'boolean') throw new TypeError('host.unzip must be true or false')
  if (!RELEASE.test(host.composer)) throw new DeptreeError(`Composer ${quote(host.composer)} is not supported: only 2.2.0 to 2.10 are`, 'host.composer')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: Composer extracts zips with 7-Zip and links bins with .bat files there', 'host.os')
  if (!host.unzip) throw new DeptreeError('a host without unzip is not supported: Composer extracts zips with PHP\'s ZipArchive there, which keeps no modes and no links', 'host.unzip')
  return { composer: host.composer, os: host.os }
}

function checkGitHub(github) {
  if (github === undefined) return createClient({ token: null })
  if (typeof github?.getRepoTarball !== 'function') throw new TypeError('github must be a client from @preventive/upstream/github.js, or left out')
  return github
}

const LOCKFILE = 'lockfile must be the composer.lock text, or left out where project is given'

export function inputsOf(options) {
  const { lockfile, composerJson, project } = options
  const github = checkGitHub(options.github)
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    if (composerJson !== undefined) throw new TypeError('composerJson must be left out where lockfile is: both are read from project')
    const read = { lockfile: readText(project, '/composer.lock', 'composer.lock'), composerJson: readText(project, '/composer.json', 'composer.json') }
    if (read.composerJson === undefined) throw new DeptreeError('the project has no composer.json, without which Composer installs nothing')
    if (read.lockfile === undefined) throw new DeptreeError('the project has no composer.lock, without which Composer resolves each package anew')
    return { ...read, github }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  if (typeof composerJson !== 'string') throw new TypeError('composerJson must be the composer.json text, which Composer reads beside the lockfile')
  return { lockfile, composerJson, github }
}
