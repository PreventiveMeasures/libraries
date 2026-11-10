import type { AliasFor } from './babel-aliases.js'
import type { MetroResolverOptions } from './metro-resolver.js'

// What of esbuild's onResolve arguments resolve() reads.
export interface ResolveArgs {
  path: string
  importer: string
  namespace: string
  resolveDir?: string
  kind: string
  pluginData?: unknown
}

export interface ResolveResult {
  path: string
  namespace?: 'metro-asset' | 'metro-empty'
}

// What of esbuild's onLoad arguments load() reads.
export interface LoadArgs {
  path: string
  namespace?: string
}

export type LoadResult =
  | { contents: string; loader: 'js' | 'jsx' | 'ts' | 'tsx' | 'json'; resolveDir?: string; pluginData?: unknown }
  | { errors: Array<{ text: string; location?: object | null }> }

export interface MetroLoaderOptions {
  // Absolute: where the project's Babel config, its @babel/core and its
  // packages are found. babel-plugin-module-resolver maps its aliases from
  // its own `cwd`, the process's where not given, as the plugin does.
  projectRoot: string
  platform: string
  // The esbuild module the build is made with (0.25 on).
  esbuild: { transform(code: string, options?: object): Promise<{ code: string; map: string }> }
  // __DEV__, and Babel's env: development, else BABEL_ENV or production, as
  // Metro's transformer names it. The Babel config and its plugins see
  // NODE_ENV and BABEL_ENV as rn-bundle's do: NODE_ENV the modules'
  // process.env.NODE_ENV (`define`'s), BABEL_ENV Babel's env, whatever the
  // process's.
  dev?: boolean
  // Each module's map to its source, inline, for the build to chain.
  sourcemap?: boolean
  // The profile the project's Babel config builds for, as
  // `react-native bundle --unstable-transform-profile` takes it.
  transformProfile?: 'default' | 'hermes-stable' | 'hermes-canary'
  // Metro's resolver options, as createMetroResolver() takes them, over the
  // disk: the project's metro.config.js isn't read.
  resolver?: Omit<MetroResolverOptions, 'dev' | 'host'>
  // babel-plugin-module-resolver's aliases (babel-aliases.js), applied where
  // the project has no Babel config: refused where it has one, which has
  // its own.
  aliases?: AliasFor | null
  // An asset's module source, for the asset at this path (the lowest of its
  // scales); Metro's where null, registering it with the asset registry of
  // the project's react-native.
  assetSource?: ((path: string) => string) | null
}

// Babel runs in worker threads until close(). Each file is loaded again only
// when its contents change; resolutions, as Babel's config, are kept while
// it lives, so a build that follows which files exist (a watcher's) makes a
// new one. It reads no rn.config.json: its allowedPaths, disallowedPaths,
// allowedModules and disallowedModules restrict the app's bundles (rn-bundle,
// rn-serve), not another tool's build, which takes files the app doesn't
// (tests, and what they import).
export interface MetroLoader {
  // __DEV__ and process.env.NODE_ENV, as Metro's prelude sets them.
  define: Record<string, string>
  // esbuild's `tsconfigRaw` for the build where the project's Babel config
  // runs (else undefined): Babel's output of a TS file loads as TS, and
  // esbuild is to keep each import and field Babel kept, as with
  // verbatimModuleSyntax and useDefineForClassFields. It is the build's, in
  // place of any tsconfig.json, for its other TS files too.
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true; useDefineForClassFields: true } } | undefined
  // esbuild's `supported` for a build for the engine the project's Babel
  // config builds for, so that esbuild adds no syntax the config lowers: let
  // and const where it lowers them, as for Hermes. esbuild then fails on any
  // let or const left in a file load() didn't make, which such a build
  // lowers itself; a build for another engine (Node) needn't take it.
  supported(): Promise<Record<string, boolean>>
  // onResolve: an import as Metro resolves it, for the platform, of a file
  // load() loaded (its pluginData passed on), an asset's module, or another
  // namespace's file (stdin) by resolveDir; an entry point as a path. A file
  // by a path esbuild takes as Metro does (a .mjs one renamed); an asset or
  // the empty module in a namespace whose onLoad is load()'s; undefined where
  // Metro resolves nothing, left to esbuild: to fail, but on a require in a
  // try block, or to find a file Metro doesn't (a redirect Metro fails on),
  // which load() refuses, as rn-bundle does.
  resolve(args: ResolveArgs): ResolveResult | undefined
  // onLoad: a file resolve() resolved, as Metro's transformer makes it (Flow
  // stripped, the project's Babel config run), esbuild lowering what it can
  // first; an error of any other, as rn-bundle has. A build loads its own
  // files its own way, or resolves them by resolve() (as entry points, or
  // from its stdin) for load() to load. Its pluginData, the imports and
  // aliases resolve() reads, are to be passed on with whatever contents the
  // build makes of it.
  load(args: LoadArgs): Promise<LoadResult>
  // The file a path resolve() gave names, for the build's messages and maps.
  realPath(path: string): string
  close(): Promise<void>
}

export function createMetroLoader(options: MetroLoaderOptions): MetroLoader
