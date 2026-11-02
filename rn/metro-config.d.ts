// The extensions a metro.config.js adds to Metro's assetExts, off its ESTree
// program (oxc-parser's), never run. One it filters out is still listed.
export function metroAssetExts(program: object): string[]

// The same off its source, where it names assetExts only as
// `assetExts: [...defaultConfig.resolver.assetExts, 'riv']`; else null, for
// metroAssetExts to read.
export function scanMetroAssetExts(source: string): string[] | null

// Metro's asset extensions and those the project's metro.config.js (`file`,
// where given) adds, read off it, never run: by `oxc` (oxc-parser's module;
// the project's, else the one beside rn/, where not given; none where null),
// else as scanMetroAssetExts reads it. Metro's defaults alone where the
// project has no metro.config.js; throws where `file` isn't there, or where
// only a parser reads it and there's none.
export function readMetroAssetExts(projectRoot: string, options?: { file?: string | null; oxc?: { parseSync(filename: string, source: string, options?: object): { program: object } } | null }): string[]
