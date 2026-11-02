import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createVfs } from '@preventive/vfs'

// A tree maps paths to files -- text, bytes, or an object written as JSON --
// and to { link }, a symlink to that target.
const isLink = (content) => content !== null && typeof content === 'object' && 'link' in content
const dataOf = (content) => (typeof content === 'string' || content instanceof Uint8Array ? content : JSON.stringify(content))

// -> { root, cleanup }, `root` a real path.
export function writeTree(tree) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-test-')))
  for (const [rel, content] of Object.entries(tree)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    if (isLink(content)) symlinkSync(content.link, path)
    else writeFileSync(path, dataOf(content))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// The tree as a Vfs holds it, from `/`.
export const vfsOf = (tree) => createVfs(Object.fromEntries(Object.entries(tree).map(([rel, content]) => [rel, isLink(content) ? { type: 'symlink', target: content.link } : dataOf(content)])))

// A tree's files under node_modules/<name>.
export const pkg = (name, files) => Object.fromEntries(Object.entries(files).map(([rel, content]) => [`node_modules/${name}/${rel}`, content]))

// A resolution as paths from `root`, an asset's joined by `,`.
export function shown(root, resolution) {
  if (resolution == null) return null
  const rel = (path) => relative(root, path).split(sep).join('/')
  if (resolution.type === 'empty') return '<empty>'
  if (resolution.type === 'sourceFile') return rel(resolution.filePath)
  if (resolution.type === 'assetFiles') return resolution.filePaths.map(rel).join(',')
  return `<${resolution.type}>`
}

// A PNG's first bytes, enough for its size.
export const png = (width, height) => {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

// A project's metro-config, and @react-native/metro-config, which makes its
// defaults as React Native's does (a few of them), over Metro's.
export const METRO_CONFIG = {
  'node_modules/metro-config': { link: realpathSync(fileURLToPath(new URL('../node_modules/metro-config', import.meta.url))) },
  'node_modules/@react-native/metro-config/package.json': { name: '@react-native/metro-config', main: 'index.js' },
  'node_modules/@react-native/metro-config/polyfill.js': '',
  'node_modules/@react-native/metro-config/index.js': [
    "const { getDefaultConfig, mergeConfig } = require('metro-config')",
    'exports.getDefaultConfig = (projectRoot) => mergeConfig(getDefaultConfig.getDefaultValues(projectRoot), {',
    "  resolver: { resolverMainFields: ['react-native', 'browser', 'main'], unstable_conditionNames: ['react-native'] },",
    "  serializer: { getPolyfills: () => [require.resolve('./polyfill.js')], getModulesRunBeforeMainModule: () => [] },",
    "  transformer: { assetRegistryPath: 'react-native/Libraries/Image/AssetRegistry', getTransformOptions: async () => ({ transform: { experimentalImportSupport: false, inlineRequires: true } }) },",
    '})',
    'exports.mergeConfig = mergeConfig',
    '',
  ].join('\n'),
}
