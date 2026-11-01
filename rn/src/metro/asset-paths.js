// How Metro reads an asset's file name (its node-haste AssetPaths and
// parsePlatformFilePath) and finds an asset's files at its scales (its
// resolver's isAssetFile and resolveAsset, and DependencyGraph's
// resolveAsset). Mirrors Metro 0.87, MIT licensed, Copyright (c) Meta
// Platforms, Inc. and affiliates.

import { basename, dirname, extname, join } from 'node:path'

import { diskHost } from '../host.js'
import { assetExts as ASSET_EXTS, assetResolutions as ASSET_RESOLUTIONS } from './defaults.js'

const DEFAULT_ASSET_EXTS = new Set(ASSET_EXTS)

// A Set of extensions, as given or of the array given.
export const extensionSet = (exts) => (exts instanceof Set ? exts : new Set(exts))

// Whether any dot-suffix of the file's name is one of `assetExts`: `a.png`,
// and `a.tar.gz` for `gz` or `tar.gz`.
export function isAssetFile(filePath, assetExts = DEFAULT_ASSET_EXTS) {
  const exts = extensionSet(assetExts)
  const name = basename(filePath)
  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] === '.' && exts.has(name.slice(i + 1))) return true
  }
  return false
}

const PLATFORM_FILE = /^(.+?)(\.([^.]+))?\.([^.]+)$/u
const SCALED = /^(.+?)(@([\d.]+)x)?$/u

// The asset a file of it names, for `platform` (null for none): its name and
// type (`a@2x.ios.png` is `a`'s, a png), its scale (1 where it names none),
// and its platform where it names `platform`; another platform's name is part
// of the asset's (`a.android.png` is the asset `a.android` on iOS). `assetName`
// is the asset's own file name, scale and platform left out, in the file's
// directory. Null for a name with no extension, which names no type.
export function parseAssetPath(filePath, platform = null) {
  const match = PLATFORM_FILE.exec(basename(filePath))
  if (match === null) return null
  const [, base, , suffix = null, type] = match
  const own = suffix === null || suffix === platform
  const [, name, , scale] = SCALED.exec(own ? base : `${base}.${suffix}`)
  const resolution = scale === undefined ? Number.NaN : Number.parseFloat(scale)
  return {
    assetName: join(dirname(filePath), `${name}.${type}`),
    name,
    platform: own ? suffix : null,
    resolution: Number.isNaN(resolution) ? 1 : resolution,
    type,
  }
}

// The files an import of the asset `filePath` resolves to: it and its scale
// variants (`a@1.5x.png` ... `a@4x.png`, by `assetResolutions`) that are
// files, by their real paths. Null where none is, or where the import names
// a variant itself (`./a@2x.png`), which Metro refuses.
export function assetFiles(host, filePath, assetResolutions = ASSET_RESOLUTIONS) {
  const ext = extname(filePath)
  const name = basename(filePath, ext)
  if (/@\d+(?:\.\d+)?x$/u.test(name)) return null
  return assetCandidates(host, dirname(filePath), name, ext, assetResolutions)
}

// `assetName` + `ext` in `dirPath`, and at each of `assetResolutions`, those
// that are files, by their real paths; null where none is. A directory named
// like one (`lodash.zip`) is no asset.
function assetCandidates(host, dirPath, assetName, ext, assetResolutions) {
  const base = join(dirPath, assetName)
  const files = [`${base}${ext}`, ...assetResolutions.map((scale) => `${base}@${scale}x${ext}`)]
    .filter((file) => host.isFile(file))
    .map((file) => host.realpath(file))
  return files.length > 0 ? files : null
}

// DependencyGraph's resolveAsset, the one a metro-resolver context takes.
export const resolveAsset = (dirPath, assetName, extension, { host = diskHost, assetResolutions = ASSET_RESOLUTIONS } = {}) =>
  assetCandidates(host, dirPath, assetName, extension, assetResolutions)
