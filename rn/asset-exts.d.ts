// Metro's asset extensions and those the project's metro.config.js (`file`,
// where given; else rn.config.json's metroConfig, of none where false) adds,
// read off it, never run: by `oxc` (oxc-parser's module; the project's, else
// the one beside rn/, where not given; none where null), else as
// scanMetroAssetExts reads it; then those rn.config.json's assetExts adds.
// Metro's defaults alone where the project has no metro.config.js; throws
// where `file` isn't there, or where only a parser reads it and there's none,
// or where rn.config.json is not one rn-bundle takes. Where rn.config.json
// has assetExts, Metro's defaults and them, reading no Metro config (as
// rn-bundle refuses one that sets them too).
export function readMetroAssetExts(projectRoot: string, options?: { file?: string | null; oxc?: { parseSync(filename: string, source: string, options?: object): { program: object } } | null }): string[]
