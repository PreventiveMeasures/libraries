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

// Platforms as what a gem's is held to: by OS, the CPUs of each, and
// whether one is an ARM of a version, `armv7l`.
export function platformSet(platforms) {
  const byOs = new Map()
  for (const platform of platforms) {
    if (platform === 'ruby') continue
    const [cpu, os] = platformParts(platform, 3)
    if (!byOs.has(os)) byOs.set(os, { cpus: new Set(), armv: false })
    const entry = byOs.get(os)
    entry.cpus.add(cpu)
    entry.armv ||= cpu?.startsWith('armv') ?? false
  }
  return byOs
}

// Whether Bundler may install a gem of `platform` for one of a set, as
// Gem::Platform#=== matches them: of one OS, and a CPU that takes it, any
// where one is none or universal, an ARM any ARM of a version; or of a
// universal mingw and any mingw. Of the OS's version, which each RubyGems
// compares its own way, and Bundler's generic platforms take more of, it
// takes any.
export function platformServed(set, platform) {
  const [cpu, os] = platformParts(platform, 3)
  const { cpus, armv } = set.get(os) ?? { cpus: new Set(), armv: false }
  const anyCpu = cpu === undefined || cpu === 'universal' ? cpus.size > 0 : cpus.has(cpu) || cpus.has(undefined) || cpus.has('universal')
  if (anyCpu || (cpu === 'arm' && armv) || (cpu?.startsWith('armv') && cpus.has('arm'))) return true
  const mingws = ['mingw', 'mingw32'].map((name) => set.get(name)?.cpus).filter((others) => others !== undefined)
  return os.startsWith('mingw') && mingws.some((others) => cpu === 'universal' || others.has('universal'))
}
