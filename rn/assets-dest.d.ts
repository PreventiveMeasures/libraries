import type { AssetData } from './metro-assets.js'

export type DestAsset = Pick<AssetData, 'httpServerLocation' | 'name' | 'type' | 'scales' | 'files'>

export function filterPlatformAssetScales(platform: string, scales: readonly number[]): number[]

// From the assets directory.
export function assetDestPath(asset: Omit<DestAsset, 'scales' | 'files'>, scale: number, platform: string): string

export function assetsDestFiles(assets: readonly DestAsset[], platform: string): Array<{ src: string; dest: string } | { dest: string; contents: string }>
