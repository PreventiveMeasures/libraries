// Read synchronously; absolute paths, links followed. A Vfs from
// @preventive/vfs is one; the disk is the default.
export interface Host {
  isFile(path: string): boolean
  isDirectory(path: string): boolean
  realpath(path: string): string
  readFile(path: string): Uint8Array
  readdir(path: string): string[]
}

// React Native's Metro config defaults.
export const defaults: Readonly<{
  sourceExts: readonly string[]
  assetExts: readonly string[]
  assetResolutions: readonly string[]
  mainFields: readonly string[]
  conditionNames: readonly string[]
  conditionsByPlatform: Readonly<Record<string, readonly string[]>>
}>

// Metro's `resolver` config, as Metro names it; `defaults` where left out.
export interface MetroResolverOptions {
  host?: Host
  sourceExts?: readonly string[]
  assetExts?: Iterable<string>
  assetResolutions?: readonly string[]
  mainFields?: readonly string[]
  conditionNames?: readonly string[]
  conditionsByPlatform?: Readonly<Record<string, readonly string[]>>
  // Metro itself always prefers `.native`; Expo doesn't on web.
  preferNativePlatform?: boolean
  // Absolute paths.
  nodeModulesPaths?: readonly string[]
  extraNodeModules?: Readonly<Record<string, string>> | null
  disableHierarchicalLookup?: boolean
  // The metro-resolver module to resolve with instead of the built-in (the
  // project's own, for its Metro's exact rules), given the context Metro's
  // DependencyGraph builds over the host. Written for metro-resolver 0.81 on.
  metroResolver?: { resolve(context: object, specifier: string, platform: string | null): Resolution } | null
}

export interface ResolveOptions {
  platform?: string | null
  isESMImport?: boolean
}

// metro-resolver's Resolution, by real paths. Metro builds an asset into the
// module of its lowest path.
export type Resolution =
  | { type: 'sourceFile'; filePath: string }
  | { type: 'assetFiles'; filePaths: string[] }
  | { type: 'empty' }

// Null where Metro fails. Each package.json is read once per resolver.
export type MetroResolve = (originModulePath: string, specifier: string, options?: ResolveOptions) => Resolution | null

export function createMetroResolver(options?: MetroResolverOptions): MetroResolve
