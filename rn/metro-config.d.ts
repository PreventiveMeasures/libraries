// The extensions a metro.config.js adds to Metro's assetExts, off its ESTree
// program (oxc-parser's), never run. One it filters out is still listed.
export function metroAssetExts(program: object): string[]

// The same off its source, where it names assetExts only as
// `assetExts: [...defaultConfig.resolver.assetExts, 'riv']`; else null, for
// metroAssetExts to read.
export function scanMetroAssetExts(source: string): string[] | null
