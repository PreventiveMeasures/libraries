// What Metro's serializer puts around a React Native app's modules, as
// @react-native/metro-config configures Metro (Metro 0.87's getPreludeCode
// and getAppendScripts; MIT, Copyright (c) Meta Platforms, Inc. and
// affiliates): the prelude first, then the polyfills, then the modules run
// before the entry, then the entry. Which modules run before it, and which
// one assets register with, the project's react-native says: from 0.87,
// react-native/setup-env and react-native/asset-registry; before,
// InitializeCore and Libraries/Image/AssetRegistry.

// Of each, the newest first.
const SETUP = ['react-native/setup-env', 'react-native/Libraries/Core/InitializeCore']
const ASSET_REGISTRY = ['react-native/asset-registry', 'react-native/Libraries/Image/AssetRegistry']

// Metro's getPreludeCode, but for the globals only metro-runtime's require
// reads. `dev`: the value of __DEV__.
export const prelude = (dev, nodeEnv) => `var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=${dev},process=globalThis.process||{},__METRO_GLOBAL_PREFIX__='';process.env=process.env||{};process.env.NODE_ENV=process.env.NODE_ENV||${JSON.stringify(nodeEnv)};`

// -> { runBeforeMain, assetRegistryPath } of the react-native the entry
// resolves, as its @react-native/metro-config has them: of each, the first
// that resolves from the entry. With no react-native, no module to run
// before the entry, and the registry of before 0.87, for an error to name.
export function reactNativeOf(resolveModule, host, entryPath, platform) {
  let entry
  try {
    entry = host.realpath(entryPath)
  } catch {
    // Left to esbuild to report.
    return { runBeforeMain: [], assetRegistryPath: ASSET_REGISTRY[1] }
  }
  const first = (specifiers) => specifiers.find((specifier) => resolveModule(entry, specifier, { platform, isESMImport: true })?.type === 'sourceFile')
  const setup = first(SETUP)
  return { runBeforeMain: setup === undefined ? [] : [setup], assetRegistryPath: first(ASSET_REGISTRY) ?? ASSET_REGISTRY[1] }
}
