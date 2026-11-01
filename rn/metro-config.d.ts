import type { Node } from './config-lists.js'

// The extensions a metro.config.js's AST lists among `resolver.assetExts`,
// besides Metro's defaults it spreads in; never run.
export function metroAssetExts(program: Node): string[]

// The same with no parser, where the config names `assetExts` only as
// `assetExts: [...defaults.assetExts, 'riv']` (or not at all); null where it
// names it otherwise, which needs metroAssetExts.
export function scanMetroAssetExts(source: string): string[] | null
