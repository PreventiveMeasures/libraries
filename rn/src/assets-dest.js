// `react-native bundle --assets-dest` as data: @react-native/community-cli-plugin
// 0.88's saveAssets with @react-native/asset-utils' Android names (MIT,
// Copyright (c) Meta Platforms, Inc. and affiliates). No iOS asset catalog.

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
