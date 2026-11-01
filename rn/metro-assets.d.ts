import type { Host } from './metro-resolver.js'

export function isAssetFile(filePath: string, assetExts?: Iterable<string>): boolean

export interface AssetOptions {
  platform?: string | null
  host?: Host
}

// The asset's files, by scale: the platform's where it has any.
export function assetRecord(assetPath: string, options?: AssetOptions): { files: string[]; scales: number[] }

// Metro's AssetData, with no asset data plugins.
export interface AssetData {
  __packager_asset: true
  fileSystemLocation: string
  httpServerLocation: string
  width: number | undefined
  height: number | undefined
  scales: number[]
  files: string[]
  hash: string
  name: string
  type: string
}

// `urlPath`: the asset's path below `publicPath` (`/assets`), posix.
export function assetData(assetPath: string, options: AssetOptions & { urlPath: string; publicPath?: string }): AssetData

// The module registering the asset with `assetRegistryPath`.
export function assetModule(data: AssetData, assetRegistryPath: string): string
