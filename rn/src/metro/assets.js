// An asset as Metro builds it into a bundle: the files of it at each scale
// (its Assets' getAbsoluteAssetRecord), the data the module of it registers
// (getAssetData, less asset data plugins, which are code), and that module
// (generateAssetCodeFileAst). Mirrors Metro 0.87, MIT licensed, Copyright (c)
// Meta Platforms, Inc. and affiliates.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { basename, dirname, join, posix, sep } from 'node:path'

import { diskHost } from '../host.js'
import { parseAssetPath } from './asset-paths.js'
import { asBuffer, imageDimensions, isAssetTypeAnImage } from './image-size.js'

// Names in the order Metro's readdir lists them: libuv's, by their bytes.
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

function parsed(assetPath, platform) {
  const asset = parseAssetPath(assetPath, platform)
  if (asset === null) throw new Error(`invalid asset file path: ${assetPath}`)
  return asset
}

// The files of the asset `assetPath` names, for `platform` (null for none),
// in its directory: those of its name and type at any scale, those for the
// platform (`a.ios.png`, `a@2x.ios.png`) where it has any, else those for
// none. -> { files, scales }, absolute paths and their scales, by scale
// (ties as listed)
export function assetRecord(assetPath, { platform = null, host = diskHost } = {}) {
  const own = parsed(basename(assetPath), platform)
  const dir = dirname(assetPath)
  const records = new Map()
  for (const name of host.readdir(dir).toSorted(byBytes)) {
    const asset = parseAssetPath(name, platform)
    if (asset === null) continue
    const key = asset.platform === null ? asset.assetName : `${asset.assetName} : ${asset.platform}`
    if (!records.has(key)) records.set(key, [])
    records.get(key).push({ file: join(dir, name), scale: asset.resolution })
  }
  const record = (platform === null ? undefined : records.get(`${own.assetName} : ${platform}`)) ?? records.get(own.assetName)
  if (record === undefined) throw new Error(`Asset not found: ${assetPath} for platform: ${platform ?? '(unspecified)'}`)
  const byScale = record.toSorted((a, b) => a.scale - b.scale)
  return { files: byScale.map(({ file }) => file), scales: byScale.map(({ scale }) => scale) }
}

// The data of the asset `assetPath` names, for `platform`: Metro's AssetData,
// `urlPath` the asset's path below `publicPath` as Metro gives it (from the
// project root, posix; a watch folder's spelled as the Metro in use spells
// it). `hash` is the md5 of its files' bytes in scale order; `width` and
// `height`, for an image, its first file's size over its scale.
export function assetData(assetPath, { urlPath, platform = null, publicPath = '/assets', host = diskHost } = {}) {
  if (typeof urlPath !== 'string') throw new TypeError('assetData: urlPath, the asset\'s path below publicPath, is required')
  const { name, type } = parsed(assetPath, platform)
  const { files, scales } = assetRecord(assetPath, { platform, host })
  const contents = files.map((file) => asBuffer(host.readFile(file)))
  const hasher = createHash('md5')
  for (const content of contents) hasher.update(content)
  let dimensions = null
  if (isAssetTypeAnImage(type)) {
    if (contents[0].length === 0) throw new Error(`Image asset \`${files[0]}\` cannot be an empty file.`)
    dimensions = imageDimensions(type, contents[0], files[0])
  }
  // A path above the root keeps its `..`, which a join would fold away.
  const location = urlPath.startsWith('..') ? `${publicPath.replace(/\/$/u, '')}/${posix.dirname(urlPath)}` : join(publicPath, posix.dirname(urlPath))
  return {
    __packager_asset: true,
    fileSystemLocation: dirname(assetPath),
    httpServerLocation: sep === '/' ? location : location.replaceAll(sep, '/'),
    width: dimensions === null ? undefined : dimensions.width / scales[0],
    height: dimensions === null ? undefined : dimensions.height / scales[0],
    scales,
    files,
    hash: hasher.digest('hex'),
    name,
    type,
  }
}

// The module Metro builds of an asset of `data`: its data less the files,
// registered with the asset registry at `assetRegistryPath`, as the project's
// Metro config names it (`transformer.assetRegistryPath`; React Native's is
// `react-native/Libraries/Image/AssetRegistry` up to 0.86, and from 0.87
// `react-native/asset-registry`).
export function assetModule(data, assetRegistryPath) {
  if (typeof assetRegistryPath !== 'string' || assetRegistryPath === '') throw new TypeError('assetModule: assetRegistryPath is required')
  const { files: _files, fileSystemLocation: _location, path: _path, ...descriptor } = data
  return `module.exports = require(${JSON.stringify(assetRegistryPath)}).registerAsset(${JSON.stringify(descriptor)});\n`
}
