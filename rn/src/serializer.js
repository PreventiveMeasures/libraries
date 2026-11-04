// What Metro's serializer puts around a React Native app's modules, as @react-native/metro-config sets it
// up: the prelude, the polyfills, the modules run before the entry, then the entry.
// Ported from Metro 0.87's getPreludeCode and getAppendScripts (MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { jsval } from './jsval.js'

// Newest first: react-native 0.87's, then those of before.
const SETUP = ['react-native/setup-env', 'react-native/Libraries/Core/InitializeCore']
const ASSET_REGISTRY = ['react-native/asset-registry', 'react-native/Libraries/Image/AssetRegistry']
// The global object, as Metro passes it to a polyfill.
export const GLOBAL = "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this"

// Metro's getPreludeCode, with only the globals metro-runtime's require reads. `dev` is __DEV__'s value.
export const prelude = (dev, nodeEnv) => `var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=${dev},process=globalThis.process||{},__METRO_GLOBAL_PREFIX__='';process.env=process.env||{};process.env.NODE_ENV=process.env.NODE_ENV||${jsval(nodeEnv)};`

// The module to run before the entry and the asset registry of the react-native the entry resolves, the first
// of each that resolves. Without react-native, none to run and the old registry, for an error to name.
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
