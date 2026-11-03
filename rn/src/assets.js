// Assets as Metro 0.87 reads and builds them (node-haste AssetPaths, Assets,
// generateAssetCodeFileAst; MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, posix } from 'node:path'

import { defaults, diskHost } from './defaults.js'
import { imageSize } from './image-size.js'
import { jsval } from './jsval.js'

const DEFAULT_ASSET_EXTS = new Set(defaults.assetExts)

// Whether any dot-suffix of the name is an asset extension: `a.tar.gz` for `gz` or `tar.gz`.
export function isAssetFile(filePath, assetExts = DEFAULT_ASSET_EXTS) {
  const exts = assetExts instanceof Set ? assetExts : new Set(assetExts)
  const name = basename(filePath)
  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] === '.' && exts.has(name.slice(i + 1))) return true
  }
  return false
}

const PLATFORM_FILE = /^(.+?)(?:\.([^.]+))?\.([^.]+)$/u
const SCALED = /^(.+?)(?:@([\d.]+)x)?$/u

// AssetPaths.tryParse: `a@2x.ios.png` is the asset `a.png` at scale 2 for ios; another
// platform's suffix is part of the name. Null without an extension.
export function parseAssetPath(filePath, platform = null) {
  const match = PLATFORM_FILE.exec(basename(filePath))
  if (match === null) return null
  const [, base, suffix = null, type] = match
  const own = suffix === null || suffix === platform
  const [, name, scale] = SCALED.exec(own ? base : `${base}.${suffix}`)
  const resolution = Number.parseFloat(scale)
  return { assetName: join(dirname(filePath), `${name}.${type}`), name, platform: own ? suffix : null, resolution: Number.isNaN(resolution) ? 1 : resolution, type }
}

// The real paths an asset import resolves to, itself and its scale variants; null if none
// exists or it names a variant.
export function assetFiles(host, filePath, assetResolutions) {
  const ext = extname(filePath)
  const base = join(dirname(filePath), basename(filePath, ext))
  if (/@\d+(?:\.\d+)?x$/u.test(base)) return null
  const files = [`${base}${ext}`, ...assetResolutions.map((scale) => `${base}@${scale}x${ext}`)].filter((file) => host.isFile(file))
  return files.length > 0 ? files.map((file) => host.realpath(file)) : null
}

// getAbsoluteAssetRecord: the asset's files in its directory (the platform's, if it has any) by
// scale, ties in libuv's readdir order (bytewise).
export function assetRecord(assetPath, { platform = null, host = diskHost } = {}) {
  const own = parseAssetPath(assetPath, platform)
  if (own === null) throw new Error(`invalid asset file path: ${assetPath}`)
  const dir = dirname(assetPath)
  const entries = host.readdir(dir)
    .filter((name) => name.startsWith(own.name))
    .toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .flatMap((name) => {
      const file = join(dir, name)
      const asset = parseAssetPath(file, platform)
      return asset === null ? [] : [{ key: asset.platform === null ? asset.assetName : `${asset.assetName} : ${asset.platform}`, file, scale: asset.resolution }]
    })
  const records = Map.groupBy(entries, ({ key }) => key)
  const record = (platform === null ? undefined : records.get(`${own.assetName} : ${platform}`)) ?? records.get(own.assetName)
  if (record === undefined) throw new Error(`Asset not found: ${assetPath} for platform: ${platform ?? '(unspecified)'}`)
  const byScale = record.toSorted((a, b) => a.scale - b.scale)
  return { files: byScale.map(({ file }) => file), scales: byScale.map(({ scale }) => scale) }
}

// getAssetData, with no asset data plugins. `urlPath` is the asset's posix path below `publicPath`.
export function assetData(assetPath, { urlPath, platform = null, publicPath = '/assets', host = diskHost } = {}) {
  if (typeof urlPath !== 'string') throw new TypeError('assetData: urlPath is required')
  const { files, scales } = assetRecord(assetPath, { platform, host })
  const { name, type } = parseAssetPath(assetPath, platform)
  const contents = files.map((file) => host.readFile(file))
  const hash = createHash('md5')
  for (const content of contents) hash.update(content)
  const size = imageSize(type, contents[0], files[0])
  // Metro keeps a leading `..`, which a join would fold.
  const dir = posix.dirname(urlPath)
  return {
    __packager_asset: true,
    fileSystemLocation: dirname(assetPath),
    httpServerLocation: urlPath.startsWith('..') ? `${publicPath.replace(/\/$/u, '')}/${dir}` : posix.join(publicPath, dir),
    width: size === null ? undefined : size.width / scales[0],
    height: size === null ? undefined : size.height / scales[0],
    scales,
    files,
    hash: hash.digest('hex'),
    name,
    type,
  }
}

// The module Metro builds for an asset. React Native's `assetRegistryPath` is
// `react-native/Libraries/Image/AssetRegistry` up to 0.86, `react-native/asset-registry` from 0.87.
export function assetModule(data, assetRegistryPath) {
  if (typeof assetRegistryPath !== 'string' || assetRegistryPath === '') throw new TypeError('assetModule: assetRegistryPath is required')
  const { files: _files, fileSystemLocation: _location, path: _path, ...descriptor } = data
  return `module.exports = require(${jsval(assetRegistryPath)}).registerAsset(${jsval(descriptor)});\n`
}
