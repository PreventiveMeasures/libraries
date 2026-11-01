// Where `react-native bundle --assets-dest` puts a bundle's assets: the
// React Native CLI's saveAssets, as data rather than copies (no iOS asset
// catalog), with @react-native/asset-utils' Android resource names. Mirrors
// @react-native/community-cli-plugin and @react-native/asset-utils 0.88, MIT
// licensed, Copyright (c) Meta Platforms, Inc. and affiliates.

import { join } from 'node:path'

// The scales a platform takes, where it limits them.
const ALLOWED_SCALES = new Map([['ios', [1, 2, 3]]])

// The scales of `scales` copied out for `platform`: on iOS 1x to 3x, else the
// first above them, else the largest; every one elsewhere.
export function filterPlatformAssetScales(platform, scales) {
  const allowed = ALLOWED_SCALES.get(platform)
  if (allowed === undefined) return [...scales]
  const kept = scales.filter((scale) => allowed.includes(scale))
  if (kept.length > 0 || scales.length === 0) return kept
  return [scales.find((scale) => scale > allowed.at(-1)) ?? scales.at(-1)]
}

const ANDROID_DENSITIES = new Map([['0.75', 'ldpi'], ['1', 'mdpi'], ['1.5', 'hdpi'], ['2', 'xhdpi'], ['3', 'xxhdpi'], ['4', 'xxxhdpi']])
const ANDROID_BASE_DENSITY = 160
// The types Android takes as drawables; any other is a raw resource.
const DRAWABLE_TYPES = new Set(['gif', 'heic', 'heif', 'jpeg', 'jpg', 'ktx', 'png', 'webp', 'xml'])

// A density qualifier of its own for a scale with none, which the Android
// Gradle plugin reads only in part.
function androidDensity(scale) {
  const named = ANDROID_DENSITIES.get(String(scale))
  if (named !== undefined) return named
  if (Number.isFinite(scale) && scale > 0) return `${Math.round(scale * ANDROID_BASE_DENSITY)}dpi`
  throw new Error(`no such scale ${scale}`)
}

// The asset's resource name: its path below the server root and its name, as
// one lowercase identifier, an `assets_` in front left out.
const androidResourceIdentifier = (asset) =>
  `${asset.httpServerLocation.startsWith('/') ? asset.httpServerLocation.slice(1) : asset.httpServerLocation}/${asset.name}`
    .toLowerCase()
    .replaceAll('/', '_')
    .replaceAll(/[^a-z0-9_]/gu, '')
    .replace(/^(?:assets|assetsunstable_path)_/u, '')

const resourceType = (asset) => (DRAWABLE_TYPES.has(asset.type) ? 'drawable' : 'raw')

// Where the file of `asset` (Metro's AssetData, as metro-assets.js's
// assetData gives it) at `scale` goes for `platform`, from the assets
// directory: Android's res/ layout, drawable-<density>/ or raw/; elsewhere
// the asset's path below the server root, a `..` in it as `_`.
export function assetDestPath(asset, scale, platform) {
  if (platform === 'android') {
    const folder = resourceType(asset) === 'drawable' ? `drawable-${androidDensity(scale)}` : 'raw'
    return join(folder, `${androidResourceIdentifier(asset)}.${asset.type}`)
  }
  const suffix = scale === 1 ? '' : `@${scale}x`
  return join(asset.httpServerLocation.slice(1).replaceAll('../', '_'), `${asset.name}${suffix}.${asset.type}`)
}

// What --assets-dest holds for `assets` on `platform`: each file of a scale
// the platform takes, { src, dest }, the file and where it goes from the
// assets directory, a file reached twice going where it last went; and on
// Android, raw/keep.xml, { dest, contents }, keeping every asset's resource
// from being shrunk away.
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
    const keep = assets.map((asset) => `@${resourceType(asset)}/${androidResourceIdentifier(asset)}`)
    files.push({ dest: join('raw', 'keep.xml'), contents: `<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${keep.join(',')}" />\n` })
  }
  return files
}
