// What buildBundlerTree takes: the machine, and the lockfile and the
// install path, given or read from the project's root.

import { DeptreeError, quote } from '../error.js'
import { UNSAFE, isInside } from '../mount.js'
import { checkHostKeys, checkProject, readUnlinked, typeOf } from '../project.js'
import { parsePlatform } from './platform.js'

// Before 2.5.12 Bundler installs no default gem of its Ruby; RubyGems before
// 3.5.8 keeps modes a umask drops, and before 3.5.15 takes an `arm` gem for
// any `arm*` CPU. CRuby's ruby_version is X.Y.0.
const BUNDLER = /^(?:2\.5\.(?:1[2-9]|[2-9]\d|[1-9]\d{2,})|2\.[67]\.(?:0|[1-9]\d*)|4\.0\.(?:0|[1-9]\d*))$/u
const RUBYGEMS = /^(?:3\.5\.(?:1[5-9]|[2-9]\d|[1-9]\d{2,})|3\.[67]\.(?:0|[1-9]\d*)|4\.0\.(?:0|[1-9]\d*))$/u
const RUBY = /^(3\.[0-4]|4\.0)\.(?:0|[1-9]\d*)$/u

export function checkHost(host) {
  checkHostKeys(host, ['bundler', 'rubygems', 'ruby', 'platform', 'os'], 'bundler, rubygems, ruby, platform and os')
  if (!BUNDLER.test(host.bundler)) throw new DeptreeError(`Bundler ${quote(host.bundler)} is not supported: only 2.5.12 to 2.7.x and 4.0.x are`, 'host.bundler')
  if (!RUBYGEMS.test(host.rubygems)) throw new DeptreeError(`RubyGems ${quote(host.rubygems)} is not supported: only 3.5.15 to 4.0.x are`, 'host.rubygems')
  const minor = RUBY.exec(host.ruby)?.[1]
  if (minor === undefined) throw new DeptreeError(`Ruby ${quote(host.ruby)} is not supported: only CRuby 3.0.0 to 4.0.x are, as RUBY_VERSION gives one`, 'host.ruby')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: RubyGems names and links files otherwise there', 'host.os')
  if (host.os !== 'linux' && host.os !== 'darwin') throw new DeptreeError(`${quote(host.os)} is not supported: only macOS and Linux are`, 'host.os')
  const machine = parsePlatform(host.platform)
  if (machine === undefined) throw new DeptreeError(`${quote(host.platform)} is no platform as Gem::Platform.local writes one`, 'host.platform')
  if (machine.os !== host.os) throw new DeptreeError(`${quote(host.platform)} is no platform of ${host.os}, as CRuby there has one`, 'host.platform')
  return { ...host, machine, scope: `ruby/${minor}.0` }
}

// A path Bundler expands under the project's root: within it, by
// segments, and no `~`, which it expands as a home directory.
function checkPath(path, where) {
  if (typeof path !== 'string') throw new TypeError('path must be a string, or left out')
  if (!isInside(path) || UNSAFE.test(path) || path.startsWith('~')) throw new DeptreeError(`${quote(path)} is not a path within the project, as it is read here`, where)
  return path
}

// `---`, then `KEY: "value"`, as `bundle config set --local` writes them;
// those passed over bear on no file installed, and any other may.
const PASSED_OVER = new Set(['BUNDLE_FROZEN', 'BUNDLE_DEPLOYMENT', 'BUNDLE_JOBS', 'BUNDLE_RETRY'])
const SETTING = /^([A-Z][A-Z\d_]*): (?:"([^"\\#]*)"|([^\s"'#][^"#]*))$/u
function readConfig(text) {
  const where = '.bundle/config'
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) return undefined
  if (lines[0] !== '---') throw new DeptreeError('expected `---` first, as Bundler writes it', where)
  let path
  for (const line of lines.slice(1)) {
    const m = SETTING.exec(line)
    if (m === null) throw new DeptreeError(`${quote(line)} is no setting as Bundler writes one`, where)
    if (m[1] === 'BUNDLE_PATH') path = checkPath(m[2] ?? m[3], `${where}: BUNDLE_PATH`)
    else if (!PASSED_OVER.has(m[1])) throw new DeptreeError('not supported: it may change what Bundler installs, and is not read here', `${where}: ${m[1]}`)
  }
  return path
}

// The Gemfile Bundler finds first, gems.rb before Gemfile, and its lockfile.
export function lockfileOf(project) {
  const gemfile = ['gems.rb', 'Gemfile'].find((name) => typeOf(project, `/${name}`) === 'file')
  if (gemfile === undefined) throw new DeptreeError('the project has no Gemfile, as gems.rb or Gemfile, without which Bundler installs nothing')
  return gemfile === 'gems.rb' ? 'gems.locked' : 'Gemfile.lock'
}

const DEFAULT_PATH = 'vendor/bundle'

// The install path in a project: `.bundle/config`'s BUNDLE_PATH, or else
// vendor/bundle.
function configuredPath(project) {
  const text = readUnlinked(project, '.bundle/config', 'Bundler')
  return text === undefined ? undefined : readConfig(text)
}
export const bundlePathOf = (project) => configuredPath(project) ?? DEFAULT_PATH

const LOCKFILE = 'lockfile must be the Gemfile.lock text, or left out where project is given'

export function inputsOf(options) {
  const { lockfile, project, path } = options
  if (path !== undefined) checkPath(path, 'path')
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    const file = lockfileOf(project)
    const text = readUnlinked(project, file, 'Bundler')
    if (text === undefined) throw new DeptreeError(`the project has no ${file}, without which Bundler resolves every gem anew`)
    const read = configuredPath(project)
    if (path !== undefined && read !== undefined && read !== path) throw new DeptreeError(`BUNDLE_PATH is ${quote(read)}, where Bundler installs, not ${quote(path)}`, '.bundle/config')
    return { lockfile: text, path: path ?? read ?? DEFAULT_PATH }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  return { lockfile, path: path ?? DEFAULT_PATH }
}

export function partialOf({ partial = false }) {
  if (typeof partial !== 'boolean') throw new TypeError('partial must be a boolean, or left out')
  return partial
}
