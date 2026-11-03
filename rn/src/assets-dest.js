// `react-native bundle --assets-dest` and `--asset-catalog-dest` as data: @react-native/
// community-cli-plugin 0.88's saveAssets and assetCatalogIOS, with @react-native/asset-utils'
// Android names (MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { join } from 'node:path'

const IOS_SCALES = new Set([1, 2, 3])
const DENSITIES = new Map([['0.75', 'ldpi'], ['1', 'mdpi'], ['1.5', 'hdpi'], ['2', 'xhdpi'], ['3', 'xxhdpi'], ['4', 'xxxhdpi']])
const DRAWABLE_TYPES = new Set(['gif', 'heic', 'heif', 'jpeg', 'jpg', 'ktx', 'png', 'webp', 'xml'])
const CATALOG_TYPES = new Set(['png', 'jpg', 'jpeg'])

// The indices of the scales iOS takes: 1x to 3x, else the first above, else the largest.
function iosScales(scales) {
  const kept = scales.flatMap((scale, index) => (IOS_SCALES.has(scale) ? [index] : []))
  if (kept.length > 0 || scales.length === 0) return kept
  const above = scales.findIndex((scale) => scale > 3)
  return [above === -1 ? scales.length - 1 : above]
}

export function filterPlatformAssetScales(platform, scales) {
  return platform === 'ios' ? iosScales(scales).map((index) => scales[index]) : [...scales]
}

function density(scale) {
  const named = DENSITIES.get(String(scale))
  if (named !== undefined) return named
  if (Number.isFinite(scale) && scale > 0) return `${Math.round(scale * 160)}dpi`
  throw new Error(`no such scale ${scale}`)
}

const resourceName = ({ httpServerLocation, name }) =>
  `${httpServerLocation.replace(/^\//u, '')}/${name}`
    .toLowerCase()
    .replaceAll('/', '_')
    .replaceAll(/[^a-z0-9_]/gu, '')
    .replace(/^(?:assets|assetsunstable_path)_/u, '')

const resourceType = (asset) => (DRAWABLE_TYPES.has(asset.type) ? 'drawable' : 'raw')

const scaledName = (name, scale, type) => `${name}${scale === 1 ? '' : `@${scale}x`}.${type}`

export function assetDestPath(asset, scale, platform) {
  if (platform === 'android') return join(resourceType(asset) === 'drawable' ? `drawable-${density(scale)}` : 'raw', `${resourceName(asset)}.${asset.type}`)
  return join(asset.httpServerLocation.slice(1).replaceAll('../', '_'), scaledName(asset.name, scale, asset.type))
}

// Each file to copy (a file reached twice goes where it last goes), plus Android's raw/keep.xml.
export function assetsDestFiles(assets, platform) {
  const copies = new Map()
  for (const asset of assets) {
    const kept = new Set(filterPlatformAssetScales(platform, asset.scales))
    asset.scales.forEach((scale, index) => {
      if (kept.has(scale)) copies.set(asset.files[index], assetDestPath(asset, scale, platform))
    })
  }
  const files = [...copies].map(([src, dest]) => ({ src, dest }))
  if (platform === 'android' && assets.length > 0) {
    const keep = assets.map((asset) => `@${resourceType(asset)}/${resourceName(asset)}`).join(',')
    files.push({ dest: join('raw', 'keep.xml'), contents: `<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${keep}" />\n` })
  }
  return files
}

// iOS's png and jpg assets as image sets of an asset catalog, named as on Android, with each
// set's Contents.json; `rest` are the other assets, for --assets-dest.
export function assetCatalogFiles(assets) {
  const files = []
  const rest = []
  for (const asset of assets) {
    if (!CATALOG_TYPES.has(asset.type)) {
      rest.push(asset)
      continue
    }
    const name = resourceName(asset)
    // A fallback scale outside 1x to 3x is rounded up into that range.
    const images = iosScales(asset.scales).map((index) => {
      const scale = Math.min(3, Math.max(1, Math.ceil(asset.scales[index])))
      return { scale, src: asset.files[index], filename: scaledName(name, scale, asset.type) }
    })
    for (const { src, filename } of images) files.push({ src, dest: join(`${name}.imageset`, filename) })
    const contents = { images: images.map(({ filename, scale }) => ({ filename, idiom: 'universal', scale: `${scale}x` })), info: { author: 'xcode', version: 1 } }
    files.push({ dest: join(`${name}.imageset`, 'Contents.json'), contents: JSON.stringify(contents) })
  }
  return { files, rest }
}
