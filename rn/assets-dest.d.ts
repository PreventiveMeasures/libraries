// The typed contract for assets-dest.js, hand-written because the package is
// plain JavaScript. A change to an exported signature belongs in the same
// commit as the change here.

import type { AssetData } from './metro-assets.js'

// What of an asset's data says where it goes.
export type DestAsset = Pick<AssetData, 'httpServerLocation' | 'name' | 'type' | 'scales' | 'files'>

// The scales copied out for `platform`: iOS takes 1x to 3x, else the first
// above them, else the largest; any other platform every one.
export function filterPlatformAssetScales(platform: string, scales: readonly number[]): number[]

// Where the asset's file at `scale` goes for `platform`, from the assets
// directory.
export function assetDestPath(asset: Omit<DestAsset, 'scales' | 'files'>, scale: number, platform: string): string

// Every file --assets-dest holds for `assets` on `platform`: a copy of an
// asset's file, or Android's raw/keep.xml with its contents. `dest` is from
// the assets directory.
export function assetsDestFiles(assets: readonly DestAsset[], platform: string): Array<{ src: string; dest: string } | { dest: string; contents: string }>
