// Gem::Platform as RubyGems 3.5 to 4.0 read and match one, and the
// platform Bundler 2.5 to 4.0 take a locked gem of for a machine: the one
// installable there whose platform is the most specific to it.

const none = () => undefined

// Ruby's String#split on `-`, which drops the empty strings at the end.
function split(text) {
  const parts = text.split('-')
  while (parts.at(-1) === '') parts.pop()
  return parts
}

// Gem::Platform#initialize's reading of the OS, unanchored as RubyGems has
// it: of RubyGems to 3.6, and of 3.7 on, which take a `-` before a version.
const OSES = {
  old: [
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
  new: [
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

function readOs(os, oses) {
  if (os === undefined) return ['unknown', undefined, undefined]
  for (const [pattern, name, version = (m) => m[1]] of oses) {
    const match = pattern.exec(os)
    if (match === null) continue
    const named = name ?? match[1]
    return [named, version(match), /^mswin\d*32$/u.test(named) ? 'x86' : undefined]
  }
  return ['unknown', undefined, undefined]
}

function splitOld(text) {
  const parts = split(text)
  if (parts.length > 2 && !/\d$/u.test(parts.at(-1))) {
    const extra = parts.pop()
    parts[parts.length - 1] += `-${extra}`
  }
  const cpu = parts.shift()
  if (parts.length === 2 && /^\d+(?:\.\d+)?$/u.test(parts[1])) return { cpu, os: parts[0], version: parts[1] }
  return { cpu, os: parts[0] }
}

function splitNew(text) {
  let end = text.length
  while (text[end - 1] === '-') end--
  const trimmed = text.slice(0, end)
  const sep = trimmed.indexOf('-')
  return sep === -1 ? { cpu: trimmed || undefined } : { cpu: trimmed.slice(0, sep), os: trimmed.slice(sep + 1) }
}

// [cpu, os, version] as Gem::Platform.new(text) reads them, each undefined
// where there is none.
function readParts(text, reading) {
  const { cpu, os, version } = reading === 'old' ? splitOld(text) : splitNew(text)
  const x86 = cpu !== undefined && /i\d86/u.test(cpu) ? 'x86' : cpu
  if (version !== undefined) return [x86, os, version]
  const [name, osVersion, lone] = readOs(os ?? cpu, OSES[reading])
  return [os === undefined ? lone : x86, name, osVersion]
}

const written = ([cpu, os, version]) => [cpu, os, version].filter((part) => part !== undefined).join('-')

// A platform both readings take as written, so that each release matches
// it alike: what @preventive/lockfile holds a lockfile's to.
export function parsePlatform(text) {
  if (text === 'ruby' || !/^[\w.-]+$/u.test(text)) return undefined
  const [old, now] = [readParts(text, 'old'), readParts(text, 'new')]
  if (written(old) !== text || written(now) !== text || old.some((part, i) => part !== now[i])) return undefined
  const [cpu, os, version] = old
  return { cpu, os, version }
}

function linuxVersion(version) {
  if (version === undefined) return undefined
  const rest = version.replace(/^gnu/u, '').replace(/eabi(?:hf)?$/u, '')
  return rest === '' ? undefined : rest
}

const isUniversal = (cpu) => cpu === undefined || cpu === 'universal'

// Gem::Platform#===, `gem` the gem's platform and `machine` the one it is
// installed on, which it is not commutative in.
export function matches(gem, machine) {
  if ((gem.cpu === 'universal' || machine.cpu === 'universal') && gem.os.startsWith('mingw') && machine.os.startsWith('mingw')) return true
  const cpu = isUniversal(gem.cpu) || isUniversal(machine.cpu) || gem.cpu === machine.cpu || (gem.cpu === 'arm' && machine.cpu.startsWith('armv'))
  if (!cpu || gem.os !== machine.os) return false
  if (gem.os !== 'linux' && (gem.version === undefined || machine.version === undefined)) return true
  if (gem.os === 'linux' && (linuxVersion(gem.version) === linuxVersion(machine.version) || ['musl', 'musleabi', 'musleabihf'].some((libc) => `${libc}${gem.version ?? ''}` === machine.version))) return true
  return gem.version === machine.version
}

const same = (a, b) => a.cpu === b.cpu && a.os === b.os && a.version === b.version

// Bundler's platform_specificity_match: -1 for the very platform, and the
// ruby platform last.
function specificity(gem, machine) {
  if (gem === 'ruby') return 1_000_000
  if (same(gem, machine)) return -1
  const os = gem.os === machine.os ? 0 : 1
  const cpu = gem.cpu === machine.cpu || (gem.cpu === 'arm' && String(machine.cpu).startsWith('arm')) ? 0 : isUniversal(gem.cpu) ? 1 : 2
  const version = gem.version === machine.version ? 0 : gem.version === undefined ? 1 : 2
  return os + cpu * 10 + version * 100
}

const installable = (platform, machine) => platform === 'ruby' || matches(platform, machine)

// Of `candidates`, the one most specific to `machine` of those installable
// there; two as specific are `tied`, as 2.5 and 2.6 sort them unstably.
export function bestFor(candidates, machine) {
  const scored = candidates.filter(({ platform }) => installable(platform, machine)).map((candidate) => [specificity(candidate.platform, machine), candidate])
  if (scored.length === 0) return { best: undefined }
  const least = Math.min(...scored.map(([score]) => score))
  const best = scored.filter(([score]) => score === least).map(([, candidate]) => candidate)
  return best.length === 1 ? { best: best[0] } : { tied: best }
}

// `machine` among PLATFORMS, as Bundler finds it rather than add it: by
// `ruby`, itself, or one matching it both ways, as 2.5 and 2.6 differ.
export const isLocked = (platforms, machine) => platforms.some((platform) => platform === 'ruby' || same(platform, machine) || (matches(platform, machine) && matches(machine, platform)))
