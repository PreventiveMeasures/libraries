// What a React Native app's Metro takes where its config sets nothing:
// metro-config's defaults (0.87), with what @react-native/metro-config (0.88)
// puts over them -- the `react-native` main field first and the
// `react-native` condition. Frozen, so a caller's copy is the only one that
// changes.

export const sourceExts = Object.freeze(['js', 'jsx', 'json', 'ts', 'tsx'])

export const assetExts = Object.freeze([
  'bmp', 'gif', 'jpg', 'jpeg', 'png', 'psd', 'svg', 'webp', 'xml', // images
  'm4v', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', // video
  'aac', 'aiff', 'caf', 'm4a', 'mp3', 'wav', // audio
  'html', 'pdf', 'yaml', 'yml', // documents
  'otf', 'ttf', // fonts
  'zip', // archives
])

export const assetResolutions = Object.freeze(['1', '1.5', '2', '3', '4'])

export const mainFields = Object.freeze(['react-native', 'browser', 'main'])

export const conditionNames = Object.freeze(['react-native'])

export const conditionsByPlatform = Object.freeze({ web: Object.freeze(['browser']) })

export const defaults = Object.freeze({ sourceExts, assetExts, assetResolutions, mainFields, conditionNames, conditionsByPlatform })
