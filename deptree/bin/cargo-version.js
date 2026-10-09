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

// What `call` returns, or undefined where it throws: a file not there, or
// not what it is read as.
const attempt = (call) => {
  try {
    return call()
  } catch {
    return undefined
  }
}
const read = (path) => attempt(() => readFileSync(path, 'utf8'))
const toml = (text) => attempt(() => parseToml(text))

// A toolchain file's channel, as rustup's parse_override_file reads it: a
// `rust-toolchain` of one line, as Rust's str::lines counts them, is that
// channel, any other file is TOML. Undefined for a path to a toolchain, or
// a file rustup fails on.
function channelOf(text, legacy) {
  if (legacy && text !== '' && !text.slice(0, -1).includes('\n')) return text.trim() || undefined
  const toolchain = toml(text)?.toolchain
  return toolchain?.path === undefined ? toolchain?.channel || undefined : undefined
}

// The toolchain rustup picks in `dir`, and why: RUSTUP_TOOLCHAIN; else, from
// `dir` up, the closest directory with an override `rustup override set`
// made, before a `rust-toolchain` file, before a `rust-toolchain.toml`;
// else the default toolchain.
function pickToolchain(dir, env, settings) {
  if (env.RUSTUP_TOOLCHAIN) return { toolchain: env.RUSTUP_TOOLCHAIN, by: 'by RUSTUP_TOOLCHAIN' }
  for (let at = dir; ; at = dirname(at)) {
    const override = settings.overrides?.[at]
    if (override !== undefined) return { toolchain: override, by: `by rustup override set in ${at}` }
    for (const name of ['rust-toolchain', 'rust-toolchain.toml']) {
      const text = read(join(at, name))
      if (text !== undefined) return { toolchain: channelOf(text, name === 'rust-toolchain'), by: `by ${join(at, name)}` }
    }
    if (dirname(at) === at) return { toolchain: settings.default_toolchain, by: 'the default toolchain' }
  }
}

// A toolchain's name as rustup's dist module reads one: a channel, a date,
// and its host, whole or in part, the rest of which rustup takes from its
// own. A name it does not take is of a toolchain linked by that name.
const TOOLCHAIN = /^(stable|beta|nightly|\d\.\d{1,3}(?:\.\d{1,2})?(?:-beta(?:\.\d{1,2})?)?)(?:-(\d{4}-\d{2}-\d{2}))?(?:-(.+))?$/u

// Whether each part of `part` is in `whole`, in order, as `gnu` and
// `x86_64-gnu` are in `x86_64-unknown-linux-gnu`.
function hostHas(whole, part) {
  const parts = whole.split('-')
  let at = 0
  return part.split('-').every((piece) => (at = parts.indexOf(piece, at) + 1) > 0)
}

// A release by its number is that version; another, as `stable`, `1.97` or
// `nightly-gnu`, the one recorded in the channel manifest of the one
// toolchain installed that the name stands for, read from its [pkg.rust]
// table alone: cargo's own table has the cargo crate's version.
function releaseOf(toolchain, rustupHome) {
  const [, channel, date, host] = TOOLCHAIN.exec(toolchain) ?? []
  if (channel === undefined) return undefined
  if (/^\d+\.\d+\.\d+$/u.test(channel)) return channel
  const installed = (attempt(() => readdirSync(join(rustupHome, 'toolchains'))) ?? []).filter((name) => {
    const [, otherChannel, otherDate, whole] = TOOLCHAIN.exec(name) ?? []
    return otherChannel === channel && otherDate === date && whole !== undefined && (host === undefined || hostHas(whole, host))
  })
  if (installed.length !== 1) return undefined
  const manifest = read(join(rustupHome, 'toolchains', installed[0], 'lib', 'rustlib', 'multirust-channel-manifest.toml')) ?? ''
  const at = manifest.indexOf('\n[pkg.rust]\n')
  const version = at === -1 ? undefined : toml(manifest.slice(at + 1).split(/\n(?=\[)/u)[0])?.pkg?.rust?.version
  return typeof version === 'string' ? version.split(' ')[0] : undefined
}

// By RUSTUP_HOME, else ~/.rustup.
function fromRustup(dir, env, home) {
  const rustupHome = env.RUSTUP_HOME ? resolve(env.RUSTUP_HOME) : isAbsolute(home) ? join(home, '.rustup') : undefined
  if (rustupHome === undefined) return undefined
  const { toolchain, by } = pickToolchain(dir, env, toml(read(join(rustupHome, 'settings.toml'))) ?? {})
  const version = typeof toolchain === 'string' ? releaseOf(toolchain, rustupHome) : undefined
  return version && { version, from: `rustup's ${toolchain}, ${by}` }
}

// The release `rustc -vV` gave the last build in `dir`, where cargo kept
// one alone.
function fromLastBuild(dir) {
  const info = attempt(() => JSON.parse(read(join(dir, 'target', '.rustc_info.json'))))
  const outputs = Object.values(info?.outputs ?? {}).map((output) => output?.stdout).filter((stdout) => typeof stdout === 'string' && stdout.startsWith('rustc '))
  const releases = new Set(outputs.map((stdout) => /^release: (\S+)$/mu.exec(stdout)?.[1]).filter(Boolean))
  return releases.size === 1 ? { version: [...releases][0], from: 'the rustc target/.rustc_info.json last built with' } : undefined
}

// Each version the files tell, with where from: none, one, or two that may
// differ.
export function cargoVersions(dir, env = process.env, home = homedir()) {
  const real = attempt(() => realpathSync(dir)) ?? resolve(dir)
  return [fromRustup(real, env, home), fromLastBuild(real)].filter(Boolean)
}
