import type { AssetData } from './metro-assets.js'

export type DestAsset = Pick<AssetData, 'httpServerLocation' | 'name' | 'type' | 'scales' | 'files'>

export function filterPlatformAssetScales(platform: string, scales: readonly number[]): number[]

// From the assets directory.
export function assetDestPath(asset: Omit<DestAsset, 'scales' | 'files'>, scale: number, platform: string): string

export function assetsDestFiles(assets: readonly DestAsset[], platform: string): Array<{ src: string; dest: string } | { dest: string; contents: string }>

// iOS's asset catalog: its files, from RNAssets.xcassets, and the assets not in it.
export function assetCatalogFiles<Asset extends DestAsset>(assets: readonly Asset[]): { files: Array<{ src: string; dest: string } | { dest: string; contents: string }>; rest: Asset[] }
