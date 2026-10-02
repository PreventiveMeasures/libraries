// A gem's name, as RubyGems takes one, and its platform, as Gem::Platform
// reads one and writes it back: RubyGems 3 and 4 each their own way.

// Letters, digits, `.`, `-` and `_`, a letter among them, and none of the
// three others first: Gem::SpecificationPolicy#validate_name.
export const isGemName = (name) => /^[A-Za-z\d][\w.-]*$/u.test(name) && /[A-Za-z]/u.test(name)

// Ruby's String#split on `-`, which drops the empty strings at the end.
function split(text) {
  const parts = text.split('-')
  while (parts.at(-1) === '') parts.pop()
  return parts
}

const none = () => undefined

// Gem::Platform#initialize's reading of the OS, in its order, of RubyGems 3
// and of 4, which reads all after the CPU as the OS, and takes a `-` before
// its version; each test as unanchored as RubyGems has it. Of a platform of
// one part, mswin32 is of the x86.
const OSES = {
  3: [
    [/aix(\d+)?/u, 'aix'],
    [/cygwin/u, 'cygwin', none],
    [/darwin(\d+)?/u, 'darwin'],
    [/^macruby$/u, 'macruby', none],
    [/freebsd(\d+)?/u, 'freebsd'],
    [/^(?:java|jruby)$/u, 'java', none],
    [/^java([\d.]*)/u, 'java'],
    [/^dalvik(\d+)?$/u, 'dalvik'],
    [/^dotnet$/u, 'dotnet', none],
    [/^dotnet([\d.]*)/u, 'dotnet'],
    [/linux-?(\w+)?/u, 'linux'],
    [/mingw32/u, 'mingw32', none],
    [/mingw-?(\w+)?/u, 'mingw'],
    [/(mswin\d+)(_(\d+))?/u, undefined, (m) => m[3]],
    [/netbsdelf/u, 'netbsdelf', none],
    [/openbsd(\d+\.\d+)?/u, 'openbsd'],
    [/solaris(\d+\.\d+)?/u, 'solaris'],
    [/wasi/u, 'wasi', none],
    [/^(\w+_platform)(\d+)?/u, undefined, (m) => m[2]],
  ],
  4: [
    [/aix-?(\d+)?/u, 'aix'],
    [/cygwin/u, 'cygwin', none],
    [/darwin-?(\d+)?/u, 'darwin'],
    [/^macruby$/u, 'macruby', none],
    [/^macruby-?(\d+(?:\.\d+)*)?/u, 'macruby'],
    [/freebsd-?(\d+)?/u, 'freebsd'],
    [/^(?:java|jruby)$/u, 'java', none],
    [/^java-?(\d+(?:\.\d+)*)?/u, 'java'],
    [/^dalvik-?(\d+)?$/u, 'dalvik'],
    [/^dotnet$/u, 'dotnet', none],
    [/^dotnet-?(\d+(?:\.\d+)*)?/u, 'dotnet'],
    [/linux-?(\w+)?/u, 'linux'],
    [/mingw32/u, 'mingw32', none],
    [/mingw-?(\w+)?/u, 'mingw'],
    [/(mswin\d+)(?:[_-](\d+))?/u, undefined, (m) => m[2]],
    [/netbsdelf/u, 'netbsdelf', none],
    [/openbsd-?(\d+\.\d+)?/u, 'openbsd'],
    [/solaris-?(\d+\.\d+)?/u, 'solaris'],
    [/wasi/u, 'wasi', none],
    [/^(\w+_platform)-?(\d+)?/u, undefined, (m) => m[2]],
  ],
}

// [os, version] as `rubygems` reads them, and the CPU a lone mswin32 is of.
function readOs(os, rubygems) {
  for (const [pattern, name, version = (m) => m[1]] of OSES[rubygems]) {
    const match = os === undefined ? null : pattern.exec(os)
    if (match === null) continue
    const named = name ?? match[1]
    return [named, version(match), /^mswin\d*32$/u.test(named) ? 'x86' : undefined]
  }
  return ['unknown', undefined, undefined]
}

// The CPU and what follows, as RubyGems 3 splits a platform: x86_64-linux-gnu
// with its libc a part of the OS, and darwin-23 with its version apart.
function split3(text) {
  const parts = split(text)
  // RubyGems tests /\d+(\.\d+)?$/, which a part takes where it ends in a
  // digit, and which a regex engine tries from every digit.
  if (parts.length > 2 && !/\d$/u.test(parts.at(-1))) {
    const extra = parts.pop()
    parts[parts.length - 1] += `-${extra}`
  }
  const cpu = parts.shift()
  if (parts.length === 2 && /^\d+(?:\.\d+)?$/u.test(parts[1])) return { cpu, os: parts[0], version: parts[1] }
  return { cpu, os: parts[0] }
}

// RubyGems 4: the CPU, and all after it, less any `-` at the end.
function split4(text) {
  let end = text.length
  while (text[end - 1] === '-') end--
  const trimmed = text.slice(0, end)
  const sep = trimmed.indexOf('-')
  return sep === -1 ? { cpu: trimmed || undefined } : { cpu: trimmed.slice(0, sep), os: trimmed.slice(sep + 1) }
}

// [cpu, os, version] as Gem::Platform.new(text) of RubyGems 3.4 to 3.6, or
// of 4, reads them; each undefined where there is none. `ruby` and
// `current`, which it reads as no platform and as the host's, are not
// taken here.
function platformParts(text, rubygems) {
  const { cpu, os, version } = rubygems === 3 ? split3(text) : split4(text)
  const x86 = cpu !== undefined && /i\d86/u.test(cpu) ? 'x86' : cpu
  if (version !== undefined) return [x86, os, version]
  // A lone part is the OS, as `java` is.
  const [name, osVersion, lone] = readOs(os ?? cpu, rubygems)
  return [os === undefined ? lone : x86, name, osVersion]
}

// Gem::Platform#to_s: the parts there are, `-` between them, or of a lone
// OS, RubyGems 4 none.
export function platformOf(text, rubygems) {
  const parts = platformParts(text, rubygems)
  return parts.filter((part) => part !== undefined).join(rubygems === 4 && parts[0] === undefined ? '' : '-')
}

// A platform as RubyGems writes one: what RubyGems 3 and 4 both read it as,
// written back the same, and so the platform a gem's file is named by.
export const isPlatform = (text) => text !== 'ruby' && text !== 'current' && /^[\w.-]+$/u.test(text) && platformOf(text, 3) === text && platformOf(text, 4) === text

// Gem::Platform#normalized_linux_version: a libc less a `gnu` at its start
// and an `eabi` or `eabihf` at its end; undefined where none is left.
function libcOf(version) {
  const rest = version?.replace(/^gnu/u, '').replace(/eabi(?:hf)?$/u, '')
  return rest === '' ? undefined : rest
}

// The keys of every CPU of an OS, and of every ARM: RubyGems 3.4 takes a
// gem of `arm` for any CPU of `arm` at its start, and 3.5 and later for
// one of a version, `armv7l`.
const ALL = Symbol('all')
const ARM = Symbol('arm')

// Platforms as what a gem's is held to: by OS, then by CPU, and of all and
// of the ARMs, the versions there are, and the libcs of them.
export function platformSet(platforms) {
  const byOs = new Map()
  for (const platform of platforms) {
    if (platform === 'ruby') continue
    const [cpu, os, version] = platformParts(platform, 3)
    const cpus = byOs.get(os) ?? byOs.set(os, new Map()).get(os)
    for (const key of [cpu, ALL, ...(cpu?.startsWith('arm') ? [ARM] : [])]) {
      const locked = cpus.get(key) ?? cpus.set(key, { versions: new Set(), libcs: new Set() }).get(key)
      locked.versions.add(version)
      locked.libcs.add(libcOf(version))
    }
  }
  return byOs
}

// Whether a gem's version of its OS is one of `locked` takes, as RubyGems
// older than 3.3.23, or since, compares them: where either is none, or both
// the same; or of Linux, the same libc but for `gnu` and `eabi`, or a musl
// one of the gem's, `musleabihf` of `eabihf`.
function takesVersion(locked, os, version) {
  if (locked === undefined) return false
  if (version === undefined || locked.versions.has(undefined) || locked.versions.has(version)) return true
  return os === 'linux' && (locked.libcs.has(libcOf(version)) || ['musl', 'musleabi', 'musleabihf'].some((libc) => locked.versions.has(`${libc}${version}`)))
}

// The platform Bundler 2.2 takes a gem as of too, of its OS's version
// none, where GemHelpers.generic has one: [cpu, os].
function genericOf(cpu, os) {
  if (os === 'java' || os === 'mswin64') return [undefined, os]
  if (os === 'mswin32' && cpu === 'x86') return [cpu, os]
  if (os === 'mingw32') return [cpu === 'universal' || cpu === 'x64' ? cpu : cpu === 'x86_64' ? 'x64' : 'x86', os]
  return undefined
}

// Whether a platform of these parts is one of a set takes, as
// Gem::Platform#=== matches them: of one OS, a CPU that takes it, any
// where one is none or universal, an ARM any ARM, and a version that takes
// it; or of a universal mingw and any mingw.
function takes(set, cpu, os, version) {
  const cpus = set.get(os)
  const keys = cpu === undefined || cpu === 'universal' ? [ALL] : [cpu, undefined, 'universal', ...(cpu === 'arm' ? [ARM] : [])]
  if (cpus !== undefined && keys.some((key) => takesVersion(cpus.get(key), os, version))) return true
  return os.startsWith('mingw') && ['mingw', 'mingw32'].some((name) => set.get(name)?.has(cpu === 'universal' ? ALL : 'universal'))
}

// Whether Bundler may install a gem of `platform` for one of a set: as
// RubyGems takes it, or Bundler 2.2 its generic platform.
export function platformServed(set, platform) {
  const [cpu, os, version] = platformParts(platform, 3)
  const generic = genericOf(cpu, os)
  return takes(set, cpu, os, version) || (generic !== undefined && takes(set, ...generic, undefined))
}
