// The cargo that vendored a project, for bin/deptree.js alone, as files
// tell it, nothing run: the toolchain rustup picks in the project's
// directory, and the rustc the last build there ran, as cargo keeps it in
// target/.rustc_info.json. Running cargo instead would run the toolchain a
// project's rust-toolchain.toml names.

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { parseToml } from '@preventive/lockfile/toml.js'

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
const toml = (text) => {
  try {
    return parseToml(text)
  } catch {
    return undefined
  }
}
const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// As Rust's str::lines counts them: a last newline ends a line, and starts
// none.
const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

// A toolchain file's channel, as rustup's parse_override_file reads it: a
// `rust-toolchain` of one line is that channel, any other file is TOML.
// Undefined for a path to a toolchain, or a file rustup fails on.
function channelOf(text, legacy) {
  if (legacy && lineCount(text) === 1) return text.trim() || undefined
  const toolchain = toml(text)?.toolchain
  if (!isTable(toolchain) || toolchain.path !== undefined) return undefined
  return typeof toolchain.channel === 'string' && toolchain.channel !== '' ? toolchain.channel : undefined
}

// The toolchain rustup picks in `dir`, and why: RUSTUP_TOOLCHAIN; else, from
// `dir` up, the closest directory with an override `rustup override set`
// made, before a `rust-toolchain` file, before a `rust-toolchain.toml`;
// else the default toolchain. `toolchain` is undefined where a file names
// none rustup runs as a channel.
function pickToolchain(dir, env, settings) {
  if (env.RUSTUP_TOOLCHAIN) return { toolchain: env.RUSTUP_TOOLCHAIN, by: 'by RUSTUP_TOOLCHAIN' }
  const overrides = isTable(settings.overrides) ? settings.overrides : {}
  for (let at = dir; ; at = dirname(at)) {
    if (typeof overrides[at] === 'string') return { toolchain: overrides[at], by: `by rustup override set in ${at}` }
    const legacy = read(join(at, 'rust-toolchain'))
    const file = join(at, legacy === undefined ? 'rust-toolchain.toml' : 'rust-toolchain')
    const text = legacy ?? read(file)
    if (text !== undefined) return { toolchain: channelOf(text, legacy !== undefined), by: `by ${file}` }
    if (dirname(at) === at) break
  }
  return typeof settings.default_toolchain === 'string' ? { toolchain: settings.default_toolchain, by: 'the default toolchain' } : undefined
}

// A release named as one, `1.97.0` or with a host after it, is that version;
// another, as `stable` or `1.97`, the one its installed toolchain's channel
// manifest records, found by its name with the host rustup adds.
const RELEASE = /^(\d+\.\d+\.\d+)(?:-(?!beta)[a-z].*)?$/u

function releaseOf(toolchain, rustupHome, settings) {
  const named = RELEASE.exec(toolchain)?.[1]
  if (named !== undefined) return named
  const root = join(rustupHome, 'toolchains')
  let names
  try {
    names = readdirSync(root)
  } catch {
    return undefined
  }
  const host = typeof settings.default_host_triple === 'string' ? settings.default_host_triple : undefined
  const installed = names.includes(toolchain) ? [toolchain]
    : names.filter((name) => (host === undefined ? name.startsWith(`${toolchain}-`) && /^[a-z]/u.test(name.slice(toolchain.length + 1)) : name === `${toolchain}-${host}`))
  if (installed.length !== 1) return undefined
  const version = toml(read(join(root, installed[0], 'lib', 'rustlib', 'multirust-channel-manifest.toml')) ?? '')?.pkg?.rust?.version
  return typeof version === 'string' ? version.split(' ')[0] : undefined
}

// RUSTUP_HOME, else ~/.rustup.
function fromRustup(dir, env, home) {
  const rustupHome = env.RUSTUP_HOME ? resolve(env.RUSTUP_HOME) : isAbsolute(home) ? join(home, '.rustup') : undefined
  if (rustupHome === undefined) return undefined
  const settings = toml(read(join(rustupHome, 'settings.toml')) ?? '') ?? {}
  const picked = pickToolchain(dir, env, settings)
  const version = picked?.toolchain === undefined ? undefined : releaseOf(picked.toolchain, rustupHome, settings)
  return version === undefined ? undefined : { version, from: `rustup's ${picked.toolchain}, ${picked.by}` }
}

// The release `rustc -vV` gave the last build in `dir`, where cargo kept
// one alone.
function fromLastBuild(dir) {
  let info
  try {
    info = JSON.parse(read(join(dir, 'target', '.rustc_info.json')))
  } catch {
    return undefined
  }
  const outputs = isTable(info?.outputs) ? Object.values(info.outputs) : []
  const releases = new Set(outputs.map((output) => (typeof output?.stdout === 'string' && output.stdout.startsWith('rustc ') ? /^release: (\S+)$/mu.exec(output.stdout)?.[1] : undefined)).filter(Boolean))
  return releases.size === 1 ? { version: [...releases][0], from: 'the rustc target/.rustc_info.json last built with' } : undefined
}

// Each version the files tell, with where from: none, one, or two that may
// differ.
export function cargoVersions(dir, env = process.env, home = homedir()) {
  let real
  try {
    real = realpathSync(dir)
  } catch {
    real = resolve(dir)
  }
  return [fromRustup(real, env, home), fromLastBuild(real)].filter(Boolean)
}
