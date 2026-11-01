// The typed contract for metro-resolver.js, hand-written because the package
// is plain JavaScript. A change to an exported signature belongs in the same
// commit as the change here.

import type { Host } from './host.js'

export type { Host } from './host.js'

// What a React Native app's Metro takes where its config sets nothing:
// metro-config's defaults with @react-native/metro-config's over them.
export const defaults: Readonly<{
  sourceExts: readonly string[]
  assetExts: readonly string[]
  assetResolutions: readonly string[]
  mainFields: readonly string[]
  conditionNames: readonly string[]
  conditionsByPlatform: Readonly<Record<string, readonly string[]>>
}>

// Metro's `resolver` config, each as Metro names it, `defaults` where left
// out. Haste, `resolveRequest` and the like are code, and are not here.
export interface MetroResolverOptions {
  host?: Host
  sourceExts?: readonly string[]
  assetExts?: readonly string[] | ReadonlySet<string>
  assetResolutions?: readonly string[]
  // `resolverMainFields`: the package.json fields naming a package's main
  // module, and those holding "browser"-spec redirects.
  mainFields?: readonly string[]
  // `unstable_conditionNames` and `unstable_conditionsByPlatform`: what a
  // package's "exports" and "imports" are read with besides `default` and
  // `import` or `require`.
  conditionNames?: readonly string[]
  conditionsByPlatform?: Readonly<Record<string, readonly string[]>>
  // Whether `.native` files come after the platform's. Metro's own
  // resolver always says true; Expo says false for web.
  preferNativePlatform?: boolean
  // Absolute paths, looked in after the node_modules above the importer.
  nodeModulesPaths?: readonly string[]
  // A package name to the absolute path of the directory standing in for
  // it, where no node_modules holds it.
  extraNodeModules?: Readonly<Record<string, string>> | null
  disableHierarchicalLookup?: boolean
}

export interface ResolveOptions {
  // Null for none: no platform's files.
  platform?: string | null
  // Whether the import is an ESM `import` or `import()`, not a require().
  isESMImport?: boolean
}

// What a specifier resolves to, as metro-resolver's Resolution says it, by
// real paths. Metro builds an asset into the module of its lowest path.
export type Resolution =
  | { type: 'sourceFile'; filePath: string }
  | { type: 'assetFiles'; filePaths: string[] }
  | { type: 'empty' }

// Resolves `specifier` from the module at the absolute `originModulePath`,
// or null where Metro fails it. Each package.json is read once for the
// resolver's life: make another for a tree that has changed. A package.json
// that is there but is no JSON object throws, as Metro does.
export type MetroResolve = (originModulePath: string, specifier: string, options?: ResolveOptions) => Resolution | null

export function createMetroResolver(options?: MetroResolverOptions): MetroResolve

// DependencyGraph's resolveAsset, as a metro-resolver context takes it: the
// asset's files in `dirPath` at each of `assetResolutions`, by real paths, or
// null where none is.
export function resolveAsset(dirPath: string, assetName: string, extension: string, options?: { host?: Host; assetResolutions?: readonly string[] }): string[] | null
