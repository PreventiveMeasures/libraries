// An asset as Metro builds it into a bundle: its name, its files at each
// scale, its size, its data and the module registering it. Typed and
// described in metro-assets.d.ts.
export { isAssetFile, parseAssetPath } from './src/metro/asset-paths.js'
export { imageDimensions, isAssetTypeAnImage } from './src/metro/image-size.js'
export { assetData, assetModule, assetRecord } from './src/metro/assets.js'
