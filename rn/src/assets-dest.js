// `react-native bundle --assets-dest` and `--asset-catalog-dest` as data:
// @react-native/community-cli-plugin 0.88's saveAssets and assetCatalogIOS,
// with @react-native/asset-utils' Android names (MIT, Copyright (c) Meta
// Platforms, Inc. and affiliates).

import { join } from 'node:path'

const IOS_SCALES = [1, 2, 3]

// iOS takes 1x to 3x, else the first above, else the largest.
export function filterPlatformAssetScales(platform, scales) {
  if (platform !== 'ios') return [...scales]
  const kept = scales.filter((scale) => IOS_SCALES.includes(scale))
  if (kept.length > 0 || scales.length === 0) return kept
  return [scales.find((scale) => scale > IOS_SCALES.at(-1)) ?? scales.at(-1)]
}

const DENSITIES = new Map([['0.75', 'ldpi'], ['1', 'mdpi'], ['1.5', 'hdpi'], ['2', 'xhdpi'], ['3', 'xxhdpi'], ['4', 'xxxhdpi']])
const DRAWABLE_TYPES = new Set(['gif', 'heic', 'heif', 'jpeg', 'jpg', 'ktx', 'png', 'webp', 'xml'])

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

// Where the asset's file at `scale` goes, from the assets directory.
export function assetDestPath(asset, scale, platform) {
  if (platform === 'android') return join(resourceType(asset) === 'drawable' ? `drawable-${density(scale)}` : 'raw', `${resourceName(asset)}.${asset.type}`)
  return join(asset.httpServerLocation.slice(1).replaceAll('../', '_'), `${asset.name}${scale === 1 ? '' : `@${scale}x`}.${asset.type}`)
}

// Each file copied, { src, dest } (a file reached twice goes where it last
// goes), and on Android raw/keep.xml, { dest, contents }.
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

const CATALOG_TYPES = new Set(['png', 'jpg', 'jpeg'])

// An image set's renditions: 1x to 3x, else the first above, else the
// largest, as the nearest of them.
function catalogImages(asset) {
  const images = asset.scales.flatMap((scale, index) => (IOS_SCALES.includes(scale) ? [{ scale, src: asset.files[index] }] : []))
  if (images.length > 0 || asset.scales.length === 0) return images
  const above = asset.scales.findIndex((scale) => scale > IOS_SCALES.at(-1))
  const index = above === -1 ? asset.scales.length - 1 : above
  return [{ scale: Math.min(IOS_SCALES.at(-1), Math.max(1, Math.ceil(asset.scales[index]))), src: asset.files[index] }]
}

// iOS's png and jpg assets as image sets of an asset catalog, each named as
// on Android. -> { files, rest }: each file copied, { src, dest }, and each
// set's Contents.json, { dest, contents }, `dest` from the catalog
// (RNAssets.xcassets); `rest`, the assets for --assets-dest.
export function assetCatalogFiles(assets) {
  const files = []
  const rest = []
  for (const asset of assets) {
    if (!CATALOG_TYPES.has(asset.type)) {
      rest.push(asset)
      continue
    }
    const name = resourceName(asset)
    const images = catalogImages(asset).map(({ scale, src }) => ({ scale, src, filename: `${name}${scale === 1 ? '' : `@${scale}x`}.${asset.type}` }))
    for (const { src, filename } of images) files.push({ src, dest: join(`${name}.imageset`, filename) })
    const contents = { images: images.map(({ filename, scale }) => ({ filename, idiom: 'universal', scale: `${scale}x` })), info: { author: 'xcode', version: 1 } }
    files.push({ dest: join(`${name}.imageset`, 'Contents.json'), contents: JSON.stringify(contents) })
  }
  return { files, rest }
}
