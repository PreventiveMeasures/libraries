// What CocoaPods reads of vendored binaries: whether a Mach-O file is a dylib, and an .xcframework's slices.

import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { PodError, quote } from './error.js'
import { parseXml } from './plist.js'
import { byBytes } from './xcconfig.js'

const MH_DYLIB = 6
const THIN = new Set([0xFEEDFACE, 0xFEEDFACF])
const FAT = new Set([0xCAFEBABE, 0xCAFEBABF])

// Whether `head` starts with a Mach-O header, of either byte order, of a dylib.
const isDylib = (head) => (THIN.has(head.readUInt32LE(0)) ? head.readUInt32LE(12) : THIN.has(head.readUInt32BE(0)) && head.readUInt32BE(12)) === MH_DYLIB

// LinkageAnalyzer.dynamic_binary?: a dylib, or a fat file whose first slice is one. A missing file is not.
export function isDynamic(path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const head = Buffer.alloc(24)
    if (readSync(fd, head, 0, head.length, 0) < 16) return false
    const magic = head.readUInt32BE(0)
    if (!FAT.has(magic)) return isDylib(head)
    const first = magic === 0xCAFEBABF ? Number(head.readBigUInt64BE(16)) : head.readUInt32BE(16)
    return readSync(fd, head, 0, 16, first) === 16 && isDylib(head)
  } finally {
    closeSync(fd)
  }
}

// Xcode::XCFramework: slices sorted by identifier, the type that of the first. `specName` names its intermediate
// directory. CocoaPods links and embeds it by its directory's name, so one holding a framework of another name,
// which CocoaPods writes all the same, is refused.
export function readXcframework(dir, specName, where) {
  let plist
  try {
    plist = parseXml(readFileSync(join(dir, 'Info.plist'), 'utf8'), where)
  } catch (error) {
    throw new PodError(`the Info.plist of ${quote(basename(dir))} cannot be read as an XML property list`, where, { cause: error })
  }
  const libraries = plist?.AvailableLibraries
  if (!Array.isArray(libraries) || libraries.length === 0) throw new PodError(`${quote(basename(dir))} holds no framework or library`, where)
  const slices = libraries.map((library) => {
    const path = join(dir, library.LibraryIdentifier, library.LibraryPath)
    const extension = extname(path)
    if (!['.framework', '.a', '.dylib'].includes(extension)) throw new PodError(`${quote(basename(dir))} has a slice that is no framework or library`, where)
    const framework = extension === '.framework'
    const binary = framework ? join(path, basename(path, '.framework')) : path
    return {
      identifier: library.LibraryIdentifier,
      path,
      binary,
      framework,
      dynamic: isDynamic(binary),
      archs: library.SupportedArchitectures ?? [],
      platform: library.SupportedPlatform,
      variant: library.SupportedPlatformVariant,
      headers: library.HeadersPath === undefined ? join(path, 'Headers') : join(dir, library.LibraryIdentifier, library.HeadersPath),
    }
  }).sort((a, b) => byBytes(a.identifier, b.identifier))
  const name = basename(dir, '.xcframework')
  const other = slices.find((slice) => slice.framework && basename(slice.path, '.framework') !== name)
  if (other !== undefined) throw new PodError(`${quote(basename(dir))} holds the framework ${quote(basename(other.path))}, which is not of its name: a framework of an .xcframework is linked and embedded by the .xcframework's name, here ${quote(`${name}.framework`)}, which nothing is found by. The two have to be named alike`, where)
  return { name, dir, targetName: specName, slices, framework: slices[0].framework, dynamic: slices[0].dynamic }
}
