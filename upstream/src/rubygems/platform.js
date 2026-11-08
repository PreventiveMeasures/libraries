// Gem::Platform's reading and writing of a platform, RubyGems 3 and 4 each
// their own way, ported from @preventive/lockfile.

// Ruby's String#split on `-`, which drops the empty strings at the end.
function split(text) {
  const parts = text.split('-')
  while (parts.at(-1) === '') parts.pop()
  return parts
}

const none = () => undefined

// Gem::Platform#initialize's OS patterns, in its order and as unanchored.
// RubyGems 4 reads all after the CPU as the OS, and a `-` before its version.
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
  if (os === undefined) return ['unknown', undefined, undefined]
  for (const [pattern, name, version = (m) => m[1]] of OSES[rubygems]) {
    const match = pattern.exec(os)
    if (match === null) continue
    const named = name ?? match[1]
    return [named, version(match), /^mswin\d*32$/u.test(named) ? 'x86' : undefined]
  }
  return ['unknown', undefined, undefined]
}

// RubyGems 3: x86_64-linux-gnu's libc is part of the OS, darwin-23's
// version apart.
function split3(text) {
  const parts = split(text)
  // RubyGems' /\d+(\.\d+)?$/, without a regex retried from every digit.
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

// [cpu, os, version] as Gem::Platform.new reads them, undefined where absent.
function platformParts(text, rubygems) {
  const { cpu, os, version } = rubygems === 3 ? split3(text) : split4(text)
  const x86 = cpu !== undefined && /i\d86/u.test(cpu) ? 'x86' : cpu
  if (version !== undefined) return [x86, os, version]
  // A lone part is the OS, as `java` is.
  const [name, osVersion, lone] = readOs(os ?? cpu, rubygems)
  return [os === undefined ? lone : x86, name, osVersion]
}

// Gem::Platform#to_s: RubyGems 4 puts no `-` in a platform without a CPU.
export function platformOf(text, rubygems) {
  const parts = platformParts(text, rubygems)
  return parts.filter((part) => part !== undefined).join(rubygems === 4 && parts[0] === undefined ? '' : '-')
}

// RubyGems keeps the CPU as written, so `..-linux` would round-trip: each
// part starts with a letter or digit, the first with a letter, and no `..`
// (cap ours).
const SHAPE = /^(?=.{1,128}$)(?!.*\.\.)[A-Za-z][\w.]*(?:-[\dA-Za-z][\w.]*)*$/u

// What RubyGems 3 and 4 both read back as written: the platform a gem's
// file is named by. `ruby` and `current` mean no platform and the host's.
export const isGemPlatform = (text) => typeof text === 'string' && SHAPE.test(text) && text !== 'ruby' && text !== 'current'
  && platformOf(text, 3) === text && platformOf(text, 4) === text
