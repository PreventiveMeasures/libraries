// The typed contract for metro-assets.js, hand-written because the package is
// plain JavaScript. A change to an exported signature belongs in the same
// commit as the change here.

import type { Host } from './metro-resolver.js'

// Whether any dot-suffix of the file's name is one of `assetExts`, Metro's
// default asset extensions where not given.
export function isAssetFile(filePath: string, assetExts?: readonly string[] | ReadonlySet<string>): boolean

export interface AssetRecord {
  // Absolute paths, by scale.
  files: string[]
  scales: number[]
}

export interface AssetOptions {
  // Null for none.
  platform?: string | null
  host?: Host
}

// The files of the asset `assetPath` names: those for the platform where it
// has any, else those for none. Throws where it has none.
export function assetRecord(assetPath: string, options?: AssetOptions): AssetRecord

// Metro's AssetData, less what asset data plugins add.
export interface AssetData {
  __packager_asset: true
  fileSystemLocation: string
  httpServerLocation: string
  // An image's, in points: its first file's size over its scale.
  width: number | undefined
  height: number | undefined
  scales: number[]
  files: string[]
  // md5 of the files' bytes, in scale order, as hex.
  hash: string
  name: string
  type: string
}

// `urlPath` is the asset's path below `publicPath` (`/assets` where not
// given) as Metro gives it: from the project root, posix.
export function assetData(assetPath: string, options: AssetOptions & { urlPath: string; publicPath?: string }): AssetData

// The module Metro builds of an asset, registering its data less its files
// with the registry at `assetRegistryPath`, as the Metro config names it.
export function assetModule(data: AssetData, assetRegistryPath: string): string
