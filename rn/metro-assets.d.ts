// The typed contract for metro-assets.js, hand-written because the package is
// plain JavaScript. A change to an exported signature belongs in the same
// commit as the change here.

import type { Host } from './host.js'

export type { Host } from './host.js'

// Whether any dot-suffix of the file's name is one of `assetExts`, Metro's
// default asset extensions where not given.
export function isAssetFile(filePath: string, assetExts?: readonly string[] | ReadonlySet<string>): boolean

// A file of an asset, as Metro reads its name for `platform`.
export interface AssetPath {
  // The asset's own file name, scale and platform left out, in the file's
  // directory: `img/a.png` for `img/a@2x.ios.png`.
  assetName: string
  name: string
  // The platform the name says, where it is the one asked for.
  platform: string | null
  // The scale the name says, else 1.
  resolution: number
  type: string
}

// Null for a name with no extension.
export function parseAssetPath(filePath: string, platform?: string | null): AssetPath | null

// Whether Metro reads the size of an asset of `type`.
export function isAssetTypeAnImage(type: string): boolean

// The image's width and height, by the type's parser, else the first other
// that reads the bytes; throws where none reads a positive size.
export function imageDimensions(type: string, bytes: Uint8Array, filePath: string): { width: number; height: number }

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
