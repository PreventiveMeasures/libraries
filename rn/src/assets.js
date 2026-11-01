// Assets as Metro 0.87 reads and builds them (node-haste AssetPaths, Assets,
// generateAssetCodeFileAst; MIT, Copyright (c) Meta Platforms, Inc. and
// affiliates).

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, posix } from 'node:path'

import { defaults, diskHost } from './defaults.js'
import { asBuffer, imageDimensions, isAssetTypeAnImage } from './image-size.js'

const DEFAULT_ASSET_EXTS = new Set(defaults.assetExts)

// Whether any dot-suffix of the name is an asset extension: `a.tar.gz` for
// `gz` or `tar.gz`.
export function isAssetFile(filePath, assetExts = DEFAULT_ASSET_EXTS) {
  const exts = assetExts instanceof Set ? assetExts : new Set(assetExts)
  const name = basename(filePath)
  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] === '.' && exts.has(name.slice(i + 1))) return true
  }
  return false
}

const PLATFORM_FILE = /^(.+?)(\.([^.]+))?\.([^.]+)$/u
const SCALED = /^(.+?)(@([\d.]+)x)?$/u

// AssetPaths.tryParse: `a@2x.ios.png` is the asset `a.png` at scale 2 for
// ios; another platform's suffix is part of the name. Null without a type.
export function parseAssetPath(filePath, platform = null) {
  const match = PLATFORM_FILE.exec(basename(filePath))
  if (match === null) return null
  const [, base, , suffix = null, type] = match
  const own = suffix === null || suffix === platform
  const [, name, , scale] = SCALED.exec(own ? base : `${base}.${suffix}`)
  const resolution = Number.parseFloat(scale)
  return { assetName: join(dirname(filePath), `${name}.${type}`), name, platform: own ? suffix : null, resolution: Number.isNaN(resolution) ? 1 : resolution, type }
}

// The files an import of an asset resolves to: it and its scale variants,
// by real paths; null where none is a file, or where it names a variant.
export function assetFiles(host, filePath, assetResolutions) {
  const ext = extname(filePath)
  const base = join(dirname(filePath), basename(filePath, ext))
  if (/@\d+(?:\.\d+)?x$/u.test(base)) return null
  const files = [`${base}${ext}`, ...assetResolutions.map((scale) => `${base}@${scale}x${ext}`)].filter((file) => host.isFile(file))
  return files.length > 0 ? files.map((file) => host.realpath(file)) : null
}

function parsed(assetPath, platform) {
  const asset = parseAssetPath(assetPath, platform)
  if (asset === null) throw new Error(`invalid asset file path: ${assetPath}`)
  return asset
}

// getAbsoluteAssetRecord: the asset's files in its directory, the
// platform's where it has any, by scale, ties in libuv's readdir order.
export function assetRecord(assetPath, { platform = null, host = diskHost } = {}) {
  const own = parsed(basename(assetPath), platform)
  const dir = dirname(assetPath)
  const entries = host.readdir(dir)
    .filter((name) => name.startsWith(own.name))
    .toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .flatMap((name) => {
      const asset = parseAssetPath(name, platform)
      return asset === null ? [] : [{ key: asset.platform === null ? asset.assetName : `${asset.assetName} : ${asset.platform}`, file: join(dir, name), scale: asset.resolution }]
    })
  const records = Map.groupBy(entries, ({ key }) => key)
  const record = (platform === null ? undefined : records.get(`${own.assetName} : ${platform}`)) ?? records.get(own.assetName)
  if (record === undefined) throw new Error(`Asset not found: ${assetPath} for platform: ${platform ?? '(unspecified)'}`)
  const byScale = record.toSorted((a, b) => a.scale - b.scale)
  return { files: byScale.map(({ file }) => file), scales: byScale.map(({ scale }) => scale) }
}

// getAssetData, with no asset data plugins. `urlPath` is the asset's path
// below `publicPath`, posix.
export function assetData(assetPath, { urlPath, platform = null, publicPath = '/assets', host = diskHost } = {}) {
  if (typeof urlPath !== 'string') throw new TypeError('assetData: urlPath is required')
  const { name, type } = parsed(assetPath, platform)
  const { files, scales } = assetRecord(assetPath, { platform, host })
  const contents = files.map((file) => asBuffer(host.readFile(file)))
  const hash = createHash('md5')
  for (const content of contents) hash.update(content)
  let dimensions = null
  if (isAssetTypeAnImage(type)) {
    if (contents[0].length === 0) throw new Error(`Image asset \`${files[0]}\` cannot be an empty file.`)
    dimensions = imageDimensions(type, contents[0], files[0])
  }
  // A `..` path is kept, which a join would fold.
  const dir = posix.dirname(urlPath)
  return {
    __packager_asset: true,
    fileSystemLocation: dirname(assetPath),
    httpServerLocation: urlPath.startsWith('..') ? `${publicPath.replace(/\/$/u, '')}/${dir}` : posix.join(publicPath, dir),
    width: dimensions === null ? undefined : dimensions.width / scales[0],
    height: dimensions === null ? undefined : dimensions.height / scales[0],
    scales,
    files,
    hash: hash.digest('hex'),
    name,
    type,
  }
}

// The module Metro builds of an asset. React Native's `assetRegistryPath` is
// `react-native/Libraries/Image/AssetRegistry` up to 0.86,
// `react-native/asset-registry` from 0.87.
export function assetModule(data, assetRegistryPath) {
  if (typeof assetRegistryPath !== 'string' || assetRegistryPath === '') throw new TypeError('assetModule: assetRegistryPath is required')
  const { files: _files, fileSystemLocation: _location, path: _path, ...descriptor } = data
  return `module.exports = require(${JSON.stringify(assetRegistryPath)}).registerAsset(${JSON.stringify(descriptor)});\n`
}
