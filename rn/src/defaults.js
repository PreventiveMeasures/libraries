// React Native's Metro config defaults (metro-config 0.87 under
// @react-native/metro-config 0.88), and the disk as the default host.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'

const freeze = Object.freeze

export const defaults = freeze({
  sourceExts: freeze(['js', 'jsx', 'json', 'ts', 'tsx']),
  assetExts: freeze([
    'bmp', 'gif', 'jpg', 'jpeg', 'png', 'psd', 'svg', 'webp', 'xml',
    'm4v', 'mov', 'mp4', 'mpeg', 'mpg', 'webm',
    'aac', 'aiff', 'caf', 'm4a', 'mp3', 'wav',
    'html', 'pdf', 'yaml', 'yml',
    'otf', 'ttf',
    'zip',
  ]),
  assetResolutions: freeze(['1', '1.5', '2', '3', '4']),
  mainFields: freeze(['react-native', 'browser', 'main']),
  conditionNames: freeze(['react-native']),
  conditionsByPlatform: freeze({ web: freeze(['browser']) }),
})

const stat = (path) => {
  try {
    return statSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined // ENOTDIR, ELOOP, EACCES
  }
}

export const diskHost = freeze({
  isFile: (path) => stat(path)?.isFile() ?? false,
  isDirectory: (path) => stat(path)?.isDirectory() ?? false,
  realpath: realpathSync,
  readFile: readFileSync,
  readdir: readdirSync,
})
