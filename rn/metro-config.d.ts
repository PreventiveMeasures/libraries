import type { Node } from './config-lists.js'

// The extensions a metro.config.js's AST lists among `resolver.assetExts`,
// besides Metro's defaults it spreads in; never run.
export function metroAssetExts(program: Node): string[]

// The same from the source, with no parser, for the usual forms: an array
// assigned to `assetExts`, and the arguments of its push, unshift or concat.
export function scanMetroAssetExts(source: string): string[]
