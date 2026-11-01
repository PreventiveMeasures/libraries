// What a React Native app's Metro takes where its config sets nothing:
// metro-config's defaults (0.87), with what @react-native/metro-config (0.88)
// puts over them -- the `react-native` main field first and the
// `react-native` condition. Frozen, so a caller's copy is the only one that
// changes.

const frozen = Object.freeze

export const defaults = Object.freeze({
  sourceExts: frozen(['js', 'jsx', 'json', 'ts', 'tsx']),
  assetExts: frozen([
    'bmp', 'gif', 'jpg', 'jpeg', 'png', 'psd', 'svg', 'webp', 'xml', // images
    'm4v', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', // video
    'aac', 'aiff', 'caf', 'm4a', 'mp3', 'wav', // audio
    'html', 'pdf', 'yaml', 'yml', // documents
    'otf', 'ttf', // fonts
    'zip', // archives
  ]),
  assetResolutions: frozen(['1', '1.5', '2', '3', '4']),
  mainFields: frozen(['react-native', 'browser', 'main']),
  conditionNames: frozen(['react-native']),
  conditionsByPlatform: Object.freeze({ web: frozen(['browser']) }),
})
