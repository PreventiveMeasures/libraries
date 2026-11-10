// What CocoaPods reads of a vendored binary: whether a Mach-O file is a dynamic library, and the slices of an
// .xcframework, as its Info.plist lists them.

import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { PodError, quote } from './error.js'
import { parseXml } from './plist.js'
import { byBytes } from './xcconfig.js'

const MH_DYLIB = 6
const THIN = new Set([0xFEEDFACE, 0xFEEDFACF])
const FAT = new Set([0xCAFEBABE, 0xCAFEBABF])

// LinkageAnalyzer.dynamic_binary?: a Mach-O file, or the first of a fat one, whose type is a dynamic library.
// An archive, or what is no Mach-O file, is none; a file that is not there neither, as CocoaPods has it.
export function isDynamic(path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const head = Buffer.alloc(4096)
    const size = readSync(fd, head, 0, head.length, 0)
    const typeAt = (offset) => {
      if (offset + 16 > size) return false
      const magic = head.readUInt32LE(offset)
      return THIN.has(magic) ? head.readUInt32LE(offset + 12) === MH_DYLIB : THIN.has(head.readUInt32BE(offset)) && head.readUInt32BE(offset + 12) === MH_DYLIB
    }
    if (size < 8) return false
    const magic = head.readUInt32BE(0)
    if (!FAT.has(magic)) return typeAt(0)
    const first = magic === 0xCAFEBABF ? Number(head.readBigUInt64BE(16)) : head.readUInt32BE(16)
    const slice = Buffer.alloc(16)
    return readSync(fd, slice, 0, 16, first) === 16 && (THIN.has(slice.readUInt32LE(0)) ? slice.readUInt32LE(12) : slice.readUInt32BE(12)) === MH_DYLIB
  } finally {
    closeSync(fd)
  }
}

// Xcode::XCFramework: `dir` is the .xcframework's directory, `specName` the spec that vends it, which its
// intermediate directory is named after. Its slices come sorted by their identifiers; its type is its first's.
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
  return { name: basename(dir, '.xcframework'), dir, targetName: specName, slices, framework: slices[0].framework, dynamic: slices[0].dynamic }
}
